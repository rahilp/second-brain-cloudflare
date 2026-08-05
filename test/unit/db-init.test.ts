import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const MIGRATION: [column: string, alter: string][] = [
  ["recall_count", `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`],
  ["importance_score", `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`],
  ["contradiction_wins", `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`],
  ["contradiction_losses", `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`],
  ["updated_at", `ALTER TABLE entries ADD COLUMN updated_at INTEGER`],
  ["staleness_checked_at", `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`],
];
const ALL_COLUMNS = MIGRATION.map(([column]) => column);
const ALL_OBJECTS = ["entries", "idx_entries_created_at", "idx_entries_source", "edges", "idx_edges_source", "idx_edges_target", "idx_edges_weight"];
const BASE_COLUMNS = ["id", "content", "tags", "source", "created_at", "vector_ids"];

/** The catalogue read that opens every init. Spelled out so tests can exclude it by name. */
const PROBE = /^SELECT type AS kind, name FROM sqlite_master\b/;

type Row = { created_at: number; updated_at?: number | null };

// D1Mock's exec() never throws, so it cannot express "this column already exists".
// This stand-in models what the migration path turns on, verified against real workerd
// D1 via Miniflare: D1 rejects an ALTER for a column the table already has, a column
// added to a populated table reads NULL on every pre-existing row, and the probe reports
// exactly the tables, indexes and columns that are there. Every statement is recorded so
// a test can assert what a cold start costs — ALTERs are recorded even when they throw.
//
// `objects` defaults from the columns: a brain carrying migration columns necessarily has
// the table they sit on, and a brain carrying none is the fresh case where nothing exists.
// Pass it explicitly for anything in between.
function makeMigrationDb(existingColumns: string[] = [], rows: Row[] = [], existingObjects?: string[]) {
  const columns = new Set(existingColumns.length ? [...BASE_COLUMNS, ...existingColumns] : []);
  const objects = new Set(existingObjects ?? (existingColumns.length ? ALL_OBJECTS : []));
  const execd: string[] = [];
  const prepared: string[] = [];

  const DB = {
    async exec(sql: string) {
      execd.push(sql);
      const added = sql.match(/ALTER TABLE entries ADD COLUMN (\w+)/);
      if (added) {
        if (columns.has(added[1])) throw new Error(`D1_EXEC_ERROR: duplicate column name: ${added[1]}`);
        columns.add(added[1]);
        if (added[1] === "updated_at") rows.forEach(r => { r.updated_at = null; });
        return;
      }
      const created = sql.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/);
      if (created) {
        objects.add(created[1]);
        if (created[1] === "entries") BASE_COLUMNS.forEach(c => columns.add(c));
      }
    },
    prepare(sql: string) {
      prepared.push(sql);
      const make = (args: unknown[]) => ({
        bind: (...next: unknown[]) => make(next),
        first: async () => null,
        all: async () => ({
          results: PROBE.test(sql)
            ? [
              ...[...objects].map(name => ({ kind: name.startsWith("idx_") ? "index" : "table", name })),
              ...[...columns].map(name => ({ kind: "column", name })),
            ]
            : [],
        }),
        run: async () => ({ meta: { changes: 0 } }),
      });
      return make([]);
    },
  } as unknown as D1Database;

  return { env: makeTestEnv(undefined, { DB }), execd, prepared, rows };
}

const rowsAged = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ created_at: 1000 + i }));
/** Statements that touch entry *rows*. The probe reads the catalogue, not the table. */
const touchesEntries = (statements: string[]) =>
  statements.filter(s => /\bentries\b/.test(s) && !/^(CREATE|ALTER)\b/.test(s) && !PROBE.test(s));

