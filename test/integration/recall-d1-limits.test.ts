/**
 * The two statements in recall whose size is decided by data rather than by the
 * code that builds them: the keyword arm's OR chain of `content LIKE ?` terms,
 * and the hydration `id IN (…)` list. D1 caps bound parameters at 100 and
 * expression-tree depth at 100, and both statements are one constant away from
 * either ceiling.
 *
 * #276 is what that looks like in production. `distillToRareTerms` narrows a
 * query to its MAX_QUERY_TERMS rarest terms by counting how often each occurs
 * across the corpus; with no rows to count it hands the query back whole, the
 * keyword arm turns every token into its own LIKE clause, and past roughly 120
 * words the request fails outright. A fresh install was one long question away
 * from a recall that could not answer, until the user saved their first memory.
 *
 * Driven against real SQLite (`test/helpers/sqlite-d1.ts`) so the empty corpus
 * is genuinely empty — the frequency aggregate returns `total: 0` because there
 * is nothing to count, not because a mock said so. The D1 limits are layered on
 * top, because nothing else here enforces them: the D1 mock evaluates no SQL,
 * and `node:sqlite` accepts 999 OR'd terms against its own depth ceiling of
 * 1000. A test run against either would pass while the Worker returned a 500.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { recallEntries } from "../../src/recall/search";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

// Measured against the Workers runtime for this issue: 119 words recalled, 120
// (100 tokens) returned a 500, and depth was the limit that bound first.
const D1_MAX_BOUND_PARAMS = 100;
const D1_MAX_EXPR_DEPTH = 100;

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// 120 coined words: every one clears the minimum token length and none is a
// stopword, so the token count is exactly the word count. A real 120-word
// question lands on the same 100 tokens once stopwords are stripped.
const LONG_QUERY = Array.from({ length: 120 }, (_, i) => `topic${i}`).join(" ");

interface Executed { sql: string; params: unknown[] }

/**
 * A D1 facade that enforces the two limits the real one enforces, and records
 * what was executed. `failWhen` fails a single statement, for the exit that
 * needs a database error rather than an empty corpus to fire.
 */
function withD1Limits(
  inner: SqliteD1["db"],
  executed: Executed[],
  failWhen: (sql: string) => boolean = () => false,
) {
  const check = (sql: string, params: unknown[]) => {
    executed.push({ sql, params });
    if (failWhen(sql)) throw new Error("D1_ERROR: network error: SQLITE_ERROR");
    // An N-way OR chain parses one level deeper than N, which is why 99 LIKE
    // terms are accepted and 100 are not. "ORDER BY" cannot match: the "OR"
    // there is not followed by whitespace. Checked before the parameter budget
    // because that is the order the runtime reported them in — parsing first.
    if (exprDepth(sql) > D1_MAX_EXPR_DEPTH) {
      throw new Error(`D1_ERROR: Expression tree is too large (maximum depth ${D1_MAX_EXPR_DEPTH}): SQLITE_ERROR`);
    }
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
  };
  const wrap = (sql: string, stmt: any, params: unknown[]): any => ({
    bind: (...args: unknown[]) => wrap(sql, stmt.bind(...args), args),
    all: async () => { check(sql, params); return stmt.all(); },
    first: async () => { check(sql, params); return stmt.first(); },
    run: async () => { check(sql, params); return stmt.run(); },
  });
  return { prepare: (sql: string) => wrap(sql, inner.prepare(sql), []) };
}

const exprDepth = (sql: string) => sql.split(/\s+OR\s+/i).length + 1;

const keywordStatements = (executed: Executed[]) =>
  executed.filter(e => e.sql.includes("FROM entries WHERE content LIKE"));

const hydrationStatements = (executed: Executed[]) =>
  executed.filter(e => e.sql.includes("created_at, updated_at FROM entries WHERE id IN"));

