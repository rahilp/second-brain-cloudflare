/**
 * `POST /team/me/default-share` — a member setting their OWN capture default.
 *
 * The admin twin, `POST /team/members/default-share`, takes `{ id, default }`
 * and is `requireAdmin`. Letting a member through THAT route would have meant
 * relaxing its gate and adding `id === auth.userId` for non-admins — one
 * forgotten branch away from a member setting a colleague's capture policy.
 *
 * This route's body has no `id` field at all. That is the security property
 * these cases pin: the subject is `auth.userId`, which came from the resolved
 * identity, so there is no target to name and no branch to get wrong. The
 * middle case below is the one the route exists for — an `id` in the body is
 * IGNORED, not honoured — and the last one asserts the admin route did not get
 * looser while this one was added.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const OWNER = "test-token"; // the bootstrap admin, per makeTestEnv's AUTH_TOKEN

let sqlite: SqliteD1;
let env: Env;
let pending: Promise<unknown>[] = [];
let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;
let bob: { userId: string; token: string };
let alice: { userId: string; token: string };

const ctx = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
} as unknown as ExecutionContext;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

/** Same, but the body goes through unserialised — for the malformed-JSON case. */
function rawCall(method: string, path: string, token: string, body: string): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    }),
    env,
    ctx,
  );
}

const jsonOf = (res: Response) => res.json() as Promise<any>;

/** The org-level policy "inherit" falls back to. */
function setOrgDefault(value: string) {
  return env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_DEFAULT_WORKSPACE: value }));
}

/** Every waitUntil promise the request handed back, settled. */
async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

function events() {
  return sqlite.db
    .prepare(`SELECT actor_id, target_user_id, event, payload FROM admin_events ORDER BY created_at`)
    .all()
    .then((r) => r.results as { actor_id: string; target_user_id: string; event: string; payload: string }[]);
}

/** The stored override, read straight out of the column the route writes. */
function storedShare(userId: string) {
  return sqlite.db
    .prepare(`SELECT default_share FROM users WHERE id = ?`)
    .bind(userId)
    .first()
    .then((r) => (r as { default_share: string } | null)?.default_share);
}

beforeEach(async () => {
  pending = [];
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const madeBob = await createMember(env, { name: "Bob", email: "bob@example.com" });
  bob = { userId: madeBob.member.userId, token: madeBob.token };
  const madeAlice = await createMember(env, { name: "Alice", email: "alice@example.com" });
  alice = { userId: madeAlice.member.userId, token: madeAlice.token };
});

afterEach(() => sqlite?.close());

describe("POST /team/me/default-share sets the caller's own capture default", () => {
  it("a member sets their own override and GET /team/me agrees", async () => {
    const res = await call("POST", "/team/me/default-share", bob.token, { default: "company" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.default).toBe("company");
    expect(body.defaultShare).toBe("company");
    expect(body.effectiveDefault).toBe("company");

    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    expect(profile.defaultShare).toBe("company");
    expect(profile.effectiveDefault).toBe("company");
  });

  it("'inherit' clears the override and the response reports the org's answer", async () => {
    await setOrgDefault("company");
    await call("POST", "/team/me/default-share", bob.token, { default: "personal" });

    const body = await jsonOf(await call("POST", "/team/me/default-share", bob.token, { default: "inherit" }));
    expect(body.default).toBe("inherit");
    expect(body.defaultShare).toBe("");
    expect(body.orgDefault).toBe("company");
    // The precedence answer comes from the server, not from a client that
    // re-derives it: with the override cleared, the effective default IS the
    // org default.
    expect(body.effectiveDefault).toBe("company");
    expect(await storedShare(bob.userId)).toBe("");
  });

  it("an id in the body is ignored, not honoured — the caller is the only subject", async () => {
    // The case this route exists for. Bob names Alice; the write lands on Bob.
    await call("POST", "/team/me/default-share", alice.token, { default: "personal" });

    const res = await call("POST", "/team/me/default-share", bob.token, {
      id: alice.userId,
      default: "company",
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.defaultShare).toBe("company");

    // Bob's own row moved…
    expect(await storedShare(bob.userId)).toBe("company");
    // …and Alice's did not.
    expect(await storedShare(alice.userId)).toBe("personal");
    const aliceProfile = await jsonOf(await call("GET", "/team/me", alice.token));
    expect(aliceProfile.profile.defaultShare).toBe("personal");
  });

  it("an admin posting here changes only their own row", async () => {
    await call("POST", "/team/me/default-share", bob.token, { default: "personal" });
    await call("POST", "/team/me/default-share", OWNER, { default: "company" });

    expect(await storedShare(roots.ownerUserId)).toBe("company");
    const { members } = await jsonOf(await call("GET", "/team/members", OWNER));
    const others = (members as any[]).filter((m) => m.userId !== roots.ownerUserId);
    expect(others.map((m) => [m.name, m.defaultShare]).sort()).toEqual([
      ["Alice", ""],
      ["Bob", "personal"],
    ]);
  });

  it("rejects a value outside the enum, with the exact message", async () => {
    const res = await call("POST", "/team/me/default-share", bob.token, { default: "nonsense" });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({
      ok: false,
      error: 'default must be "personal", "company", or "inherit"',
    });
    expect(await storedShare(bob.userId)).toBe("");
  });

  it("rejects malformed JSON", async () => {
    const res = await rawCall("POST", "/team/me/default-share", bob.token, "{not json");
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ ok: false, error: "Invalid JSON" });
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await call("POST", "/team/me/default-share", null, { default: "company" });
    expect(res.status).toBe(401);
    expect(await storedShare(bob.userId)).toBe("");
  });

  it("writes one admin_events row whose actor and target are both the caller", async () => {
    const res = await call("POST", "/team/me/default-share", bob.token, { default: "company" });
    expect(res.status).toBe(200);
    await settle();

    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("member_default_share_set");
    expect(rows[0].actor_id).toBe(bob.userId);
    expect(rows[0].target_user_id).toBe(bob.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({ default: "company", self: true });
  });

  it("leaves the admin route exactly as admin-only as it was", async () => {
    // The new route must not have loosened the old one: a member naming a
    // target still gets 403, and Alice's row is untouched.
    const res = await call("POST", "/team/members/default-share", bob.token, {
      id: alice.userId,
      default: "company",
    });
    expect(res.status).toBe(403);
    expect(await storedShare(alice.userId)).toBe("");
  });
});