describe("initializeDatabase updated_at migration", () => {
  // initializeDatabase memoises per isolate, so each case needs a clean slate.
  beforeEach(resetDatabaseInit);

  // updated_at is added by ALTER and never backfilled. initializeDatabase runs on every
  // cold isolate, so the target property is absolute: it issues no read and no write
  // against entries on any path, on any brain. A probe would be a full table scan on an
  // unindexed column (D1 bills rows_read); a backfill would be one row written per entry
  // (D1 caps rows written per day) for a value no reader can distinguish from NULL.

  it("issues no entry-row query at all on a fresh, unmigrated brain", async () => {
    const { env, execd, prepared, rows } = makeMigrationDb([], rowsAged(3));

    await initializeDatabase(env);

    expect(prepared.filter(s => !PROBE.test(s))).toEqual([]);
    expect(touchesEntries(execd)).toEqual([]);
    // The rows are left NULL on purpose — readers coalesce updated_at to created_at.
    expect(rows.every(r => r.updated_at === null)).toBe(true);
  });

  it("issues no entry-row query at all on an already-migrated brain", async () => {
    const { env, execd, prepared } = makeMigrationDb(ALL_COLUMNS, [{ created_at: 1000, updated_at: 1000 }]);

    await initializeDatabase(env);

    expect(prepared.filter(s => !PROBE.test(s))).toEqual([]);
    expect(touchesEntries(execd)).toEqual([]);
  });

  // #282. Twelve blind statements were spent per cold isolate discovering that a migrated
  // brain — every brain after its first request — needed none of them, out of a 50-per-
  // invocation free-plan budget that ensureDbReady spends inside the triggering request.
  describe("cost on a migrated brain", () => {
    it("costs one statement and issues no DDL when the schema is already complete", async () => {
      const { env, execd, prepared } = makeMigrationDb(ALL_COLUMNS, rowsAged(1));

      await initializeDatabase(env);

      expect(execd).toEqual([]);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toMatch(PROBE);
    });

    it("costs one statement on every cold start after the first", async () => {
      const { env, execd, prepared } = makeMigrationDb([], rowsAged(1));

      // Each reset stands in for a fresh isolate, which is what a cold start actually is.
      await initializeDatabase(env);
      const migrated = execd.length;
      resetDatabaseInit();
      await initializeDatabase(env);
      resetDatabaseInit();
      await initializeDatabase(env);

      expect(migrated).toBe(13); // the one-off cost of creating a brain: 7 objects + 6 columns
      expect(execd).toHaveLength(migrated); // the two later cold starts added nothing
      expect(prepared).toHaveLength(3); // one probe each, and nothing else
      expect(touchesEntries(execd)).toEqual([]);
    });

    it("issues only the ALTERs a partially-migrated brain is missing", async () => {
      const present = ["recall_count", "importance_score"];
      const { env, execd, prepared } = makeMigrationDb(present, rowsAged(1));

      await initializeDatabase(env);

      const missing = MIGRATION.filter(([column]) => !present.includes(column));
      expect(execd).toEqual(missing.map(([, alter]) => alter));
      expect(prepared).toHaveLength(1);
    });
  });

  // All four nightly jobs await initializeDatabase inside one scheduled() invocation,
  // sharing a single subrequest budget. Without memoisation the work is paid for once per
  // job. Callers must still await real completion — ensureDbReady's waitUntil does not.
  describe("memoisation", () => {
    it("runs the schema work once per isolate no matter how many callers await it", async () => {
      const { env, execd, prepared } = makeMigrationDb([], rowsAged(1));

      await initializeDatabase(env);
      const once = execd.length;
      await Promise.all([initializeDatabase(env), initializeDatabase(env), initializeDatabase(env)]);

      expect(execd).toHaveLength(once);
      expect(prepared).toHaveLength(1); // not even the probe is re-issued
    });

    it("shares one in-flight promise across concurrent callers", async () => {
      const { env, execd } = makeMigrationDb([], rowsAged(1));

      await Promise.all(Array.from({ length: 4 }, () => initializeDatabase(env)));

      expect(execd.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries"))).toHaveLength(1);
    });

    it("resetDatabaseInit clears the memo so a later call redoes the work", async () => {
      // Named for what it actually exercises — the test seam, not the failure path. The
      // rejection tests below are the ones that cover failure.
      const { env, prepared } = makeMigrationDb([], rowsAged(1));

      await initializeDatabase(env);
      resetDatabaseInit();
      await initializeDatabase(env);

      expect(prepared).toHaveLength(2); // the second call went back to the database
    });
  });

  // Regression: memoising on *completion* rather than on *success* latched a failed or
  // half-applied schema for the isolate's lifetime. Before memoisation each nightly job
  // re-ran the DDL and repaired the previous one's transient failure; these pin that a
  // failure is still retryable. Most likely trigger is a brand-new brain, where the very
  // first request must create every table against a D1 database made seconds earlier.
  describe("failure is not latched", () => {
    beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });

    /** DB whose statements all fail until `failing` is cleared. */
    function flakyDb() {
      const state = { failing: true, execd: [] as string[] };
      const fail = () => { throw new Error("D1_ERROR: Network connection lost."); };
      const DB = {
        async exec(sql: string) {
          if (state.failing) fail();
          state.execd.push(sql);
        },
        prepare: () => ({ all: async () => (state.failing ? fail() : { results: [] }) }),
      } as unknown as D1Database;
      return { state, env: makeTestEnv(undefined, { DB }) };
    }

    it("rejects rather than resolving when the schema could not be applied", async () => {
      const { env } = flakyDb();
      await expect(initializeDatabase(env)).rejects.toThrow(/Network connection lost/);
    });

    it("retries on the next call once D1 recovers", async () => {
      const { state, env } = flakyDb();

      await expect(initializeDatabase(env)).rejects.toThrow();
      state.failing = false;
      await initializeDatabase(env); // no resetDatabaseInit — the memo must have cleared itself

      expect(state.execd.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries"))).toHaveLength(1);
    });

    it("rejects when a later statement fails, rather than latching a partial schema", async () => {
      // The edges CREATE fails; entries already exists. Resolving here would leave the
      // isolate believing a schema with no edges table is complete.
      const execd: string[] = [];
      let failEdges = true;
      const DB = {
        async exec(sql: string) {
          if (failEdges && sql.includes("CREATE TABLE IF NOT EXISTS edges")) throw new Error("D1_ERROR: Network connection lost.");
          execd.push(sql);
        },
        prepare: () => ({ all: async () => ({ results: [] }) }),
      } as unknown as D1Database;
      const env = makeTestEnv(undefined, { DB });

      await expect(initializeDatabase(env)).rejects.toThrow();
      expect(execd.some(s => s.includes("CREATE TABLE IF NOT EXISTS edges"))).toBe(false);

      failEdges = false;
      await initializeDatabase(env);
      expect(execd.some(s => s.includes("CREATE TABLE IF NOT EXISTS edges"))).toBe(true);
    });

    it("still swallows the routine duplicate-column ALTER error", async () => {
      // The probe closes the ordinary case, but not the race: two isolates can cold-start
      // on the same brain at once, both read a schema without `updated_at`, and both try
      // to add it. The loser must not reject.
      const DB = {
        async exec(sql: string) {
          if (sql.startsWith("ALTER TABLE")) throw new Error("D1_EXEC_ERROR: duplicate column name: updated_at");
        },
        prepare: () => ({ all: async () => ({ results: [] }) }),
      } as unknown as D1Database;

      await expect(initializeDatabase(makeTestEnv(undefined, { DB }))).resolves.toBeUndefined();
    });

    it("rejects on an ALTER failure that is not duplicate-column", async () => {
      const DB = {
        async exec(sql: string) {
          if (sql.startsWith("ALTER TABLE entries ADD COLUMN importance_score")) {
            throw new Error("D1_ERROR: database is locked");
          }
        },
        prepare: () => ({ all: async () => ({ results: [] }) }),
      } as unknown as D1Database;

      await expect(initializeDatabase(makeTestEnv(undefined, { DB }))).rejects.toThrow(/database is locked/);
    });
  });

  it("applies every missing ALTER on a partially-migrated brain", async () => {
    const { env, execd, prepared } = makeMigrationDb(["recall_count", "importance_score"], rowsAged(1));

    await initializeDatabase(env);

    for (const [column, alter] of MIGRATION) {
      if (["recall_count", "importance_score"].includes(column)) continue;
      expect(execd).toContain(alter);
    }
    expect(prepared.filter(s => !PROBE.test(s))).toEqual([]);
  });

  // The backfill this replaced wrote one row per entry. On a 50,000-entry brain that was
  // half of D1's daily row-write budget in a single statement, and exceeding the cap
  // fails every query account-wide until 00:00 UTC.
  it("never backfills, at any brain size", async () => {
    const { env, execd, prepared, rows } = makeMigrationDb([], rowsAged(50_000));

    await initializeDatabase(env);

    const all = [...execd, ...prepared];
    expect(all.filter(s => /UPDATE\s+entries/i.test(s))).toEqual([]);
    expect(all.filter(s => /updated_at IS NULL/i.test(s))).toEqual([]);
    expect(rows.filter(r => r.updated_at == null)).toHaveLength(50_000);
  });
});

