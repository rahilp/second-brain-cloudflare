/**
 * What `GET /integrations` says about a connection's provenance: which layer it
 * mirrors into, who connected it, and when.
 *
 * An integration is one deployment-wide KV blob, so "who last handed this brain
 * a token" is a question every member can reasonably ask and nothing recorded
 * the answer to. Three properties are pinned here, and each is a decision:
 *
 * 1. `mirrorWorkspace` is NARROWED on the way out, not passed through, so the
 *    readout and `mirrorWriteContext` cannot disagree about where mirrors land.
 * 2. The name is resolved at READ time through `listRoster` — the only
 *    people-list in this codebase scoped to the caller's own teams — so a
 *    rename propagates and a departure degrades to `null` rather than to a
 *    stale name. A connector outside the caller's teams is not the caller's to
 *    see, and reads as `null` too.
 * 3. The response carries a NAME or null, never a user id. A member has no use
 *    for a colleague's user id, and the roster's allowlist argument applies to
 *    every people-shaped field this codebase publishes.
 *
 * There is no backfill: a record connected before this shipped reports
 * `connectedBy: null` forever, because the actor was never recorded and a wrong
 * name on a provenance field is worse than none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { loadIntegration } from "../../src/integrations";
import { mirrorWriteContext } from "../../src/integrations/mirror";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (p: Promise<any>) => { pending.push(p); } } as ExecutionContext;
const OWNER = "test-token"; // the bootstrap admin, named "Owner"
const TEAM_B = "ws-team-b";

let pending: Promise<unknown>[] = [];
let sqlite: SqliteD1;
let env: Env;
let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;
let dana: { userId: string; token: string };
let bea: { userId: string; token: string };
let carol: { userId: string; token: string };

/** Serves Notion's API for several tokens, so "whose connection is this" is visible. */
function stubNotion(tokens: Record<string, string>) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const auth = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    const workspaceName = tokens[auth];
    if (!workspaceName) {
      return new Response(JSON.stringify({ message: "API token is invalid." }), { status: 401 });
    }
    if (url.endsWith("/users/me")) {
      return new Response(JSON.stringify({
        object: "user", type: "bot", name: "Second Brain", bot: { workspace_name: workspaceName },
      }), { status: 200 });
    }
    if (url.endsWith("/search")) {
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
}

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

/** The one integration row the settings screen would render. */
async function notionRow(token: string): Promise<any> {
  const list = await jsonOf(await call("GET", "/integrations", token));
  return list.integrations.find((i: any) => i.provider === "notion");
}

/** Put a user in a workspace. */
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

