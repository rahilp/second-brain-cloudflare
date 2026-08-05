/**
 * #277 — every integer query parameter reached the database unvalidated.
 *
 * `parseInt` returns NaN for a non-numeric value and the Math.min/Math.max
 * clamps around it do not sanitise that (`Math.min(NaN, 100)` is NaN), so the
 * bad value went through to D1. Where it landed decided what the caller saw:
 *
 *   GET /list?n=abc        HTTP 500 — NaN bound as LIMIT ? is SQLITE_MISMATCH
 *   GET /list?after=abc    200 with [] — created_at >= NaN matches nothing
 *   GET /recall?after=abc  the same empty result, reported as a success
 *   GET /recall?hops=abc   graph expansion silently skipped (h < NaN is false)
 *   GET /recall?topK=abc   .slice(0, NaN) — no results
 *   GET /graph?limit=abc   every row in `edges` returned, no LIMIT clause
 *
 * The silent ones are the reason this is a 400 and not a fallback: a caller
 * filtering by a malformed date got "you have no matching memories" instead of
 * "your request was malformed", and could not tell the difference.
 *
 * The /list cases run against real SQLite rather than D1Mock. The mock reads a
 * bound LIMIT with Number() and slices by it, which turns the 500 into a quiet
 * empty array — the bug is invisible to it. node:sqlite is the same engine D1
 * runs, and it raises the same "datatype mismatch" on a NaN LIMIT, so removing
 * the guard makes these tests fail the way production did.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { buildGraph, GRAPH_VIEW_MAX_NODES } from "../../src/graph/traverse";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("integer query parameters (#277)", () => {
  // ── GET /list, against real SQLite ─────────────────────────────────────────

  describe("GET /list", () => {
    let sqlite: SqliteD1;
    let env: Env;

    beforeEach(() => {
      sqlite = makeSqliteD1();
      for (let i = 0; i < 5; i++) {
        sqlite.seed({ id: `e${i}`, content: `Entry ${i}`, createdAt: 1000 + i * 1000 });
      }
      env = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });
    });

    afterEach(() => sqlite.close());

    it("answers 400 instead of the D1 datatype mismatch that made ?n= a 500", async () => {
      const res = await worker.fetch(req("GET", "/list?n=abc"), env, ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "n must be an integer" });
    });

    // The one that mattered most: this used to be a 200 carrying [], which reads
    // as an empty brain rather than a rejected request.
    it("answers 400 instead of an empty list when ?after= is not a timestamp", async () => {
      const res = await worker.fetch(req("GET", "/list?after=yesterday"), env, ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "after must be an integer" });
    });

    it("answers 400 instead of an empty list when ?before= is not a timestamp", async () => {
      const res = await worker.fetch(req("GET", "/list?before=2026-01-01"), env, ctx);
      expect(res.status).toBe(400);
    });

    // SQLite reads a negative LIMIT as no limit at all, so this was a second way
    // to ask an authenticated route for an unbounded read of `entries`.
    it("does not read the whole table for a negative ?n=", async () => {
      const res = await worker.fetch(req("GET", "/list?n=-1"), env, ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("still answers valid parameters against real SQL", async () => {
      const res = await worker.fetch(req("GET", "/list?n=2&after=2000&before=4000"), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any[];
      expect(data.map(e => e.id)).toEqual(["e3", "e2"]);
    });

    it("still caps ?n= at 100 rather than rejecting it", async () => {
      const res = await worker.fetch(req("GET", "/list?n=100000"), env, ctx);
      expect(res.status).toBe(200);
      expect((await res.json() as any[]).length).toBe(5);
    });
  });

  // ── GET /recall ────────────────────────────────────────────────────────────

  describe("GET /recall", () => {
    let env: Env;

    beforeEach(() => {
      env = makeTestEnv(makeTestDb());
    });

    it.each([
      ["after", "/recall?query=memory&after=yesterday"],
      ["before", "/recall?query=memory&before=soon"],
      ["topK", "/recall?query=memory&topK=lots"],
      ["hops", "/recall?query=memory&hops=deep"],
    ])("answers 400 for a malformed ?%s=", async (name, path) => {
      const res = await worker.fetch(req("GET", path), env, ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: `${name} must be an integer` });
    });

    it("rejects before running the search, so nothing is billed for a bad request", async () => {
      const db = makeTestDb();
      env = makeTestEnv(db);
      const vectorize = env.VECTORIZE as any;
      await worker.fetch(req("GET", "/recall?query=memory&topK=lots"), env, ctx);
      expect(vectorize.query).not.toHaveBeenCalled();
    });

    it("still accepts and clamps valid parameters", async () => {
      const res = await worker.fetch(req("GET", "/recall?query=memory&topK=999&hops=99&after=1"), env, ctx);
      expect(res.status).toBe(200);
    });
  });

  // ── GET /graph ─────────────────────────────────────────────────────────────

  describe("GET /graph", () => {
    it("answers 400 for a malformed ?limit= rather than returning every edge", async () => {
      const env = makeTestEnv(makeTestDb());
      const res = await worker.fetch(req("GET", "/graph?limit=all"), env, ctx);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "limit must be an integer" });
    });
  });

  // ── buildGraph's own ceiling ───────────────────────────────────────────────
  //
  // Defence in depth, independent of the route. buildGraph resolved "no usable
  // limit" to Infinity, and Number.isFinite(Infinity) is false, so it chose the
  // branch with no LIMIT clause and took back every row in `edges`. The LIMIT
  // bounds rows returned rather than rows read — `weight` is unindexed, so the
  // scan happens either way — but the returned rows are what fix the node set,
  // and the node set is what decides how many D1 queries the request costs:
  // 1 + ceil(N/100) + ceil(N/50), against a 50-subrequest free-plan budget.

  describe("buildGraph", () => {
    class RecordingD1 extends D1Mock {
      sql: string[] = [];
      prepare(sql: string) {
        this.sql.push(sql.replace(/\s+/g, " ").trim());
        return super.prepare(sql);
      }
    }

    let db: RecordingD1;
    let env: Env;

    beforeEach(() => {
      db = new RecordingD1();
      for (let i = 0; i < 6; i++) {
        db.entries.push({ id: `n${i}`, content: `Memory ${i}`, tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", importance_score: 0 });
      }
      for (let i = 0; i < 5; i++) {
        db.edges.push({ id: `e${i}`, source_id: `n${i}`, target_id: `n${i + 1}`, type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });
      }
      env = makeTestEnv(db as unknown as D1Mock);
    });

    const edgeScan = (recorded: string[]) =>
      recorded.find(s => s.startsWith("SELECT source_id, target_id FROM edges"));

    it.each([
      ["omitted", undefined],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["zero", 0],
      ["negative", -5],
    ])("always bounds the edge scan when limit is %s", async (_label, limit) => {
      await buildGraph({ limit }, env);
      expect(edgeScan(db.sql)).toBe(
        `SELECT source_id, target_id FROM edges ORDER BY weight DESC LIMIT ${GRAPH_VIEW_MAX_NODES * 4}`,
      );
    });

    it("still honours a caller's smaller limit", async () => {
      const { nodes } = await buildGraph({ limit: 3 }, env);
      expect(nodes).toHaveLength(3);
      expect(edgeScan(db.sql)).toBe("SELECT source_id, target_id FROM edges ORDER BY weight DESC LIMIT 12");
    });

    it("caps a caller's oversized limit at the ceiling", async () => {
      await buildGraph({ limit: GRAPH_VIEW_MAX_NODES * 10 }, env);
      expect(edgeScan(db.sql)).toBe(
        `SELECT source_id, target_id FROM edges ORDER BY weight DESC LIMIT ${GRAPH_VIEW_MAX_NODES * 4}`,
      );
    });

    function seedOversized() {
      const big = new RecordingD1();
      const total = GRAPH_VIEW_MAX_NODES + 500;
      for (let i = 0; i < total; i++) {
        big.entries.push({ id: `n${i}`, content: `Memory ${i}`, tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", importance_score: 0 });
      }
      for (let i = 0; i < total - 1; i++) {
        big.edges.push({ id: `e${i}`, source_id: `n${i}`, target_id: `n${i + 1}`, type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });
      }
      return big;
    }

    it("caps the node set itself, not only the edge scan", async () => {
      const big = seedOversized();
      const { nodes } = await buildGraph({}, makeTestEnv(big as unknown as D1Mock));
      expect(nodes).toHaveLength(GRAPH_VIEW_MAX_NODES);
    });

    // Truncation has to be partial, not corrupt: a node the view drops must not
    // leave an edge pointing at it.
    it("returns a self-consistent graph when it truncates", async () => {
      const big = seedOversized();
      const { nodes, edges } = await buildGraph({}, makeTestEnv(big as unknown as D1Mock));
      const ids = new Set(nodes.map(n => n.id));
      expect(edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true);
    });

    /**
     * The constraint that sets GRAPH_VIEW_MAX_NODES. Workers allow 50
     * subrequests per invocation on the free plan, and buildGraph spends
     * 1 + ceil(N/100) + ceil(N/50) D1 queries for N nodes plus one KV read for
     * the config. That is what makes the node cap a hard limit rather than a
     * taste question: at N=1634 the request exceeds the budget and the graph tab
     * is dead for every free-plan brain that size, with runGraphPass adding the
     * edges that get it there on its own.
     *
     * Raising the cap without recomputing this is the mistake this test exists
     * to catch, so it asserts the measured cost rather than a ratio.
     *
     * SCOPE: this measures the request's own D1 and KV calls on a warm isolate.
     * It deliberately does not cover the cold-isolate path, where
     * initializeDatabase fires under waitUntil and spends ~12 more from the same
     * budget, putting the first request against a fresh isolate at ~59 — over
     * the limit. Green here is not evidence that case is safe; it is #282.
     */
    it("keeps a full-size /graph request inside the free-plan subrequest budget", async () => {
      const FREE_PLAN_SUBREQUESTS = 50;
      const big = seedOversized();

      let kvReads = 0;
      const kv = makeTestEnv().OAUTH_KV;
      const countingKv = { ...kv, get: async (...args: any[]) => { kvReads++; return (kv.get as any)(...args); } };
      const bigEnv = makeTestEnv(big as unknown as D1Mock, { OAUTH_KV: countingKv as unknown as KVNamespace });

      const res = await worker.fetch(req("GET", "/graph"), bigEnv, ctx);
      expect(res.status).toBe(200);

      const N = GRAPH_VIEW_MAX_NODES;
      const predicted = 1 + Math.ceil(N / 100) + Math.ceil(N / 50);
      expect(big.sql).toHaveLength(predicted);
      expect(big.sql.length + kvReads).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });
  });
});
