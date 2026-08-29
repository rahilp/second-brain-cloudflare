/**
 * `GET /team/roster` — the member-facing people list.
 *
 * The Team screen's only data source used to be `GET /team/members`, which is
 * admin-gated and whose rows carry `email`, `createdAt`, `lastUsedAt`,
 * `suspended`, `defaultShare`, `personalWorkspaceId` and a count of the
 * member's PRIVATE entries. A member needs names and roles to know who they are
 * sharing with; a member must not get that row.
 *
 * So the subject of this file is the field allowlist, asserted negatively and
 * exhaustively — `Object.keys(row)` is exactly the three fields — because the
 * failure mode being defended against is a later `SELECT u.*`, and a positive
 * assertion that the three fields are present passes right through it.
 *
 * The other half is constraint 1 applied to people: the roster is derived from
 * the caller's own `companyWorkspaceIds` through `memberships`, never a bare
 * `FROM users`, so on a two-team deployment one team's roster cannot reach the
 * other.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
/** The bootstrap owner's token — an admin, named "Owner". */
const ADMIN = "test-token";
/** A second company workspace, created after the bootstrap's. */
const TEAM_B = "ws-team-b";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let bob: { userId: string; token: string };
let carol: { userId: string; token: string };

function call(method: string, path: string, token?: string): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: token
        ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
        : { "Content-Type": "application/json" },
    }),
    env,
    ctx,
  );
}

const jsonOf = (res: Response) => res.json() as Promise<any>;

function join(userId: string, workspaceId: string) {
  return sqlite.db
    .prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
    .bind(userId, workspaceId, Date.now())
    .run();
}

function leave(userId: string, workspaceId: string) {
  return sqlite.db
    .prepare(`DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?`)
    .bind(userId, workspaceId)
    .run();
}

beforeEach(async () => {
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
  const madeCarol = await createMember(env, { name: "Carol", email: "carol@example.com" });
  carol = { userId: madeCarol.member.userId, token: madeCarol.token };

  await sqlite.db
    .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`)
    .bind(TEAM_B, Date.now() + 1000)
    .run();
});

afterEach(() => sqlite?.close());

describe("GET /team/roster", () => {
  it("gives a member the names and roles of their team", async () => {
    const res = await call("GET", "/team/roster", bob.token);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    // Every active member of Bob's team, ordered by name.
    expect(body.members).toEqual([
      { userId: bob.userId, name: "Bob", role: "member" },
      { userId: carol.userId, name: "Carol", role: "member" },
      { userId: roots.ownerUserId, name: "Owner", role: "admin" },
    ]);
    // The client needs a stable key to mark "you" — that is what userId is for.
    expect(body.you).toBe(bob.userId);
    expect(body.admin).toBe(false);
    // Same shape GET /team/workspaces already returns, so the screen needs one call.
    expect(body.teams).toEqual([
      { id: roots.companyWorkspaceId, name: "Company", memberCount: 3 },
    ]);
  });

  it("returns exactly userId, name and role and nothing else", async () => {
    const body = await jsonOf(await call("GET", "/team/roster", bob.token));
    expect(body.members.length).toBeGreaterThan(0);
    for (const row of body.members) {
      // Exhaustive and negative on purpose: this is the assertion a future
      // `SELECT u.*` has to walk past, and asserting the three are PRESENT
      // would not stop it.
      expect(Object.keys(row).sort()).toEqual(["name", "role", "userId"]);
    }
    // Named individually as well, so the failure message says which field leaked.
    const leaked = ["email", "privateEntries", "personalWorkspaceId", "defaultShare", "createdAt", "suspended", "lastUsedAt"];
    for (const row of body.members) {
      for (const field of leaked) expect(row).not.toHaveProperty(field);
    }
  });

  it("omits a suspended member, and never publishes suspension state", async () => {
    await sqlite.db.prepare(`UPDATE users SET suspended = 1 WHERE id = ?`).bind(carol.userId).run();
    const body = await jsonOf(await call("GET", "/team/roster", bob.token));
    expect(body.members.map((m: any) => m.name)).toEqual(["Bob", "Owner"]);
    expect(JSON.stringify(body.members)).not.toContain("suspended");
  });

  it("omits a removed member", async () => {
    // removed_at set directly, with the membership row left in place: it is the
    // removed_at predicate under test, not the membership delete that normally
    // accompanies it.
    await sqlite.db.prepare(`UPDATE users SET removed_at = ? WHERE id = ?`).bind(Date.now(), carol.userId).run();
    const body = await jsonOf(await call("GET", "/team/roster", bob.token));
    expect(body.members.map((m: any) => m.name)).toEqual(["Bob", "Owner"]);
  });

  it("never reaches another company workspace's people", async () => {
    // Carol moves to the second team; nobody is in both.
    await leave(carol.userId, roots.companyWorkspaceId);
    await join(carol.userId, TEAM_B);

    const bobs = await jsonOf(await call("GET", "/team/roster", bob.token));
    expect(bobs.members.map((m: any) => m.name)).toEqual(["Bob", "Owner"]);
    expect(bobs.members.map((m: any) => m.userId)).not.toContain(carol.userId);
    expect(bobs.teams.map((t: any) => t.id)).toEqual([roots.companyWorkspaceId]);

    // And the other direction: Carol's roster is her team alone.
    const carols = await jsonOf(await call("GET", "/team/roster", carol.token));
    expect(carols.members).toEqual([{ userId: carol.userId, name: "Carol", role: "member" }]);
    expect(carols.teams.map((t: any) => t.id)).toEqual([TEAM_B]);
  });

  it("lists each member once when they belong to two of the caller's teams", async () => {
    await join(bob.userId, TEAM_B);
    await join(carol.userId, TEAM_B);
    const body = await jsonOf(await call("GET", "/team/roster", bob.token));
    expect(body.members.map((m: any) => m.name)).toEqual(["Bob", "Carol", "Owner"]);
  });

  it("gives an admin exactly what it gives a member", async () => {
    // requireAdmin gates a SURFACE; it has never widened which rows a caller may
    // read. /team/roster is the member-facing surface and widens nothing.
    const asMember = await jsonOf(await call("GET", "/team/roster", bob.token));
    const asAdmin = await jsonOf(await call("GET", "/team/roster", ADMIN));
    expect(asAdmin.members).toEqual(asMember.members);
    expect(asAdmin.you).toBe(roots.ownerUserId);
    expect(asAdmin.admin).toBe(true);
  });

  it("answers a member of no team with an empty roster rather than everyone", async () => {
    await leave(bob.userId, roots.companyWorkspaceId);
    const body = await jsonOf(await call("GET", "/team/roster", bob.token));
    expect(body.members).toEqual([]);
    expect(body.teams).toEqual([]);
  });

  it("401s without a token", async () => {
    const res = await call("GET", "/team/roster");
    expect(res.status).toBe(401);
  });
});

describe("GET /team/members is unchanged by the split", () => {
  it("still gives an admin the private-entry counts", async () => {
    const body = await jsonOf(await call("GET", "/team/members", ADMIN));
    const row = body.members.find((m: any) => m.userId === bob.userId);
    expect(row.privateEntries).toBe(0);
    expect(row.email).toBe("bob@example.com");
    expect(row).toHaveProperty("personalWorkspaceId");
    expect(row).toHaveProperty("defaultShare");
    expect(row).toHaveProperty("lastUsedAt");
  });

  it("still 403s a member", async () => {
    expect((await call("GET", "/team/members", bob.token)).status).toBe(403);
  });
});
