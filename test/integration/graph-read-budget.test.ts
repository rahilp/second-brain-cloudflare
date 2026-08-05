/**
 * #281 — the dashboard graph view must not read the whole edges table.
 *
 * Driven against real SQLite (`test/helpers/sqlite-d1.ts`) rather than the string-matching
 * D1 mock, because the bug *is* the query plan. The mock slices a sorted array, so it
 * hands back exactly the right rows whether or not SQLite could have found them without
 * scanning and sorting every edge first — it cannot fail on this.
 *
 * What the plan costs, measured on workerd D1 through Miniflare (`meta.rows_read`):
 *
 *   edges     query                             before    after
 *   50,000    ORDER BY weight DESC LIMIT 6000   100,000   6,000
 *   200,000   ORDER BY weight DESC LIMIT 6000   400,000   6,000
 *   200,000   ORDER BY weight DESC (no LIMIT)   400,000   200,000
 *   200,000   one whole GET /graph              1,499,398 38,598
 *
 * Two separate things go wrong, and the middle rows are what separate them. Without an
 * index on weight there is no ordered path to it, so SQLite reads every row into a temp
 * b-tree and applies the LIMIT afterwards — rows_read is 2x the edge count and the LIMIT
 * buys nothing. With the index but no LIMIT the sort is gone, but the scan still runs to
 * the end of the table. Only index *and* LIMIT together bound the read, which is why the
 * cap in buildGraph is part of this fix rather than a separate tidy-up. D1's free plan
 * allows 5M rows read per day and fails every query account-wide until 00:00 UTC once that
 * is spent: three /graph requests at 200k edges, and fewer as the brain grows.
 *
 * node:sqlite exposes no step counters, so the assertions stand on the plan instead:
 * "USE TEMP B-TREE FOR ORDER BY" is SQLite stating it must materialise and sort every row
 * before the LIMIT can apply, which is precisely the 2x-edge-count reads above, while an
 * index scan feeding a LIMIT stops after LIMIT rows. The plan is asserted on the exact SQL
 * `buildGraph` issues, captured from the binding rather than restated here, so it cannot
 * drift into testing a query the Worker does not run.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildGraph, GRAPH_VIEW_MAX_NODES } from "../../src/graph/traverse";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

/** The one statement this issue is about, whatever else buildGraph runs alongside it. */
const STRONGEST_EDGES = /FROM edges ORDER BY weight DESC/;

let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; });

/**
 * `n` edges over `n / 4` nodes with weights spread across 0..1, inserted by one recursive
 * CTE — a per-row INSERT from JS is the slow part of a 20,000-edge fixture, not SQLite.
 */
function seedGraph(db: SqliteD1, n: number): void {
  const nodes = Math.max(2, Math.floor(n / 4));
  db.db.prepare(
    `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ${n})
     INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
     SELECT 'e' || i, 'n' || (i / 4), 'n' || (((i / 4) + ((i % 4) + 1) * 997) % ${nodes}),
            'relates_to', (i % 1000) / 1000.0, 'inferred', '{}', 0, 0
     FROM seq`
  ).run();
  for (let i = 0; i < nodes; i++) db.seed({ id: `n${i}`, content: `Memory ${i}`, createdAt: 1000 + i });
}

/** env.DB over real SQLite, recording every statement so the plan can be taken later. */
function recordingEnv(db: SqliteD1): { env: Env; statements: string[] } {
  const statements: string[] = [];
  const DB = {
    prepare(sql: string) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return db.db.prepare(sql);
    },
  } as unknown as D1Database;
  return { env: makeTestEnv(undefined, { DB }), statements };
}

async function planOf(db: SqliteD1, sql: string): Promise<string> {
  const { results } = await db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  return (results as { detail: string }[]).map(r => r.detail).join(" | ");
}

