/**
 * The administration audit trail, end to end through the Worker.
 *
 * `src/lib/admin-audit.ts` owns the write and `test/unit/admin-audit.test.ts`
 * owns its contract (INSERT-only, fire-and-forget, never fatal). What neither
 * covers is the part an auditor actually depends on: that every mutating
 * `/team/*` route reaches it, with the right event name, the right target, and a
 * payload that carries no secret. A writer that is never called is the same as
 * no audit trail at all, so these drive real requests and read the rows back out
 * of real SQLite.
 *
 * The `ctx` double here is not the no-op one the rest of the integration suite
 * uses: `adminAuditEvent` hands its INSERT to `ctx.waitUntil`, so a double that
 * drops the promise would let every assertion below pass against a database that
 * never received the row. This one collects and the tests await.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const ALICE = "test-token"; // the owner/admin, per makeTestEnv's AUTH_TOKEN

let sqlite: SqliteD1;
let env: Env;
let pending: Promise<unknown>[] = [];
let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;
let bob: Awaited<ReturnType<typeof createMember>>;

const ctx = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
} as unknown as ExecutionContext;

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const jsonOf = async (res: Response) => res.json() as Promise<any>;

/** Every waitUntil promise the request handed back, settled. */
async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

interface AdminEventRow {
  actor_id: string;
  target_user_id: string;
  workspace_id: string;
  event: string;
  payload: string;
  created_at: number;
}

