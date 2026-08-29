/**
 * `GET /team/me` — the caller's own profile, plus the three values that say
 * where their next capture lands.
 *
 * The composer's "Default" option resolves through
 * `effectiveWriteTarget(identity, explicit, orgDefault)` — request, then the
 * member's own `users.default_share`, then the org's TEAM_DEFAULT_WORKSPACE,
 * then personal. Until now the client could see none of that, so it could not
 * say what "Default" meant.
 *
 * `effectiveDefault` is computed on the SERVER for a specific reason, and it is
 * the reason the last case in this file exists: a client that re-derives the
 * precedence order drifts from it silently. The hint would read "Personal"
 * while the capture landed in the company layer, and nothing would look wrong.
 * So the final test does not compare `effectiveDefault` against a second copy
 * of the rule — it captures a memory with no explicit target and checks the row
 * actually landed in the workspace `effectiveDefault` named.
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

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<any>) => { pending.push(p); } } as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let bob: { userId: string; personalWorkspaceId: string; token: string };

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const jsonOf = (res: Response) => res.json() as Promise<any>;

/** The org-level policy an admin sets through PATCH /config. */
function setOrgDefault(value: string) {
  return env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_DEFAULT_WORKSPACE: value }));
}

/** The per-member override; "" is "inherit the org default". */
function setMemberShare(userId: string, value: string) {
  return sqlite.db.prepare(`UPDATE users SET default_share = ? WHERE id = ?`).bind(value, userId).run();
}

/** The four fields that existed before this change, asserted in every case. */
function expectProfileIdentity(profile: any) {
  expect(profile.userId).toBe(bob.userId);
  expect(profile.name).toBe("Bob");
  expect(profile.email).toBe("bob@example.com");
  expect(profile.role).toBe("member");
}

beforeEach(async () => {
  pending.length = 0;
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const made = await createMember(env, { name: "Bob", email: "bob@example.com" });
  bob = {
    userId: made.member.userId,
    personalWorkspaceId: made.member.personalWorkspaceId,
    token: made.token,
  };
});

afterEach(() => sqlite?.close());

describe("GET /team/me reports where the next capture lands", () => {
  it("member override 'company' beats an org default of 'personal'", async () => {
    await setMemberShare(bob.userId, "company");
    await setOrgDefault("personal");
    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    expect(profile.defaultShare).toBe("company");
    expect(profile.orgDefault).toBe("personal");
    expect(profile.effectiveDefault).toBe("company");
    expectProfileIdentity(profile);
  });

  it("inherits the org default when the member has no override", async () => {
    await setMemberShare(bob.userId, "");
    await setOrgDefault("company");
    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    expect(profile.defaultShare).toBe("");
    expect(profile.orgDefault).toBe("company");
    expect(profile.effectiveDefault).toBe("company");
    expectProfileIdentity(profile);
  });

  it("falls back to personal when neither the member nor the org has said", async () => {
    await setMemberShare(bob.userId, "");
    // No config blob at all — the shipped default, and every solo brain.
    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    expect(profile.defaultShare).toBe("");
    expect(profile.orgDefault).toBe("personal");
    expect(profile.effectiveDefault).toBe("personal");
    expectProfileIdentity(profile);
  });

  it("member override 'personal' beats an org default of 'company'", async () => {
    // The case a client-side reimplementation of the precedence order gets
    // wrong: the org says company, and the member still writes privately.
    await setMemberShare(bob.userId, "personal");
    await setOrgDefault("company");
    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    expect(profile.defaultShare).toBe("personal");
    expect(profile.orgDefault).toBe("company");
    expect(profile.effectiveDefault).toBe("personal");
    expectProfileIdentity(profile);
  });

  it("reads 'personal' for an org default that is neither enum value", async () => {
    // TEAM_DEFAULT_WORKSPACE is a free-text config key, so a hand-edited blob
    // can hold anything. Anything but "company" is private-by-default.
    await setMemberShare(bob.userId, "");
    await setOrgDefault("shared");
    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    expect(profile.orgDefault).toBe("personal");
    expect(profile.effectiveDefault).toBe("personal");
  });

  it("names the workspace the next capture actually lands in", async () => {
    // The whole reason effectiveDefault is computed server-side. Run against
    // both org defaults, because the drift this guards against only shows on
    // one of them.
    for (const [orgDefault, expected] of [
      ["personal", bob.personalWorkspaceId],
      ["company", roots.companyWorkspaceId],
    ] as const) {
      await setOrgDefault(orgDefault);
      const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));

      const captured = await jsonOf(
        await call("POST", "/capture", bob.token, { content: `Where does ${orgDefault} land?`, source: "test" }),
      );
      await Promise.allSettled(pending.splice(0));
      const row = await env.DB
        .prepare(`SELECT workspace_id FROM entries WHERE id = ?`)
        .bind(captured.id)
        .first<{ workspace_id: string }>();

      expect([orgDefault, row?.workspace_id]).toEqual([orgDefault, expected]);
      // The hint the client would show, against where the row really went.
      expect([orgDefault, profile.effectiveDefault]).toEqual([orgDefault, orgDefault]);
    }
  });

  it("still returns the four original fields and nothing renamed", async () => {
    const { profile } = await jsonOf(await call("GET", "/team/me", bob.token));
    // loadProfileName() in public/js/settings.js reads profile.name and must
    // keep working untouched; the three new keys are additive.
    expect(Object.keys(profile).sort()).toEqual(
      ["defaultShare", "effectiveDefault", "email", "name", "orgDefault", "role", "userId"],
    );
  });

  it("tells a removed member their account is gone, and no profile at all", async () => {
    await sqlite.db.prepare(`UPDATE users SET removed_at = ? WHERE id = ?`).bind(Date.now(), bob.userId).run();
    // 401, not the route's own 404: IDENTITY_SQL already excludes removed users,
    // so a removed member's token stops resolving before the profile read is
    // reached. The route's `if (!row) 404` is unreachable through a bearer
    // token and stays as a defensive branch. Pinned here because it is the
    // answer the dashboard acts on, and the three new fields must not turn a
    // removed member's request into a 200 with defaults on it.
    const res = await call("GET", "/team/me", bob.token);
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body).toEqual({
      ok: false,
      error: "Your account has been removed from this team.",
      code: "removed",
    });
    expect(body.profile).toBeUndefined();
  });
});
