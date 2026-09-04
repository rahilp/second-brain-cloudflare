/**
 * B1 — a near-duplicate the writer chose to keep is not a discovery.
 *
 * When capture flags a duplicate and the writer keeps both, the two entries are
 * by definition the most similar pair in the brain, so edge inference links them
 * every time. That edge carries no information: it says "these two say the same
 * thing", which the `duplicate-candidate` tag already says, and it outranks the
 * genuinely-related neighbours it competes with for the three inference slots.
 *
 * Two places produce it and both are closed here: the capture path, which infers
 * edges straight after flagging, and the nightly backfill, which walks entries
 * that have no edges yet — a flagged entry that got no edge at capture time is
 * precisely the row that reaches it.
 *
 * The merge and replace paths are deliberately untouched: they return before
 * inference ever runs, and the edge they would draw points at an entry that no
 * longer holds the same content.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { inferEdgesOnWrite } from "../../src/graph/edges";
import { runGraphPass } from "../../src/graph/pass";
import { captureEntry } from "../../src/capture/entry";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeTestDb, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/env";

describe("junk-link suppression", () => {
  describe("inferEdgesOnWrite", () => {
    let env: Env;
    let db: D1Mock;

    /** Inference refuses a neighbour with no entries row, so link targets need one. */
    function present(...ids: string[]): void {
      for (const id of ids) {
        db.entries.push({
          id, content: `entry ${id}`, tags: "[]", source: "api",
          created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0,
        });
      }
    }

    beforeEach(() => {
      db = makeTestDb();
      env = makeTestEnv(db);
    });

    it("draws no edge to the neighbour the caller named as the duplicate", async () => {
      present("new", "the-duplicate", "related");
      await inferEdgesOnWrite(
        "new",
        [{ id: "the-duplicate", score: 0.97 }, { id: "related", score: 0.83 }],
        env,
        { suppressId: "the-duplicate" },
      );
      const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
      expect(linked).toEqual(["related"]);
    });

    /**
     * Parity with the real-SQLite case in graph-follows.test.ts, driven through
     * the D1 double.
     *
     * The typed-edge guard lives in the INSERT statement, so the string-matching
     * mock has to model it explicitly (test/helpers/d1-mock.ts). Without this
     * case, disabling that branch of the mock leaves the whole suite green while
     * the double reports an insert production would have skipped — and every
     * mock-backed edge test then measures the wrong behaviour.
     */
    it("honours the typed-edge guard, matching real SQLite", async () => {
      present("new", "related");
      db.edges.push({
        id: "existing", source_id: "new", target_id: "related", type: "follows",
        weight: 0.85, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1,
      });

      await inferEdgesOnWrite("new", [{ id: "related", score: 0.83 }], env);

      expect(db.edges.map((e: any) => e.type)).toEqual(["follows"]);
    });

    it("still links that neighbour when no duplicate was named", async () => {
      present("new", "the-duplicate", "related");
      await inferEdgesOnWrite(
        "new",
        [{ id: "the-duplicate", score: 0.97 }, { id: "related", score: 0.83 }],
        env,
      );
      const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
      expect(linked.sort()).toEqual(["related", "the-duplicate"]);
    });
  });

  describe("the capture path", () => {
    /** A match between the flag and block thresholds: stored, tagged, kept. */
    function envFlagging(db: D1Mock): Env {
      return makeTestEnv(db, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
          }),
        }),
      });
    }

    it("draws no edge from a flagged capture to the entry it duplicates", async () => {
      const db = makeTestDb();
      const env = envFlagging(db);
      const pending: Promise<any>[] = [];
      const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;

      const result = await captureEntry("Similar note", [], "api", env, ctx);
      expect(result.status).toBe("flagged");
      await Promise.all(pending);

      // 0.88 clears EDGE_INFER_THRESHOLD, so before suppression this pair was
      // linked every time — the edge is not absent for want of similarity.
      expect(db.edges.flatMap((e: any) => [e.source_id, e.target_id])).not.toContain("near");
    });

    it("still links the other neighbours of a flagged capture", async () => {
      const db = makeTestDb();
      for (const id of ["near", "other"]) {
        db.entries.push({
          id, content: `entry ${id}`, tags: "[]", source: "api",
          created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0,
        });
      }
      const env = makeTestEnv(db, {
        VECTORIZE: makeVectorizeMock({
          query: vi.fn().mockResolvedValue({
            matches: [
              { id: "near", score: 0.88, metadata: { parentId: "near" } },
              { id: "other", score: 0.81, metadata: { parentId: "other" } },
            ],
          }),
        }),
      });
      const pending: Promise<any>[] = [];
      const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;

      expect((await captureEntry("Similar note", [], "api", env, ctx)).status).toBe("flagged");
      await Promise.all(pending);

      // Suppression is aimed at one neighbour, not at the whole inference pass.
      expect(db.edges.flatMap((e: any) => [e.source_id, e.target_id])).toContain("other");
    });
  });

  describe("nightly backfill", () => {
    let sqlite: SqliteD1;
    let env: Env;

    beforeEach(async () => {
      resetDatabaseInit();
      sqlite = makeSqliteD1();
      env = makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        // Any candidate at all: the point is which entries are OFFERED to
        // inference, not what the index returns for them.
        VECTORIZE: {
          query: async () => ({ matches: [{ id: "partner", score: 0.95, metadata: {} }] }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}),
          getByIds: async () => [],
        } as any,
      });
      await initializeDatabase(env);
    });

    afterEach(() => sqlite.close());

    const passCtx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;


    /**
     * The case Finding 2 was actually about: the backfill is where an orphaned
     * capture gets its edges, because a Vectorize write is not queryable
     * immediately and the predecessor written moments earlier is often invisible
     * to capture-time inference. Before the kind fallback the backfill passed no
     * kind, so everything it drew was generic — the pass that most needs to type
     * an edge was the one that never could.
     */
    it("types a follows edge, using each entry's own classifier kind", async () => {
      const t = Date.now();
      sqlite.seed({ id: "first", content: "the earlier thought", createdAt: t - 5 * 60_000, tags: ["kind:episodic"] });
      sqlite.seed({ id: "second", content: "the thought that follows", createdAt: t, tags: ["kind:episodic"] });
      const pairEnv = makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        VECTORIZE: {
          query: async () => ({ matches: [{ id: "first", score: 0.9, metadata: { parentId: "first" } }] }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
        } as any,
      });

      await runGraphPass(pairEnv, passCtx);

      const rows = await sqlite.db.prepare(`SELECT source_id, target_id, type FROM edges`).all() as any;
      expect(rows.results.map((e: any) => e.type)).toContain("follows");
    });

    it("skips entries tagged duplicate-candidate", async () => {
      sqlite.seed({ id: "dup", content: "a flagged near-duplicate", createdAt: 2000, tags: ["duplicate-candidate"] });
      sqlite.seed({ id: "partner", content: "the entry it duplicates", createdAt: 1000 });

      await runGraphPass(env, passCtx);

      const edges = await sqlite.db.prepare(`SELECT source_id, target_id FROM edges`).all() as any;
      expect(edges.results.flatMap((e: any) => [e.source_id, e.target_id])).not.toContain("dup");
    });

    it("still backfills an untagged entry with no edges", async () => {
      sqlite.seed({ id: "lonely", content: "an ordinary unlinked entry", createdAt: 2000 });
      sqlite.seed({ id: "partner", content: "something related", createdAt: 1000 });

      await runGraphPass(env, passCtx);

      const edges = await sqlite.db.prepare(`SELECT source_id, target_id FROM edges`).all() as any;
      expect(edges.results.flatMap((e: any) => [e.source_id, e.target_id])).toContain("lonely");
    });
  });

  /**
   * The sweep that keeps the edge table honest as entries are forgotten.
   *
   * An edge outliving the entry it points at is inert for reads — every graph
   * walk hydrates both endpoints through the caller's scope and drops what is
   * missing — but it is not harmless. src/entries/import.ts accepts
   * caller-supplied ids, so a later import can create a row with that id in
   * ANOTHER workspace and turn a dead edge into a live crossing one.
   *
   * Only inferred edges are swept. An explicit link pointing at a missing entry
   * is a statement someone made, and deleting it silently would lose it; it is
   * `GET /stats/graph?deep=1`'s invalidEndpointEdges count that surfaces those.
   */
  describe("the dangling-edge sweep", () => {
    let sqlite: SqliteD1;
    let env: Env;
    const passCtx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

    beforeEach(async () => {
      resetDatabaseInit();
      sqlite = makeSqliteD1();
      env = makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        VECTORIZE: {
          query: async () => ({ matches: [] }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
        } as any,
      });
      await initializeDatabase(env);
    });

    afterEach(() => {
      sqlite.close();
      vi.restoreAllMocks();
    });

    /** 2026-01-04 is a Sunday; 2026-01-05 a Monday. */
    const SUNDAY = Date.UTC(2026, 0, 4, 1, 0, 0);
    const MONDAY = Date.UTC(2026, 0, 5, 1, 0, 0);
    const onDay = (t: number) => vi.spyOn(Date, "now").mockReturnValue(t);

    function edge(id: string, source: string, target: string, provenance: string): void {
      sqlite.db.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
         VALUES (?, ?, ?, 'relates_to', 0.9, ?, '{}', 0, 0, '')`,
      ).bind(id, source, target, provenance).run();
    }

    const remaining = async (): Promise<string[]> =>
      ((await sqlite.db.prepare(`SELECT id FROM edges ORDER BY id`).all()) as any)
        .results.map((r: any) => r.id);


    /**
     * The loop the sweep would otherwise run forever.
     *
     * Inference used to draw an edge to a neighbour with no `entries` row — a
     * vector that outlived the entry it indexed, which happens whenever a
     * `deleteByIds` fails (both forgetEntry and member removal swallow that).
     * The sweep then deletes exactly those rows, which makes the entry edgeless
     * again, which puts it back in the backfill's slate, which re-infers the
     * same edge. Order within one pass is prune -> sweep -> backfill, so every
     * night deleted the previous night's edge and wrote it straight back:
     * one embed, one Vectorize query and one of 25 backfill slots per affected
     * entry, forever, silently.
     *
     * Refusing the neighbour at write time costs nothing — its absence is
     * already visible in the endpoint read — and leaves the sweep responsible
     * only for rows a failed cascade left behind.
     */
    it("does not recreate an edge to a vector whose entry is gone, run after run", async () => {
      sqlite.seed({ id: "alive", content: "an entry whose neighbour vector is stale", createdAt: 1000 });
      const ghostEnv = makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        VECTORIZE: {
          query: async () => ({ matches: [{ id: "ghost", score: 0.9, metadata: { parentId: "ghost" } }] }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
        } as any,
      });

      await runGraphPass(ghostEnv, passCtx);
      const afterFirst = await remaining();
      await runGraphPass(ghostEnv, passCtx);
      const afterSecond = await remaining();

      expect(afterFirst).toEqual([]);
      expect(afterSecond).toEqual([]);
    });


    /**
     * The sweep runs weekly, not nightly.
     *
     * It is a full scan of `edges` with two correlated endpoint lookups per
     * inferred row, and the free plan allows only five cron triggers — all five
     * are already spoken for (see wrangler.jsonc), so "weekly" has to be a gate
     * inside the nightly pass rather than a schedule of its own. Gating on the
     * UTC weekday costs no query, where a last-swept timestamp would cost a read
     * every night to save a scan six nights in seven.
     *
     * Weekly is enough because inference no longer CREATES dangling edges: the
     * sweep now cleans up historical rows and the rare failed vector cascade,
     * not an ongoing stream. Trade-off: a missed Sunday defers the sweep a week,
     * which for idempotent cleanup is not worth a state table to avoid.
     */
    it("does not sweep on other days of the week", async () => {
      onDay(MONDAY);
      sqlite.seed({ id: "alive", content: "still here", createdAt: 1000 });
      edge("dead-target", "alive", "forgotten", "inferred");

      await runGraphPass(env, passCtx);

      expect(await remaining()).toContain("dead-target");
    });

    it("drops an inferred edge whose target no longer exists", async () => {
      onDay(SUNDAY);
      sqlite.seed({ id: "alive", content: "still here", createdAt: 1000 });
      edge("dead-target", "alive", "forgotten", "inferred");

      await runGraphPass(env, passCtx);

      expect(await remaining()).not.toContain("dead-target");
    });

    it("drops an inferred edge whose source no longer exists", async () => {
      onDay(SUNDAY);
      sqlite.seed({ id: "alive", content: "still here", createdAt: 1000 });
      edge("dead-source", "forgotten", "alive", "inferred");

      await runGraphPass(env, passCtx);

      expect(await remaining()).not.toContain("dead-source");
    });

    it("keeps a dangling edge the user drew themselves", async () => {
      onDay(SUNDAY);
      sqlite.seed({ id: "alive", content: "still here", createdAt: 1000 });
      edge("mine", "alive", "forgotten", "explicit");

      await runGraphPass(env, passCtx);

      expect(await remaining()).toContain("mine");
    });

    it("keeps an inferred edge whose endpoints both exist", async () => {
      onDay(SUNDAY);
      sqlite.seed({ id: "one", content: "a", createdAt: 1000 });
      sqlite.seed({ id: "two", content: "b", createdAt: 1001 });
      edge("healthy", "one", "two", "inferred");

      await runGraphPass(env, passCtx);

      expect(await remaining()).toContain("healthy");
    });
  });
});
