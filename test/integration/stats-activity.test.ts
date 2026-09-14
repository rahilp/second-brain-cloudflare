/**
 * GET /stats/activity against real SQLite: GROUP BY source, day is exactly the
 * class of query test/helpers/d1-mock.ts cannot evaluate (see the worker
 * cookbook, section 4), so this uses test/helpers/sqlite-d1.ts throughout.
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
const DAY = 86400000;

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

function seed(sqlite: SqliteD1, id: string, workspaceId: string, actorId: string, createdAt: number, source: string) {
  sqlite.db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
     VALUES (?, 'x', '[]', ?, ?, ?, '[]', ?, ?)`,
  ).bind(id, source, createdAt, createdAt, workspaceId, actorId).run();
}

describe("GET /stats/activity", () => {
  it("requires auth", async () => {
    const m = await migrated();
    sq = m.sq;
    const res = await worker.fetch(req("GET", "/stats/activity", { token: null }), m.env, ctx);
    expect(res.status).toBe(401);
  });

  it("answers cleanly on an empty brain, with a well-formed start and days even though there is nothing to bucket", async () => {
    const m = await migrated();
    sq = m.sq;
    const now = Date.now();
    const data = await (await worker.fetch(req("GET", "/stats/activity"), m.env, ctx)).json() as any;
    expect(data.ok).toBe(true);
    expect(data.days).toBe(90); // fallback
    expect(data.start).toBe(Math.floor(now / DAY) - 89);
    expect(data.series).toEqual([]);
  });

  it("buckets entries across two days and two sources, zero-filled and scoped to the caller", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);
    const now = Date.now();
    const todayStart = Math.floor(now / DAY) * DAY;

    // Caller's own rows: two sources, two days.
    seed(sq, "a", roots.ownerPersonalWorkspaceId, roots.ownerUserId, todayStart + 1000, "claude-desktop");
    seed(sq, "b", roots.ownerPersonalWorkspaceId, roots.ownerUserId, todayStart + 2000, "email-gmail");
    seed(sq, "c", roots.ownerPersonalWorkspaceId, roots.ownerUserId, todayStart - DAY + 1000, "claude-desktop");

    // A second workspace's row: must never appear in the caller's series.
    seed(sq, "other", "ws-someone-else", "user-someone-else", todayStart + 1000, "claude-desktop");

    const data = await (await worker.fetch(req("GET", "/stats/activity?days=7"), m.env, ctx)).json() as any;
    expect(data.ok).toBe(true);
    expect(data.days).toBe(7);
    expect(data.start).toBe(Math.floor(now / DAY) - 6);

    const claudeSeries = data.series.find((s: any) => s.source === "claude-desktop");
    expect(claudeSeries.counts).toHaveLength(7);
    const totalClaude = claudeSeries.counts.reduce((a: number, b: number) => a + b, 0);
    expect(totalClaude).toBe(2); // "a" and "c", never "other"

    const gmailSeries = data.series.find((s: any) => s.source === "email-gmail");
    expect(gmailSeries.counts).toHaveLength(7);
    expect(gmailSeries.counts.reduce((a: number, b: number) => a + b, 0)).toBe(1);
  });

  it("orders series by total descending", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);
    const now = Date.now();

    seed(sq, "quiet", roots.ownerPersonalWorkspaceId, roots.ownerUserId, now, "cli");
    seed(sq, "busy-1", roots.ownerPersonalWorkspaceId, roots.ownerUserId, now, "claude-desktop");
    seed(sq, "busy-2", roots.ownerPersonalWorkspaceId, roots.ownerUserId, now, "claude-desktop");
    seed(sq, "busy-3", roots.ownerPersonalWorkspaceId, roots.ownerUserId, now, "claude-desktop");

    const data = await (await worker.fetch(req("GET", "/stats/activity?days=7"), m.env, ctx)).json() as any;
    expect(data.series.map((s: any) => s.source)).toEqual(["claude-desktop", "cli"]);
  });

  it("clamps days to the 7..365 range", async () => {
    const m = await migrated();
    sq = m.sq;

    const low = await (await worker.fetch(req("GET", "/stats/activity?days=1"), m.env, ctx)).json() as any;
    expect(low.days).toBe(7);

    const high = await (await worker.fetch(req("GET", "/stats/activity?days=9999"), m.env, ctx)).json() as any;
    expect(high.days).toBe(365);
  });
});