async function events(): Promise<AdminEventRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT actor_id, target_user_id, workspace_id, event, payload, created_at
     FROM admin_events ORDER BY created_at ASC, rowid ASC`,
  ).all<AdminEventRow>();
  return results ?? [];
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  bob = await createMember(env, { name: "Bob" });
  await settle();
  // The bootstrap and the direct createMember above are not routes; clear
  // anything they queued so each test reads only its own request's rows.
  await env.DB.prepare(`DELETE FROM admin_events`).run();
});

afterEach(() => sqlite?.close());

describe("admin_events — every mutating /team route writes one row", () => {
  it("POST /team/members records member_created against the new member", async () => {
    const res = await call("POST", "/team/members", ALICE, {
      name: "Carol", email: "carol@example.com", role: "admin",
    });
    expect(res.status).toBe(201);
    const created = await jsonOf(res);
    await settle();

    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("member_created");
    expect(rows[0].actor_id).toBe(roots.ownerUserId);
    expect(rows[0].target_user_id).toBe(created.member.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({ role: "admin", hasEmail: true });
  });

  it("POST /team/members records hasEmail false when no email was supplied", async () => {
    await call("POST", "/team/members", ALICE, { name: "Dan" });
    await settle();
    const rows = await events();
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].payload)).toEqual({ role: "member", hasEmail: false });
  });

  it("POST /team/members/token records member_token_rotated with an empty payload", async () => {
    const res = await call("POST", "/team/members/token", ALICE, { id: bob.member.userId });
    expect(res.status).toBe(200);
    await settle();

    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("member_token_rotated");
    expect(rows[0].actor_id).toBe(roots.ownerUserId);
    expect(rows[0].target_user_id).toBe(bob.member.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({});
  });

  it("POST /team/members/default-share records the value that was set", async () => {
    const res = await call("POST", "/team/members/default-share", ALICE, {
      id: bob.member.userId, default: "company",
    });
    expect(res.status).toBe(200);
    await settle();

    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("member_default_share_set");
    expect(rows[0].target_user_id).toBe(bob.member.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({ default: "company" });
  });

  it("POST /team/members/remove records what the removal actually destroyed", async () => {
    sqlite.db
      .prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
         VALUES (?, 'Bob private note', '[]', 'test', ?, '["v1","v2"]', ?, ?)`,
      )
      .bind("e-bob", Date.now(), bob.member.personalWorkspaceId, bob.member.userId)
      .run();

    const res = await call("POST", "/team/members/remove", ALICE, { id: bob.member.userId });
    expect(res.status).toBe(200);
    await settle();

    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("member_removed");
    expect(rows[0].target_user_id).toBe(bob.member.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({ removedEntries: 1, removedVectors: 2 });
  });

  it("POST /team/workspaces/rename records team_renamed against the team, not a user", async () => {
    const res = await call("POST", "/team/workspaces/rename", ALICE, { name: "Acme Research" });
    expect(res.status).toBe(200);
    await settle();

    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("team_renamed");
    expect(rows[0].actor_id).toBe(roots.ownerUserId);
    // A team rename has no target user; the subject is the workspace.
    expect(rows[0].target_user_id).toBe("");
    expect(rows[0].workspace_id).toBe(roots.companyWorkspaceId);
    expect(JSON.parse(rows[0].payload)).toEqual({ name: "Acme Research" });
  });

  it("POST /team/profile distinguishes an admin editing a member from a member editing themselves", async () => {
    expect((await call("POST", "/team/profile", ALICE, { id: bob.member.userId, name: "Bob R" })).status).toBe(200);
    await settle();
    let rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("member_profile_updated");
    expect(rows[0].actor_id).toBe(roots.ownerUserId);
    expect(rows[0].target_user_id).toBe(bob.member.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({ self: false });

    await env.DB.prepare(`DELETE FROM admin_events`).run();
    expect((await call("POST", "/team/profile", bob.token, { name: "Bobby" })).status).toBe(200);
    await settle();
    rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id).toBe(bob.member.userId);
    expect(rows[0].target_user_id).toBe(bob.member.userId);
    expect(JSON.parse(rows[0].payload)).toEqual({ self: true });
  });

  it("suspend then un-suspend leaves two rows, in that order", async () => {
    expect((await call("POST", "/team/members/suspend", ALICE, { id: bob.member.userId, suspended: true })).status).toBe(200);
    await settle();
    expect((await call("POST", "/team/members/suspend", ALICE, { id: bob.member.userId, suspended: false })).status).toBe(200);
    await settle();

    const rows = await events();
    expect(rows.map(r => r.event)).toEqual(["member_suspended", "member_unsuspended"]);
    expect(rows.map(r => r.target_user_id)).toEqual([bob.member.userId, bob.member.userId]);
    expect(rows.map(r => JSON.parse(r.payload))).toEqual([{}, {}]);
    expect(rows[0].created_at).toBeLessThanOrEqual(rows[1].created_at);
  });

  it("a rejected administration call writes nothing at all", async () => {
    // Alice is the only admin, so removing her is refused by removeMember's own
    // guardrail. An audit row here would claim an offboarding that never
    // happened — worse than no row, because it is a false record.
    const res = await call("POST", "/team/members/remove", ALICE, { id: roots.ownerUserId });
    expect(res.status).toBe(400);
    await settle();
    expect(await events()).toEqual([]);

    // The same for a target that does not exist at all.
    expect((await call("POST", "/team/members/token", ALICE, { id: "usr-nobody" })).status).toBe(404);
    await settle();
    expect(await events()).toEqual([]);
  });

  it("no payload ever carries the token the route handed back", async () => {
    // Creation and rotation are the only two routes that return a bearer token.
    // The audit trail is read by more people than the token is; if it ever
    // carried one, reading the log would be enough to sign in as the member.
    const createdToken = (await jsonOf(await call("POST", "/team/members", ALICE, { name: "Erin" }))).token;
    const rotatedToken = (await jsonOf(await call("POST", "/team/members/token", ALICE, { id: bob.member.userId }))).token;
    await settle();

    expect(typeof createdToken).toBe("string");
    expect(createdToken.length).toBeGreaterThan(20);
    expect(typeof rotatedToken).toBe("string");

    const dump = JSON.stringify(await events());
    expect(dump).not.toContain(createdToken);
    expect(dump).not.toContain(rotatedToken);
  });
});
