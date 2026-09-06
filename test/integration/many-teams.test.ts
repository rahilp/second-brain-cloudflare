/**
 * Many teams, and many teams per member.
 *
 * `memberships` has always been a many-to-many join and `workspaces.kind` never
 * said there could be only one company — but the identity query joined company
 * memberships one-to-one and took `.first()`, so a second team was not an
 * unsupported feature, it was a silent wrong answer: a member of two teams got
 * scoped to whichever row the database happened to return.
 *
 * The dashboard still exposes a single team. These cases are what let that
 * change later without the tenancy underneath it having to: every read unions
 * the caller's teams, the author lock recognises all of them, and a write
 * targets one deliberately.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import {
  readableWorkspaces,
  scopeWorkspaces,
  scopeWrite,
  primaryCompanyWorkspaceId,
  isCompanyWorkspace,
  layerOf,
} from "../../src/lib/scope";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let dana: { userId: string; personalWorkspaceId: string; token: string };
/** A second company workspace, created 1000ms after the bootstrap's. */
const TEAM_B = "ws-team-b";

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

function seed(id: string, workspaceId: string, actorId: string, content: string, tags: string[] = []) {
  const now = Date.now() - 3600_000;
  return sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, ?, 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, JSON.stringify(tags), now, now, workspaceId, actorId)
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
  const created = await createMember(env, { name: "Dana" });
  dana = {
    userId: created.member.userId,
    personalWorkspaceId: created.member.personalWorkspaceId,
    token: created.token,
  };

  // A second team. Created later than the bootstrap's, so "oldest first" has
  // something to order.
  await sqlite.db
    .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`)
    .bind(TEAM_B, Date.now() + 1000)
    .run();
});

afterEach(() => sqlite?.close());

/** Put a user in a workspace. */
function join(userId: string, workspaceId: string) {
  return sqlite.db
    .prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
    .bind(userId, workspaceId, Date.now())
    .run();
}

describe("a member of two teams", () => {
  beforeEach(async () => {
    await join(dana.userId, TEAM_B);
  });

  it("resolves to both, oldest first", async () => {
    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(identity.companyWorkspaceIds).toEqual([roots.companyWorkspaceId, TEAM_B]);
    // The one the write path defaults to stays the original, so growing a second
    // team does not move where existing members' captures land.
    expect(primaryCompanyWorkspaceId(identity)).toBe(roots.companyWorkspaceId);
  });

  it("reads both teams plus their own personal workspace", async () => {
    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(readableWorkspaces(identity)).toEqual([
      dana.personalWorkspaceId,
      roots.companyWorkspaceId,
      TEAM_B,
    ]);
    // Narrowing to "company" narrows to every company layer, not one of them.
    expect(scopeWorkspaces(identity, "company")).toEqual([roots.companyWorkspaceId, TEAM_B]);
    expect(scopeWorkspaces(identity, "personal")).toEqual([dana.personalWorkspaceId]);
  });

  it("recognises a row in either team as company-layer", async () => {
    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(isCompanyWorkspace(identity, roots.companyWorkspaceId)).toBe(true);
    expect(isCompanyWorkspace(identity, TEAM_B)).toBe(true);
    expect(isCompanyWorkspace(identity, roots.ownerPersonalWorkspaceId)).toBe(false);
    // The legacy/system space is never a team, whoever asks.
    expect(isCompanyWorkspace(identity, "")).toBe(false);
  });

  it("names the layer a row is in, for every surface that badges one", async () => {
    // /list, /entry, /recall, /graph, /patterns and the MCP tools all report a
    // row's layer, and they used to each carry their own copy of this
    // three-way expression. One implementation, so a row cannot be badged
    // "company" on the canvas and "system" in the review queue.
    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(layerOf(identity, dana.personalWorkspaceId)).toBe("personal");
    expect(layerOf(identity, roots.companyWorkspaceId)).toBe("company");
    expect(layerOf(identity, TEAM_B)).toBe("company");
    // Someone else's personal workspace is not a layer this caller has.
    expect(layerOf(identity, roots.ownerPersonalWorkspaceId)).toBe("system");
    // The legacy/system space, and a system-authored insight's own row.
    expect(layerOf(identity, "")).toBe("system");
    // No identity at all — the cron and unit callers of the graph walk. There
    // is no personal or company layer to be in without someone to be it for.
    expect(layerOf(undefined, TEAM_B)).toBe("system");
    expect(layerOf(undefined, undefined)).toBe("system");
  });

  it("writes to the named team when it is one of theirs, and never otherwise", async () => {
    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(scopeWrite(identity, "company", TEAM_B)).toBe(TEAM_B);
    expect(scopeWrite(identity, "company")).toBe(roots.companyWorkspaceId);
    // A team the caller does not belong to falls back to their primary rather
    // than honouring an id the request supplied.
    expect(scopeWrite(identity, "company", "ws-someone-elses")).toBe(roots.companyWorkspaceId);
    expect(scopeWrite(identity, "personal")).toBe(dana.personalWorkspaceId);
  });

  it("sees memories shared into either team through the API", async () => {
    seed("in-a", roots.companyWorkspaceId, roots.ownerUserId, "Team A handbook: ship behind a flag");
    seed("in-b", TEAM_B, roots.ownerUserId, "Team B runbook: page the on-call first");
    seed("owner-private", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Owner private: salary bands");

    const list = await jsonOf(await call("GET", "/list?n=50", dana.token));
    const contents = list.map((e: any) => e.content as string).join(" ");
    expect(contents).toContain("Team A handbook");
    expect(contents).toContain("Team B runbook");
    expect(contents).not.toContain("Owner private");
  });

  it("POST /capture with team lands in the named team, not the primary", async () => {
    const res = await jsonOf(await call("POST", "/capture", dana.token, {
      content: "Platform team onboarding checklist",
      workspace: "company",
      team: TEAM_B,
    }));
    expect(res.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(res.id).first() as { workspace_id: string };
    expect(row.workspace_id).toBe(TEAM_B);
  });

  it("POST /capture rejects a team the caller is not in", async () => {
    const res = await call("POST", "/capture", dana.token, {
      content: "Sneak into someone else's team",
      workspace: "company",
      team: "ws-not-mine",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/team/i);
  });

  it("POST /share moves into a named team workspace", async () => {
    seed("dana-private", dana.personalWorkspaceId, dana.userId, "Dana draft: platform migration plan");
    const res = await jsonOf(await call("POST", "/share", dana.token, {
      id: "dana-private",
      workspace: "company",
      team: TEAM_B,
    }));
    expect(res.ok).toBe(true);
    expect(res.workspaceId).toBe(TEAM_B);
    const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind("dana-private").first() as { workspace_id: string };
    expect(row.workspace_id).toBe(TEAM_B);
  });

  it("POST /share can move a memory from one team workspace to another", async () => {
    seed("team-a-note", roots.companyWorkspaceId, dana.userId, "Note that should move to Platform team");
    const res = await jsonOf(await call("POST", "/share", dana.token, {
      id: "team-a-note",
      workspace: "company",
      team: TEAM_B,
    }));
    expect(res.ok).toBe(true);
    expect(res.workspaceId).toBe(TEAM_B);
  });
});

describe("a member of one team is unaffected by the existence of another", () => {
  it("cannot read the team they are not in", async () => {
    // Dana is NOT joined to TEAM_B in this block.
    seed("in-b", TEAM_B, roots.ownerUserId, "Team B runbook: page the on-call first");
    seed("dana-own", dana.personalWorkspaceId, dana.userId, "Dana note");

    const list = await jsonOf(await call("GET", "/list?n=50", dana.token));
    const contents = list.map((e: any) => e.content as string).join(" ");
    expect(contents).toContain("Dana note");
    expect(contents).not.toContain("Team B runbook");

    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(identity.companyWorkspaceIds).toEqual([roots.companyWorkspaceId]);
    expect(isCompanyWorkspace(identity, TEAM_B)).toBe(false);
  });

  it("an admin still reads the legacy space, and only teams they joined", async () => {
    const admin = (await resolveIdentityFromToken(ADMIN, env))!;
    expect(readableWorkspaces(admin)).toEqual([
      roots.ownerPersonalWorkspaceId,
      roots.companyWorkspaceId,
      "",
    ]);
    expect(readableWorkspaces(admin)).not.toContain(TEAM_B);
  });
});

describe("a member of no team", () => {
  it("authenticates on their personal workspace alone", async () => {
    // Membership of a team is not what authenticates a user; the personal
    // workspace is. Legal once teams are plural — and it must narrow, not widen.
    await sqlite.db
      .prepare(`DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?`)
      .bind(dana.userId, roots.companyWorkspaceId)
      .run();

    const identity = (await resolveIdentityFromToken(dana.token, env))!;
    expect(identity.companyWorkspaceIds).toEqual([]);
    expect(readableWorkspaces(identity)).toEqual([dana.personalWorkspaceId]);
    // "company" with nowhere to land must not become an invisible '' row.
    expect(scopeWrite(identity, "company")).toBe(dana.personalWorkspaceId);

    seed("in-a", roots.companyWorkspaceId, roots.ownerUserId, "Team A handbook");
    const list = await jsonOf(await call("GET", "/list?n=50", dana.token));
    expect(JSON.stringify(list)).not.toContain("Team A handbook");
  });

  it("still loses their membership rows when removed", async () => {
    // Nothing about plural teams should change offboarding.
    expect((await call("POST", "/team/members/remove", ADMIN, { id: dana.userId })).status).toBe(200);
    expect(await resolveIdentityFromToken(dana.token, env)).toBeNull();
  });
});


describe("naming a team", () => {
  it("every member sees the name, and only their own teams", async () => {
    await join(dana.userId, TEAM_B);

    const admin = await jsonOf(await call("GET", "/team/workspaces", ADMIN));
    expect(admin.admin).toBe(true);
    expect(admin.teams).toEqual([
      { id: roots.companyWorkspaceId, name: "Company", memberCount: 2 },
    ]);

    // Dana is in both, so she sees both — in her identity's order.
    const member = await jsonOf(await call("GET", "/team/workspaces", dana.token));
    expect(member.admin).toBe(false);
    expect(member.teams.map((t: any) => t.id)).toEqual([roots.companyWorkspaceId, TEAM_B]);
    expect(member.teams[1].name).toBe("Platform");
  });

  it("an admin names the team and every member sees it", async () => {
    const res = await jsonOf(await call("POST", "/team/workspaces/rename", ADMIN, { name: "  Acme Engineering  " }));
    expect(res).toMatchObject({ ok: true, id: roots.companyWorkspaceId, name: "Acme Engineering" });

    const member = await jsonOf(await call("GET", "/team/workspaces", dana.token));
    expect(member.teams[0].name).toBe("Acme Engineering");
  });

  it("defaults to the caller's primary team when no id is given", async () => {
    await join(dana.userId, TEAM_B);
    // The admin is only in the bootstrap team, so an id-less rename can only
    // ever mean that one — a single-team brain need not know its workspace id.
    await call("POST", "/team/workspaces/rename", ADMIN, { name: "Renamed" });
    const teams = (await jsonOf(await call("GET", "/team/workspaces", dana.token))).teams;
    expect(teams[0].name).toBe("Renamed");
    expect(teams[1].name).toBe("Platform");
  });

  it("a member cannot rename a team", async () => {
    expect((await call("POST", "/team/workspaces/rename", dana.token, { name: "Hijacked" })).status).toBe(403);
    const teams = (await jsonOf(await call("GET", "/team/workspaces", ADMIN))).teams;
    expect(teams[0].name).toBe("Company");
  });

  it("an admin cannot rename a team they are not in", async () => {
    // TEAM_B exists but the admin never joined it. The id comes from the
    // request, so this is the check that stops it naming someone else's team.
    const res = await call("POST", "/team/workspaces/rename", ADMIN, { id: TEAM_B, name: "Taken" });
    expect(res.status).toBe(404);
    const row = await sqlite.db.prepare(`SELECT name FROM workspaces WHERE id = ?`)
      .bind(TEAM_B).first() as { name: string };
    expect(row.name).toBe("Platform");
  });

  it("refuses an empty name and one that is too long", async () => {
    expect((await call("POST", "/team/workspaces/rename", ADMIN, { name: "   " })).status).toBe(400);
    expect((await call("POST", "/team/workspaces/rename", ADMIN, { name: "x".repeat(61) })).status).toBe(400);
    expect((await jsonOf(await call("GET", "/team/workspaces", ADMIN))).teams[0].name).toBe("Company");
  });

  it("member counts exclude suspended and removed people", async () => {
    await sqlite.db.prepare(`UPDATE users SET suspended = 1 WHERE id = ?`).bind(dana.userId).run();
    const teams = (await jsonOf(await call("GET", "/team/workspaces", ADMIN))).teams;
    expect(teams[0].memberCount).toBe(1);
  });
});