async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
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

  const madeDana = await createMember(env, { name: "Dana" });
  dana = { userId: madeDana.member.userId, token: madeDana.token };
  const madeBea = await createMember(env, { name: "Bea", role: "admin" });
  bea = { userId: madeBea.member.userId, token: madeBea.token };

  // A second team, and an admin who is only in it.
  await sqlite.db
    .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`)
    .bind(TEAM_B, Date.now() + 1000)
    .run();
  const madeCarol = await createMember(env, { name: "Carol", role: "admin" });
  carol = { userId: madeCarol.member.userId, token: madeCarol.token };
  await leave(carol.userId, roots.companyWorkspaceId);
  await join(carol.userId, TEAM_B);

  stubNotion({
    "owner-notion-token": "Acme HQ",
    "bea-notion-token": "Acme HQ",
    "carol-notion-token": "Platform HQ",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite?.close();
});

describe("GET /integrations reports where a connection mirrors and who made it", () => {
  it("reports the mirror layer, the connector's name and the connect time", async () => {
    const before = Date.now();
    await call("POST", "/integrations/notion/connect", OWNER, { token: "owner-notion-token" });

    const row = await notionRow(OWNER);
    expect(row.mirrorWorkspace).toBe("personal");
    expect(row.connectedBy).toBe("Owner");
    expect(typeof row.connectedAt).toBe("number");
    expect(row.connectedAt).toBeGreaterThanOrEqual(before);
  });

  it("the readout and the writer agree about the company layer", async () => {
    await call("POST", "/integrations/notion/connect", OWNER, {
      token: "owner-notion-token",
      workspace: "company",
    });

    const row = await notionRow(OWNER);
    expect(row.mirrorWorkspace).toBe("company");
    // The assertion that matters: the field the UI shows and the workspace the
    // sync actually writes into are the same answer for the same record.
    const record = await loadIntegration(env, "notion");
    expect((await mirrorWriteContext(env, record)).workspaceId).toBe(roots.companyWorkspaceId);
  });

  it("reads 'personal' for a config value that is neither enum value", async () => {
    await call("POST", "/integrations/notion/connect", OWNER, { token: "owner-notion-token" });
    const record = (await loadIntegration(env, "notion"))!;
    record.config = { ...record.config, mirrorWorkspace: "shared" };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));

    // config is a Record<string, unknown> escape hatch, so a hand-edited blob
    // can hold anything. Anything but "company" is personal on the write path,
    // and the readout must say the same.
    expect((await notionRow(OWNER)).mirrorWorkspace).toBe("personal");
    expect((await mirrorWriteContext(env, await loadIntegration(env, "notion"))).workspaceId)
      .toBe(roots.ownerPersonalWorkspaceId);
  });

  it("shows a member the connector's name and never a user id", async () => {
    await call("POST", "/integrations/notion/connect", OWNER, { token: "owner-notion-token" });

    const list = await jsonOf(await call("GET", "/integrations", dana.token));
    const row = list.integrations.find((i: any) => i.provider === "notion");
    expect(row.connectedBy).toBe("Owner");
    // A name or null, never an id — on every row in the payload, connected or not.
    for (const each of list.integrations) {
      expect(Object.keys(each)).not.toContain("connectedByUserId");
    }
    expect(JSON.stringify(list)).not.toContain(roots.ownerUserId);
  });

  it("follows a rename rather than a snapshot taken at connect time", async () => {
    await call("POST", "/integrations/notion/connect", OWNER, { token: "bea-notion-token" });
    expect((await notionRow(OWNER)).connectedBy).toBe("Owner");

    await sqlite.db.prepare(`UPDATE users SET name = 'Alex' WHERE id = ?`).bind(roots.ownerUserId).run();
    expect((await notionRow(OWNER)).connectedBy).toBe("Alex");
  });

  it("reports null for a record connected before the actor was recorded", async () => {
    await call("POST", "/integrations/notion/connect", OWNER, { token: "owner-notion-token" });
    // A pre-task blob: the mirror layer is there, the actor never was.
    const record = (await loadIntegration(env, "notion"))!;
    record.config = { mirrorWorkspace: "personal" };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));

    const spy = vi.spyOn(env.DB, "prepare");
    const legacyRow = await notionRow(OWNER);
    expect(legacyRow.connected).toBe(true);
    expect(legacyRow.connectedBy).toBeNull();
    const rosterQueries = (sql: any[]) => sql.filter((s) => String(s).includes("u.name COLLATE NOCASE"));
    // No id to resolve, so no roster read is paid for. The contrast below is
    // what makes this assertion mean something.
    expect(rosterQueries(spy.mock.calls.map((c) => c[0]))).toEqual([]);

    spy.mockClear();
    record.config = { mirrorWorkspace: "personal", connectedByUserId: roots.ownerUserId };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));
    expect((await notionRow(OWNER)).connectedBy).toBe("Owner");
    expect(rosterQueries(spy.mock.calls.map((c) => c[0])).length).toBe(1);
  });

  it("degrades to null when the connector has left, not to a stale name", async () => {
    await call("POST", "/integrations/notion/connect", bea.token, { token: "bea-notion-token" });
    expect((await notionRow(OWNER)).connectedBy).toBe("Bea");

    const removed = await call("POST", "/team/members/remove", OWNER, { id: bea.userId });
    expect(removed.status).toBe(200);
    await settle();

    const row = await notionRow(OWNER);
    expect(row.connectedBy).toBeNull();
    expect(row.connected).toBe(true); // the connection outlives the person
  });

  it("hides a connector who is not one of the caller's own teammates", async () => {
    // Carol administers the other team. The KV blob is deployment-wide, so the
    // Owner sees the connection — but a name resolved outside the caller's own
    // roster is exactly what listRoster's scope refuses to publish.
    await call("POST", "/integrations/notion/connect", carol.token, { token: "carol-notion-token" });

    const ownerRow = await notionRow(OWNER);
    expect(ownerRow.connected).toBe(true);
    expect(ownerRow.workspaceName).toBe("Platform HQ");
    expect(ownerRow.connectedBy).toBeNull();
    // And Carol, in whose team the connection was made, still sees herself.
    expect((await notionRow(carol.token)).connectedBy).toBe("Carol");
  });

  it("a reconnect records the new connector and keeps the item map", async () => {
    await call("POST", "/integrations/notion/connect", OWNER, { token: "owner-notion-token" });
    const first = (await loadIntegration(env, "notion"))!;
    first.itemMap = { page: { entryId: "e-1", version: "v1" } };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(first));

    await call("POST", "/integrations/notion/connect", bea.token, { token: "bea-notion-token" });

    const after = (await loadIntegration(env, "notion"))!;
    expect(after.config.connectedByUserId).toBe(bea.userId);
    // Preserved across the reconnect, which is what stops every mirrored item
    // duplicating on the next sync.
    expect(after.itemMap).toEqual({ page: { entryId: "e-1", version: "v1" } });
    expect(after.createdAt).toBe(first.createdAt);
    expect((await notionRow(OWNER)).connectedBy).toBe("Bea");
  });

  it("reports nulls for a provider nobody has connected", async () => {
    const row = await notionRow(OWNER);
    expect(row.connected).toBe(false);
    expect(row.connectedBy).toBeNull();
    expect(row.connectedAt).toBeNull();
    expect(row.mirrorWorkspace).toBe("personal");
  });
});