describe("GET /graph read budget", () => {
  it("always bounds the strongest-edges query with a LIMIT, even with no caller limit", async () => {
    sqlite = makeSqliteD1();
    seedGraph(sqlite, 400);
    const { env, statements } = recordingEnv(sqlite);

    await buildGraph({}, env);

    // An unbounded ORDER BY has nothing for the index scan to stop at, so it reads to the
    // end of the table however small the caller intended the view to be.
    const strongest = statements.filter(s => STRONGEST_EDGES.test(s));
    expect(strongest).toHaveLength(1);
    expect(strongest[0]).toMatch(/LIMIT \d+$/);
  });

  it("plans that query as an index scan with no whole-table sort", async () => {
    sqlite = makeSqliteD1();
    seedGraph(sqlite, 2_000);
    const { env, statements } = recordingEnv(sqlite);

    await buildGraph({}, env);

    const plan = await planOf(sqlite, statements.find(s => STRONGEST_EDGES.test(s))!);
    expect(plan).toContain("USING INDEX idx_edges_weight");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("keeps the same bounded plan as the edge table grows", async () => {
    // The failure mode is a cost that scales with the brain, so the property under test is
    // that it does not: same plan, same LIMIT, 50x the edges.
    const plans: string[] = [];
    for (const edges of [500, 25_000]) {
      const db = makeSqliteD1();
      try {
        seedGraph(db, edges);
        const { env, statements } = recordingEnv(db);
        await buildGraph({}, env);
        plans.push(await planOf(db, statements.find(s => STRONGEST_EDGES.test(s))!));
      } finally {
        db.close();
      }
    }
    expect(plans[0]).toBe(plans[1]);
    expect(plans[1]).not.toContain("TEMP B-TREE");
  });

  it("caps the view at GRAPH_VIEW_MAX_NODES however large a limit is asked for", async () => {
    sqlite = makeSqliteD1();
    seedGraph(sqlite, 400);
    const { env, statements } = recordingEnv(sqlite);

    await buildGraph({ limit: GRAPH_VIEW_MAX_NODES * 100 }, env);

    const strongest = statements.find(s => STRONGEST_EDGES.test(s))!;
    expect(strongest).toContain(`LIMIT ${GRAPH_VIEW_MAX_NODES * 4}`);
  });

  it("still returns the strongest edges first, not an arbitrary subset", async () => {
    // The cheap alternative to the index was dropping ORDER BY entirely. It is not what
    // shipped, so the ordering it would have cost has to stay observable.
    sqlite = makeSqliteD1();
    for (let i = 0; i < 6; i++) sqlite.seed({ id: `n${i}`, content: `Memory ${i}`, createdAt: 1000 + i });
    const weights: [string, string, number][] = [["n0", "n1", 0.95], ["n2", "n3", 0.10], ["n4", "n5", 0.60]];
    for (const [source, target, weight] of weights) {
      await sqlite.db.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
         VALUES (?, ?, ?, 'relates_to', ?, 'inferred', '{}', 0, 0)`
      ).bind(`${source}-${target}`, source, target, weight).run();
    }
    const { env } = recordingEnv(sqlite);

    const { nodes } = await buildGraph({ limit: 2 }, env);

    expect(nodes.map(n => n.id)).toEqual(["n0", "n1"]);
  });
});

describe("edges schema drift", () => {
  // db/schema.sql runs on `npm run db:migrate`; src/db/init.ts runs on every cold isolate
  // and is the only thing that reaches a brain migrated before an index existed. A brain
  // is served by whichever ran last, so an index present in one and missing from the other
  // means the read budget above holds on some brains and not others.
  afterEach(resetDatabaseInit);

  // Autoindexes are excluded — they come from the PRIMARY KEY and UNIQUE constraints, so
  // they exist wherever the table does and say nothing about drift.
  const EDGE_INDEXES = `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'edges' AND name NOT LIKE 'sqlite_%' ORDER BY name`;

  it("creates the same edges indexes at runtime as a fresh migration does", async () => {
    sqlite = makeSqliteD1(); // db/schema.sql, applied for real
    const { results } = await sqlite.db.prepare(EDGE_INDEXES).all();
    const fromSchemaFile = (results as { name: string }[]).map(r => r.name);

    const raw = new DatabaseSync(":memory:");
    try {
      resetDatabaseInit();
      const DB = { exec: async (sql: string) => { raw.exec(sql); } } as unknown as D1Database;
      await initializeDatabase(makeTestEnv(undefined, { DB }));
      const fromInit = (raw.prepare(EDGE_INDEXES).all() as { name: string }[]).map(r => r.name);

      expect(fromInit).toEqual(fromSchemaFile);
      expect(fromInit).toContain("idx_edges_weight");
    } finally {
      raw.close();
    }
  });
});
