/**
 * What GET /stats/graph costs D1, pinned.
 *
 * The endpoint exists to audit edge quality, so it is the one surface that
 * deliberately reads the whole edges table. That makes the split the load-
 * bearing part: the type histogram is one pass and always runs, while the
 * endpoint join, the degree ranking and the capture-gap histogram are three
 * more passes that must not happen unless the caller asked with ?deep=1. An
 * operator polling the cheap half on a schedule is the case this protects —
 * D1's free plan allows 5M rows read per day and fails every query
 * account-wide once that is spent.
 *
 * Driven against real SQLite rather than the string-matching D1 mock, for the
 * same reason as graph-read-budget: the mock cannot fail a plan assertion.
 * Plans are taken from the SQL captured off the binding, never restated here,
 * so they cannot drift into describing a query the Worker does not issue.
 *
 * Identity resolution runs before the route and is not what this measures, so
 * "route statements" are the ones touching edges/entries — the auth pair reads
 * users and workspaces only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

/** The route's own reads: identity resolution touches users and workspaces only. */
const TOUCHES_GRAPH = /FROM edges|FROM entries/;

describe("GET /stats/graph read budget", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let issued: string[];

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    issued = [];
    const inner = sqlite.db as any;
    const DB = {
      prepare(sql: string) { issued.push(sql); return inner.prepare(sql); },
      batch: (s: any) => inner.batch(s),
      exec: (s: string) => inner.exec(s),
    };
    env = makeTestEnv(undefined, { DB: DB as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    issued.length = 0;
  });

  afterEach(() => sqlite.close());

  async function call(path: string): Promise<string[]> {
    issued.length = 0;
    const res = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${ADMIN}` } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    return issued.filter(s => TOUCHES_GRAPH.test(s));
  }

  /** The plan for a statement the route actually issued, bound with throwaway values. */
  async function planOf(sql: string): Promise<string> {
    const n = (sql.match(/\?/g) ?? []).length;
    const plan: any = await (sqlite.db as any)
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...Array(n).fill("x"))
      .all();
    return (plan.results as any[]).map(r => r.detail).join("\n");
  }

  it("issues exactly one read, over edges alone, without ?deep=1", async () => {
    const stmts = await call("/stats/graph");
    expect(stmts).toHaveLength(1);
    // The cheap half must never reach entries: that is the whole split.
    expect(stmts[0]).not.toMatch(/FROM entries/);
    expect(stmts[0]).toMatch(/GROUP BY type/);
  });

  it("issues exactly four reads under ?deep=1", async () => {
    expect(await call("/stats/graph?deep=1")).toHaveLength(4);
  });

  it("resolves both edge endpoints through an index rather than per-row scans", async () => {
    const join = (await call("/stats/graph?deep=1")).find(s => s.includes("NOT EXISTS"))!;
    const plan = await planOf(join);
    // Two correlated lookups per edge, and both must seek on the id. Seeking
    // instead on the workspace — which the scope clause also offers an index
    // for — walks that whole workspace once per edge, so asserting merely
    // "an index was used" would pass on the O(edges x entries) plan.
    expect(plan.match(/SEARCH entries USING (?:COVERING )?INDEX \w+ \(id=\?\)/g) ?? []).toHaveLength(2);
    expect(plan).not.toMatch(/SCAN entries/);
  });

  it("reads the capture-gap histogram through the workspace/created index", async () => {
    const gaps = (await call("/stats/graph?deep=1")).find(s => s.includes("LAG(created_at)"))!;
    const plan = await planOf(gaps);
    expect(plan).toMatch(/idx_entries_workspace_created/);
    expect(plan).not.toMatch(/SCAN entries/);
  });

  it("scans edges once per aggregate, and no more", async () => {
    const stmts = await call("/stats/graph?deep=1");
    const scans = async (sql: string) => ((await planOf(sql)).match(/SCAN edges/g) ?? []).length;

    // Counted, not matched: `toMatch(/SCAN edges/)` proves at least one scan, so
    // an extra subquery re-reading edges would leave it green while doubling the
    // bill. edges has no index on workspace_id, so each of these IS a full scan.
    // If one ever reads SEARCH, an index was added: re-measure and update this
    // pin rather than deleting it.
    expect(await scans(stmts.find(s => s.includes("GROUP BY type"))!)).toBe(1);
    expect(await scans(stmts.find(s => s.includes("NOT EXISTS"))!)).toBe(1);
    // The degree ranking reads both endpoint columns, so two is its floor.
    expect(await scans(stmts.find(s => s.includes("UNION ALL"))!)).toBe(2);
  });

  it("does not multiply the workspace scope across the endpoint join", async () => {
    const stmts = await call("/stats/graph?deep=1");
    const params = (sql: string) => (sql.match(/\?/g) ?? []).length;
    const scopeSize = params(stmts.find(s => s.includes("GROUP BY type"))!);

    // Repeating the caller's workspace list once per endpoint put this
    // statement at 3x the scope size, which passes D1's 100-parameter ceiling
    // for an admin in ~32 teams and fails the request outright. The endpoints
    // are matched against edges.workspace_id instead, which binds nothing.
    expect(params(stmts.find(s => s.includes("NOT EXISTS"))!)).toBe(scopeSize);
  });
});