describe("recall stays inside D1's statement limits", () => {
  let sqlite: SqliteD1;
  let executed: Executed[];

  beforeEach(async () => {
    sqlite = makeSqliteD1();
    executed = [];
    // `updated_at` is one of the columns src/db/init.ts adds by ALTER at
    // runtime rather than in schema.sql, and that path goes through `exec`,
    // which this facade does not implement. Recall's hydration selects it.
    await sqlite.db.prepare(`ALTER TABLE entries ADD COLUMN updated_at INTEGER`).run();
  });

  afterEach(() => sqlite.close());

  const envWith = (failWhen?: (sql: string) => boolean, overrides: Partial<Env> = {}): Env =>
    makeTestEnv(undefined, {
      DB: withD1Limits(sqlite.db, executed, failWhen) as unknown as D1Database,
      ...overrides,
    });

  describe("the keyword clause, on an empty brain (#276)", () => {
    it("answers a 120-word query with no memories stored", async () => {
      const res = await worker.fetch(
        req("GET", `/recall?query=${encodeURIComponent(LONG_QUERY)}`),
        envWith(),
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.results).toEqual([]);

      const [keyword] = keywordStatements(executed);
      expect(keyword).toBeDefined();
      // One parameter per LIKE term plus the row limit.
      expect(keyword.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(exprDepth(keyword.sql)).toBeLessThanOrEqual(D1_MAX_EXPR_DEPTH);
    });

    it("answers a 120-word query when the frequency scan itself fails", async () => {
      // The other exit that returns the query uncapped, and the reason the cap
      // lives where the clause is built rather than at one distillation exit:
      // here the corpus is not empty, the statistics are simply unavailable.
      sqlite.seed({ id: "e1", content: "topic0 is written down", createdAt: 1000 });
      const scanFailed = (sql: string) => sql.includes("SUM(CASE WHEN content LIKE");

      const res = await worker.fetch(
        req("GET", `/recall?query=${encodeURIComponent(LONG_QUERY)}`),
        envWith(scanFailed),
        ctx,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.results.map((r: any) => r.id)).toEqual(["e1"]);

      const [keyword] = keywordStatements(executed);
      expect(keyword.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(exprDepth(keyword.sql)).toBeLessThanOrEqual(D1_MAX_EXPR_DEPTH);
    });

    it("still distills to the rarest terms, and still finds them, once a memory exists", async () => {
      sqlite.seed({ id: "e1", content: "topic0 is written down", createdAt: 1000 });
      const env = envWith();

      const long = await worker.fetch(
        req("GET", `/recall?query=${encodeURIComponent(LONG_QUERY)}`),
        env,
        ctx,
      );
      expect(long.status).toBe(200);
      // Distillation can rank terms again, so the keyword arm sees three of them
      // plus the row limit — the cap is a backstop, not the narrowing.
      expect(keywordStatements(executed)[0].params.length).toBe(4);

      executed.length = 0;
      const short = await worker.fetch(req("GET", "/recall?query=topic0"), env, ctx);
      expect(short.status).toBe(200);
      const data = await short.json() as any;
      expect(data.results.map((r: any) => r.id)).toEqual(["e1"]);
    });
  });

  describe("the hydration id list", () => {
    // Today this list cannot outgrow one statement: the route and the MCP tool
    // both clamp topK to 20, and expandGraph stops at GRAPH_MAX_NODES (50), so
    // the worst case is 70 ids. recallEntries itself does not clamp, so calling
    // it directly is the honest way to ask what the query does when the list
    // does outgrow one statement — which is one constant in another file away.
    const N = 150;
    const ids = Array.from({ length: N }, (_, i) => `e${i}`);

    it("chunks the ids rather than binding them all in one statement", async () => {
      for (const [i, id] of ids.entries()) {
        sqlite.seed({ id, content: `memory ${i} about topic0`, createdAt: 1000 + i });
      }
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: ids.map((id, i) => ({
              id,
              score: 1 - i / (N * 2),
              metadata: { parentId: id, created_at: 1000 + i },
            })),
          }),
        }),
      });

      const { matches } = await recallEntries(
        { query: "topic0", topK: N, synthesize: false }, env, ctx,
      );

      // Every seed hydrated exactly once: nothing dropped at a batch boundary,
      // nothing counted twice by an overlapping slice.
      expect(matches.length).toBe(N);
      expect(new Set(matches.map(m => m.id)).size).toBe(N);
      expect([...matches.map(m => m.id)].sort()).toEqual([...ids].sort());
      expect(matches.every(m => m.content === `memory ${ids.indexOf(m.id)} about topic0`)).toBe(true);

      const hydration = hydrationStatements(executed);
      expect(hydration.length).toBe(2);
      expect(hydration.map(h => h.params.length)).toEqual([100, 50]);
      expect(Math.max(...hydration.map(h => h.params.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });

    it("leaves room for the time-filter bindings it shares the budget with", async () => {
      for (const [i, id] of ids.entries()) {
        sqlite.seed({ id, content: `memory ${i} about topic0`, createdAt: 1000 + i });
      }
      const env = envWith(undefined, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: ids.map((id, i) => ({
              id,
              score: 1 - i / (N * 2),
              metadata: { parentId: id, created_at: 1000 + i },
            })),
          }),
        }),
      });

      // `after` and `before` are bound on every batch, so the id slice has to be
      // smaller than the parameter budget, not equal to it.
      const { matches } = await recallEntries(
        { query: "topic0", topK: N, after: 1000, before: 1000 + N, synthesize: false }, env, ctx,
      );

      expect(matches.length).toBe(N);
      const hydration = hydrationStatements(executed);
      expect(hydration.map(h => h.params.length)).toEqual([100, 54]);
      expect(Math.max(...hydration.map(h => h.params.length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
  });
});
