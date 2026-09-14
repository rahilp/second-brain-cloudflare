/**
 * GET /stats/night reads a KV record the scheduled() handler writes; it never
 * touches D1 (see the comment on the route in src/routes/admin.ts for why:
 * deriving "since last night" from edges at read time is a full table scan).
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { setDbReady } from "../../src/runtime/state";
import { nightSummaryKey } from "../../src/runtime/night-summary";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

async function migrated(): Promise<{ sq: SqliteD1; env: Env; kv: KVNamespace }> {
  const sqlite = makeSqliteD1();
  resetDatabaseInit();
  const kv = makeMemoryKV();
  const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: kv });
  await initializeDatabase(env);
  setDbReady(true);
  return { sq: sqlite, env, kv };
}

describe("GET /stats/night", () => {
  it("requires auth", async () => {
    const m = await migrated();
    sq = m.sq;
    const res = await worker.fetch(req("GET", "/stats/night", { token: null }), m.env, ctx);
    expect(res.status).toBe(401);
  });

  it("answers ranAt: null when nothing has ever been recorded", async () => {
    const m = await migrated();
    sq = m.sq;
    const data = await (await worker.fetch(req("GET", "/stats/night"), m.env, ctx)).json() as any;
    expect(data).toEqual({ ok: true, ranAt: null });
  });

  it("returns a seeded record for the caller's own workspace", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);
    const record = { ranAt: 1700000000000, linksInferred: 4, insightsProposed: 0, digestsWritten: 2, claimsFlagged: 7 };
    await m.kv.put(nightSummaryKey(roots.ownerPersonalWorkspaceId), JSON.stringify(record));

    const data = await (await worker.fetch(req("GET", "/stats/night"), m.env, ctx)).json() as any;
    expect(data).toEqual({ ok: true, ...record });
  });

  it("sums the personal and company workspace records and takes the latest ranAt", async () => {
    const m = await migrated();
    sq = m.sq;
    const roots = await ensureTenantBootstrap(m.env);
    await m.kv.put(nightSummaryKey(roots.ownerPersonalWorkspaceId), JSON.stringify(
      { ranAt: 1700000000000, linksInferred: 1, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 1 },
    ));
    await m.kv.put(nightSummaryKey(roots.companyWorkspaceId), JSON.stringify(
      { ranAt: 1700000100000, linksInferred: 2, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 3 },
    ));

    const data = await (await worker.fetch(req("GET", "/stats/night"), m.env, ctx)).json() as any;
    expect(data).toEqual({
      ok: true, ranAt: 1700000100000,
      linksInferred: 3, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 4,
    });
  });

  it("an admin also sums the legacy '' bucket via readableWorkspaces", async () => {
    const m = await migrated();
    sq = m.sq;
    // The owner bootstraps as role "admin" (src/lib/tenancy.ts), and
    // readableWorkspaces appends "" for admins only (src/lib/scope.ts), the
    // legacy pre-team bucket a solo brain's rotation can still land the
    // maintenance cron on (src/runtime/rotation.ts).
    const roots = await ensureTenantBootstrap(m.env);
    await m.kv.put(nightSummaryKey(""), JSON.stringify(
      { ranAt: 1700000300000, linksInferred: 10, insightsProposed: 0, digestsWritten: 10, claimsFlagged: 10 },
    ));
    await m.kv.put(nightSummaryKey(roots.ownerPersonalWorkspaceId), JSON.stringify(
      { ranAt: 1700000000000, linksInferred: 1, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 1 },
    ));

    const data = await (await worker.fetch(req("GET", "/stats/night"), m.env, ctx)).json() as any;
    expect(data).toEqual({
      ok: true, ranAt: 1700000300000,
      linksInferred: 11, insightsProposed: 0, digestsWritten: 11, claimsFlagged: 11,
    });
  });

  it("never returns another workspace's record", async () => {
    const m = await migrated();
    sq = m.sq;
    await ensureTenantBootstrap(m.env);
    await m.kv.put(nightSummaryKey("ws-someone-else"), JSON.stringify(
      { ranAt: 1700000000000, linksInferred: 99, insightsProposed: 0, digestsWritten: 99, claimsFlagged: 99 },
    ));

    const data = await (await worker.fetch(req("GET", "/stats/night"), m.env, ctx)).json() as any;
    expect(data).toEqual({ ok: true, ranAt: null });
  });
});