/**
 * The probe against a real database.
 *
 * The failure that would actually hurt is a probe that reports a schema as PRESENT when
 * it is not: the DDL is skipped, initializeDatabase resolves, and a brand-new brain
 * serves every subsequent request against tables that were never created. No mock can
 * catch that — d1-mock's exec() is a no-op and the stand-in above answers its own probe —
 * so these run the real statements against real SQLite, which is what D1 is.
 */
describe("initializeDatabase against real SQLite", () => {
  let d1: SqliteD1;
  const envFor = (sqlite: SqliteD1) => makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });

  beforeEach(resetDatabaseInit);
  afterEach(() => { d1?.close(); vi.restoreAllMocks(); });

  async function objectNames(sqlite: SqliteD1): Promise<string[]> {
    const { results } = await sqlite.db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`)
      .all() as { results: { name: string }[] };
    return results.map(r => r.name);
  }

  it("migrates a genuinely empty database", async () => {
    d1 = makeSqliteD1({ schema: false });
    expect(await objectNames(d1)).toEqual([]); // nothing at all, the state a new brain is in

    await initializeDatabase(envFor(d1));

    for (const name of ALL_OBJECTS) expect(await objectNames(d1)).toContain(name);
    expect(d1.columns()).toEqual([...BASE_COLUMNS, ...ALL_COLUMNS]);
  });

  it("leaves a migrated database usable, not merely present", async () => {
    // The tables existing is not the claim worth making — the claim is that the columns
    // every reader selects are really there. A missing ALTER passes an existence check
    // and then fails at the first SELECT.
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));

    await d1.db
      .prepare(`INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, '[]', 'api', ?, '[]')`)
      .bind("e1", "hello", 1000)
      .run();
    const { results } = await d1.db
      .prepare(`SELECT id, COALESCE(updated_at, created_at) AS updated_at, staleness_checked_at, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries`)
      .all() as { results: Record<string, unknown>[] };

    expect(results).toEqual([{
      id: "e1", updated_at: 1000, staleness_checked_at: null,
      recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
    }]);
  });

  it("costs one statement on an already-migrated brain", async () => {
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    const cold = d1.issued.length;
    d1.issued.length = 0;

    resetDatabaseInit(); // a second cold isolate against the brain the first one migrated
    await initializeDatabase(envFor(d1));

    expect(cold).toBe(14); // one probe, then the thirteen statements a new brain needs
    expect(d1.issued).toHaveLength(1);
    expect(d1.issued[0]).toMatch(PROBE);
  });

  it("adds only what a partially-migrated brain is missing", async () => {
    // db/schema.sql is a real intermediate state: it ships entries with four of the six
    // ALTER columns, so a brain installed from it is owed updated_at and
    // staleness_checked_at and nothing else.
    d1 = makeSqliteD1();
    expect(d1.columns()).not.toContain("updated_at");

    await initializeDatabase(envFor(d1));

    expect(d1.issued.filter(s => /^ALTER/.test(s))).toEqual([
      `ALTER TABLE entries ADD COLUMN updated_at INTEGER`,
      `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`,
    ]);
    expect(d1.issued.filter(s => /^CREATE/.test(s))).toEqual([]);
    expect(d1.columns()).toEqual([...BASE_COLUMNS, ...ALL_COLUMNS]);
  });

  it("adds only the weight index to a brain migrated before #281", async () => {
    // The newest object, and the one most likely to be the only thing a brain is missing:
    // every install that migrated before #281 has the complete schema apart from this.
    d1 = makeSqliteD1({ schema: false });
    await initializeDatabase(envFor(d1));
    await d1.db.exec(`DROP INDEX idx_edges_weight`);
    resetDatabaseInit();
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    expect(d1.issued).toEqual([
      expect.stringMatching(PROBE),
      `CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC)`,
    ]);
    expect(await objectNames(d1)).toContain("idx_edges_weight");
  });

  it("adds the edges table to a brain that predates it", async () => {
    // The other real intermediate state (issue #16 added edges to brains that already had
    // entries). Tables and indexes are probed independently of columns, so this is not
    // the same path as the ALTERs above.
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
    d1.issued.length = 0;

    await initializeDatabase(envFor(d1));

    expect(await objectNames(d1)).toContain("edges");
    expect(d1.issued.filter(s => s.startsWith("CREATE TABLE IF NOT EXISTS entries"))).toEqual([]);
    expect(d1.columns()).toEqual([...BASE_COLUMNS, ...ALL_COLUMNS]);
  });

  it("leaves existing rows untouched when it adds a column", async () => {
    d1 = makeSqliteD1();
    d1.seed({ id: "old", content: "written before the migration", createdAt: 1000 });

    await initializeDatabase(envFor(d1));

    // Not backfilled: readers coalesce updated_at to created_at, and writing it would
    // cost one row written per entry for a value nothing downstream can distinguish.
    expect(d1.rows()).toEqual([expect.objectContaining({
      id: "old", content: "written before the migration", created_at: 1000,
      updated_at: null, staleness_checked_at: null,
    })]);
  });

  // Degrading to the pre-#282 cost is the acceptable failure; skipping the DDL is not.
  // A probe may only report a thing PRESENT if it actually saw it, so every way of not
  // seeing it has to end in the statement being issued. Each of these would otherwise
  // leave a brand-new brain resolving initializeDatabase against tables that do not exist.
  describe("a probe that cannot be trusted still migrates", () => {
    /** Real SQLite for the DDL, `probe` for what the probe appears to return. */
    function dbWhoseProbe(probe: () => unknown) {
      return {
        prepare: (sql: string) => (PROBE.test(sql) ? { all: async () => probe() } : d1.db.prepare(sql)),
        exec: (sql: string) => d1.db.exec(sql),
      } as unknown as D1Database;
    }

    async function expectFullyMigrated() {
      for (const name of ALL_OBJECTS) expect(await objectNames(d1)).toContain(name);
      expect(d1.columns()).toEqual([...BASE_COLUMNS, ...ALL_COLUMNS]);
    }

    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      d1 = makeSqliteD1({ schema: false });
    });

    it("applies the whole schema when the probe throws", async () => {
      // The guard against the probe's one statement being unsupported on some future D1
      // and taking first-request migration down with it.
      await initializeDatabase(makeTestEnv(undefined, {
        DB: dbWhoseProbe(() => { throw new Error("D1_ERROR: unsupported statement"); }),
      }));

      await expectFullyMigrated();
      expect(console.warn).toHaveBeenCalled();
    });

    it("applies the whole schema when the probe returns a shape it cannot read", async () => {
      await initializeDatabase(makeTestEnv(undefined, { DB: dbWhoseProbe(() => ({ success: true })) }));

      await expectFullyMigrated();
    });

    it("does not accept a name held by the wrong kind of object", async () => {
      // SQLite puts tables and indexes in one namespace. A user table that has taken an
      // index's name is not that index, and matching on the name alone would resolve init
      // having silently never created it. Issuing the CREATE gets SQLite's collision
      // error instead — which is what happened before the probe existed.
      await d1.db.exec(`CREATE TABLE idx_entries_source (id TEXT)`);

      await expect(initializeDatabase(makeTestEnv(undefined, { DB: d1.db as unknown as D1Database })))
        .rejects.toThrow(/already a table named idx_entries_source/);
    });

    it("treats a row it cannot classify as missing rather than present", async () => {
      // `kind` is what separates a column from a table. A row that has lost it names
      // something, but nothing that licenses skipping a statement.
      await initializeDatabase(makeTestEnv(undefined, {
        DB: dbWhoseProbe(() => ({
          results: [
            ...ALL_OBJECTS.map(name => ({ name })), // no kind
            ...ALL_COLUMNS.map(name => ({ kind: "column", name: { toString: () => name } })), // not a string
            { kind: "trigger", name: "entries" },
          ],
        })),
      }));

      await expectFullyMigrated();
    });
  });

  it("survives two isolates migrating the same brain at once", async () => {
    // Both probe an unmigrated brain, both decide every ALTER is owed, and the loser gets
    // `duplicate column name` — the race the tolerance in applySchema exists for. D1 has
    // no transactional DDL to serialise them.
    d1 = makeSqliteD1({ schema: false });
    const first = initializeDatabase(envFor(d1));
    resetDatabaseInit(); // the second isolate has its own memo
    const second = initializeDatabase(envFor(d1));

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(d1.columns()).toEqual([...BASE_COLUMNS, ...ALL_COLUMNS]);
  });
});
