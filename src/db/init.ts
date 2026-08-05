import type { Env } from "../env";

// The schema work below is idempotent but not free. All four nightly jobs run inside a
// single scheduled() invocation and therefore share one subrequest budget, and each of
// them awaits initializeDatabase, so without memoisation the same pass is paid for three
// or four times per cron. Memoise per isolate: the first caller does the work, everyone
// else awaits that promise.
//
// Deliberately not routed through ensureDbReady (src/runtime/state.ts) — that fires under
// ctx.waitUntil *without* awaiting, and the nightly jobs must not begin querying before
// the schema exists. They await this directly and must keep doing so.
let initPromise: Promise<void> | null = null;

export async function initializeDatabase(env: Env): Promise<void> {
  if (!initPromise) {
    initPromise = applySchema(env).catch((e) => {
      // The memo keys on SUCCESS, not on completion. Clearing it here is what makes a
      // failed or half-applied schema retryable: latching a resolved promise would leave
      // every later caller in this isolate doing nothing against a database that was
      // never migrated. Before memoisation each nightly job re-ran the DDL and repaired
      // the previous one's transient failure; this preserves that.
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

/**
 * Test seam. The memo is module-scoped, so within a single test file the second call
 * would otherwise be a no-op and assertions about issued statements would go blind.
 */
export function resetDatabaseInit(): void {
  initPromise = null;
}

/**
 * Tables and indexes, keyed by the name each occupies in sqlite_master. Declaration order
 * is apply order: a table has to exist before the indexes over it.
 */
const SCHEMA_OBJECTS: Record<string, string> = {
  entries: `CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`,
  idx_entries_created_at: `CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`,
  idx_entries_source: `CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`,
  // Relationship graph (issue #16). One additive table — never touches existing
  // rows/queries, so old code ignores it and rollback is a no-op. Designed to never
  // need an ALTER: type/provenance are free TEXT validated in code, and metadata is
  // a JSON escape-hatch for any future per-edge attribute.
  edges: `CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_id, target_id, type))`,
  idx_edges_source: `CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)`,
  idx_edges_target: `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`,
  // The graph view picks the strongest edges (ORDER BY weight DESC LIMIT n). Without an
  // ordered path to weight SQLite reads the whole table into a temp b-tree and applies the
  // LIMIT afterwards, so on workerd D1 that statement's rows_read is 2 x the edge count and
  // is *identical* with and without the LIMIT: 400,000 at 200k edges, 6,000 with this
  // index. D1's free plan allows 5M rows read/day and fails every query account-wide until
  // 00:00 UTC once that is spent, so an authenticated caller could take the brain offline
  // in a handful of /graph requests.
  //
  // This is the fifth index on a table written on the capture hot path, so it is a real
  // trade rather than a free win. Measured, one whole capture (entry insert, vector_ids
  // and classifier updates, plus inferEdgesOnWrite's worst case of 3 edges) costs 22 rows
  // written before and 25 after — 4,545 captures/day against the 100k/day budget, down to
  // 4,000. The same brain went from 3 /graph requests/day to 129 (and, unlike the write
  // cost, that ceiling no longer falls as the brain grows). The read budget binds first by
  // three orders of magnitude on any brain that is not capturing thousands of times a day.
  //
  // Building it on an existing brain costs one row written per edge, once: measured
  // 200,001 rows written at 200k edges, and 0/0 on every run after that. Before #282 that
  // no-op was a statement issued on every cold isolate and made free by IF NOT EXISTS;
  // now the probe means it is not issued at all once the index exists, so the repeat costs
  // nothing rather than costing a subrequest that does nothing. That one build can exceed
  // the 100k/day write cap on a brain that is already very large — the same hazard the
  // updated_at note below describes. It is still the right call, because such a brain is
  // precisely the one the missing index takes offline every day, and the cost here is paid
  // once rather than on every /graph. If it ever needs to be avoided, the fix is to build
  // the index out of band, not to leave the query unindexed.
  //
  // DESC matches the query; SQLite would walk an ASC index backwards just as well, but
  // stating the direction keeps the index and its one caller obviously paired. Bonus: the
  // nightly prune's `weight < ?` becomes a range search, 200,000 rows read down to 60,000.
  idx_edges_weight: `CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC)`,
};

/**
 * Columns added to `entries` after the table shipped, keyed by column name. They arrived
 * across several releases, so a real brain can hold any prefix of this list — the probe
 * below is what decides which ones are still owed.
 */
const ENTRIES_COLUMNS: Record<string, string> = {
  recall_count: `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`,
  importance_score: `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`,
  contradiction_wins: `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`,
  contradiction_losses: `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`,
  // updated_at and staleness_checked_at are deliberately nullable and deliberately NOT
  // backfilled. Every reader coalesces them to a sensible default — updated_at to
  // created_at (COALESCE in SQL, ?? in TS), staleness_checked_at to 0 — so on an
  // existing row a NULL and a written value are indistinguishable downstream, and a
  // backfill would be a pure no-op that still costs one row written per entry. That is
  // not free: D1's plan limits row writes per day, and exceeding the cap fails every
  // query account-wide until 00:00 UTC, so backfilling a large brain on the ordinary
  // upgrade path is an availability risk that buys nothing. Please do not add one.
  // test/unit/updated-at-coalesced.test.ts fails if any reader stops coalescing.
  updated_at: `ALTER TABLE entries ADD COLUMN updated_at INTEGER`,
  staleness_checked_at: `ALTER TABLE entries ADD COLUMN staleness_checked_at INTEGER`,
};

/**
 * One statement that reports every schema object this file knows how to create: table and
 * index names out of sqlite_master, and entries' columns out of the table-valued form of
 * PRAGMA table_info (SQLite rewrites neither list lazily — an ALTER shows up immediately).
 * `kind` is what stops a name that appears on both sides from being read as the wrong one.
 *
 * This exists because the thirteen statements it replaces cost thirteen subrequests to
 * discover that a migrated brain — which is every brain after its first request — needs
 * nothing done (#282). Free-plan invocations get 50 subrequests, ensureDbReady spends
 * them inside the request that triggered it, and GET /graph was already close enough to
 * the ceiling that a cold isolate pushed it over: 59 against a limit of 50, now 47.
 *
 * Cost is one subrequest and one row read per catalogue entry: rows_read = 23 on a fully
 * migrated brain (our seven objects, plus D1's own bookkeeping table and SQLite's implicit
 * autoindexes, plus twelve columns) and — the part worth checking rather than assuming —
 * flat in the number of entries, because neither side of the UNION touches table data.
 * Both figures measured on real D1 (workerd via Miniflare), not on the mock. It grows by
 * one row per object added to SCHEMA_OBJECTS, which is the cheap direction: adding a
 * statement above now costs one row here rather than one subrequest on every cold start.
 */
const PROBE_SQL =
  `SELECT type AS kind, name FROM sqlite_master WHERE type IN ('table','index') ` +
  `UNION ALL SELECT 'column' AS kind, name FROM pragma_table_info('entries')`;

type ObjectKind = "table" | "index";
/**
 * `objects` maps name to kind rather than being a set of names, because SQLite puts tables
 * and indexes in one namespace: a name can be taken by the wrong kind of thing. Skipping on
 * the name alone would let a user table called `idx_entries_source` stand in for the index,
 * which resolves init successfully and silently never creates it.
 */
type ExistingSchema = { objects: Map<string, ObjectKind>; columns: Set<string> };

/** Which kind of object a CREATE statement makes, so the probe can be asked about it. */
const kindOf = (ddl: string): ObjectKind => (ddl.startsWith("CREATE TABLE") ? "table" : "index");

/**
 * What the database already has, or null if that could not be established.
 *
 * The invariant, and the only one that matters here: this may report a thing PRESENT only
 * if it actually saw it, as the kind it is looking for. Everything else — the probe
 * throwing, a result shape it does not recognise, a row whose `kind` is not one of the
 * three, a name that exists as the other kind — resolves towards "missing", so the worst a
 * confused probe can do is make applySchema pay the old whole-schema cost against DDL
 * that is idempotent anyway. The opposite error is the one that would hurt: a brand-new
 * brain talked out of migrating would then serve every request against tables that do not
 * exist.
 *
 * Returning null rather than throwing is not error-swallowing. It does not resolve
 * initializeDatabase — applySchema still has to apply and still rejects if the DDL fails.
 * It degrades this isolate to the pre-#282 cost, which is the behaviour that shipped for
 * every release before this one, and it is what keeps an unsupported PRAGMA on some
 * future D1 from bricking first-request migration for every new install.
 */
async function probeSchema(env: Env): Promise<ExistingSchema | null> {
  let rows: unknown;
  try {
    rows = (await env.DB.prepare(PROBE_SQL).all<{ kind: string; name: string }>())?.results;
  } catch (e) {
    console.warn("Schema probe failed; applying the full schema instead:", e);
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const objects = new Map<string, ObjectKind>();
  const columns = new Set<string>();
  for (const row of rows as { kind?: unknown; name?: unknown }[]) {
    if (typeof row?.name !== "string") continue;
    if (row.kind === "column") columns.add(row.name);
    else if (row.kind === "table" || row.kind === "index") objects.set(row.name, row.kind);
  }
  return { objects, columns };
}

/**
 * The one ALTER failure that is routine rather than a fault: the column was added between
 * the probe and here. That window is small now but not closed — two isolates can cold-start
 * on the same brain at once, and D1 has no transactional DDL to serialise them — so this
 * stays as the backstop it was. Every other error means the schema is not in the shape the
 * code expects.
 */
function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column name/i.test(String((e as { message?: string })?.message ?? e));
}

// Rejects on any genuine failure. Nothing here may swallow errors: a resolved promise is
// the signal initializeDatabase memoises, so swallowing would cache a schema that was
// never applied. The installer creates the D1 database moments before the first request
// reaches the Worker, so the very first run is exactly when a transient error is most
// likely — and most damaging, since that run is the one that creates every table.
//
// A fully migrated brain leaves here having issued the probe and nothing else. The DDL
// keeps its IF NOT EXISTS: it costs nothing to keep and it is the same backstop as the
// duplicate-column tolerance, for the same concurrent-cold-start race.
async function applySchema(env: Env): Promise<void> {
  const existing = await probeSchema(env);

  for (const [name, ddl] of Object.entries(SCHEMA_OBJECTS)) {
    // Kind as well as name: if something else has taken the name, this is not the object
    // we need and the CREATE has to be issued so SQLite raises the collision, which is
    // what it did before the probe existed.
    if (existing?.objects.get(name) === kindOf(ddl)) continue;
    await env.DB.exec(ddl);
  }
  for (const [column, ddl] of Object.entries(ENTRIES_COLUMNS)) {
    if (existing?.columns.has(column)) continue;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e; // column already exists — anything else is real
    }
  }
}
