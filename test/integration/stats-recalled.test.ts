/**
 * GET /stats/recalled against real SQLite: ORDER BY recall_count DESC is a
 * query test/helpers/d1-mock.ts cannot evaluate (it pattern-matches SQL, not
 * runs it), so this uses test/helpers/sqlite-d1.ts throughout.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

async function migrated(): Promise<{ sq: SqliteD1; env: Env }> {
  const sqlite = makeSqliteD1();
  resetDatabaseInit();
  const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
  await initializeDatabase(env);
  setDbReady(true);
  return { sq: sqlite, env };
}

function seed(
  sqlite: SqliteD1, id: string, workspaceId: string, actorId: string,
  content: string, recallCount: number, source = "test", tags: string[] = [],
  contradictionWins = 0,
) {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id, recall_count, contradiction_wins)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).bind(id, content, JSON.stringify(tags), source, Date.now(), Date.now(), workspaceId, actorId, recallCount, contradictionWins).run();
}

describe("GET /stats/recalled", () => {
  it("requires auth", async () => {
    const m = await migrated();
    sq = m.sq;
    const res = await worker.fetch(req("GET", "/stats/recalled", { token: null }), m.env, ctx);
    expect(res.status).toBe(401);
  });

  it("answers cleanly on an empty brain", async () => {
    const m = await migrated();
    sq = m.sq;
    const data = await (await worker.fetch(req("GET", "/stats/recalled"), m.env, ctx)).json() as any;
    expect(data).toEqual({ ok: true, total_recalls: 0, total_contradictions: 0, entries: [] });
  });

  it("orders by recall_count desc, tie-broken by created_at desc, and sums total_recalls", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);

    seed(sq, "low", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Rarely recalled", 1, "claude-desktop");
    seed(sq, "high", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Often recalled", 9, "email-gmail");
    seed(sq, "mid", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Sometimes recalled", 4, "cli");

    // A second workspace's row: must never appear, and must never count toward total_recalls.
    seed(sq, "other", "ws-someone-else", "user-someone-else", "Not mine", 1000);

    const data = await (await worker.fetch(req("GET", "/stats/recalled"), m.env, ctx)).json() as any;
    expect(data.ok).toBe(true);
    expect(data.total_recalls).toBe(14); // 1 + 9 + 4, never the foreign row's 1000
    expect(data.entries.map((e: any) => e.id)).toEqual(["high", "mid", "low"]);
    expect(data.entries[0]).toEqual({
      id: "high", content: "Often recalled", source: "email-gmail",
      created_at: expect.any(Number), recall_count: 9,
    });
  });

  it("excludes synthesized, rolled-up, auto-pattern and auto-insight rows from both the list and the sum", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);

    seed(sq, "real", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "A real memory", 5);
    seed(sq, "digest", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "A digest", 50, "test", ["synthesized"]);
    seed(sq, "rollup", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "A rollup", 50, "test", ["rolled-up"]);
    seed(sq, "pattern", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "A pattern", 50, "test", ["auto-pattern"]);
    seed(sq, "insight", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "An insight", 50, "test", ["auto-insight"]);

    const data = await (await worker.fetch(req("GET", "/stats/recalled"), m.env, ctx)).json() as any;
    expect(data.entries.map((e: any) => e.id)).toEqual(["real"]);
    expect(data.total_recalls).toBe(5);
  });

  it("sums contradiction_wins over the same scoped set, excluding another workspace's rows", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);

    seed(sq, "a", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Won some", 1, "test", [], 3);
    seed(sq, "b", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Never contradicted", 1, "test", [], 0);
    seed(sq, "c", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Won a lot", 1, "test", [], 5);

    // A second workspace's row: its contradiction_wins must never be counted.
    seed(sq, "other", "ws-someone-else", "user-someone-else", "Not mine", 1, "test", [], 7);

    const data = await (await worker.fetch(req("GET", "/stats/recalled"), m.env, ctx)).json() as any;
    expect(data.total_contradictions).toBe(8); // 3 + 0 + 5, never the foreign row's 7
  });

  it("clamps limit to the 1..20 range and defaults to 5", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);
    for (let i = 0; i < 10; i++) {
      seed(sq, `e${i}`, roots.ownerPersonalWorkspaceId, roots.ownerUserId, `Memory ${i}`, i);
    }

    const dflt = await (await worker.fetch(req("GET", "/stats/recalled"), m.env, ctx)).json() as any;
    expect(dflt.entries).toHaveLength(5);

    const low = await (await worker.fetch(req("GET", "/stats/recalled?limit=0"), m.env, ctx)).json() as any;
    expect(low.entries).toHaveLength(1);

    const high = await (await worker.fetch(req("GET", "/stats/recalled?limit=999"), m.env, ctx)).json() as any;
    expect(high.entries).toHaveLength(10); // fewer than 20 exist
  });
});
