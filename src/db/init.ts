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
  entries: `CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]', workspace_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '')`,
  idx_entries_created_at: `CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`,
  idx_entries_source: `CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`,
  // Relationship graph (issue #16). One additive table — never touches existing
  // rows/queries, so old code ignores it and rollback is a no-op. Designed to never
  // need an ALTER: type/provenance are free TEXT validated in code, and metadata is
  // a JSON escape-hatch for any future per-edge attribute.
  edges: `CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, workspace_id TEXT NOT NULL DEFAULT '', UNIQUE(source_id, target_id, type))`,
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
  // Candidate pairs for the weekly insight pass (see docs/superpowers/specs/
  // 2026-08-10-insight-pass-design.md). Additive, like `edges` — old code
  // ignores it and rollback is a no-op.
  //
  // UNIQUE(a_id, b_id) with ids normalised so a_id < b_id at the call site is
  // what makes a pair enter once rather than twice in opposite orders. Together
  // with the `rejected` status it is also the dedupe: a candidate the model has
  // already declined is never re-proposed, and never paid for twice.
  insight_candidates: `CREATE TABLE IF NOT EXISTS insight_candidates (id TEXT PRIMARY KEY, a_id TEXT NOT NULL, b_id TEXT NOT NULL, similarity REAL NOT NULL, gap_ms INTEGER NOT NULL, score REAL NOT NULL, signal TEXT NOT NULL DEFAULT 'vector', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(a_id, b_id))`,
  // The weekly read is `WHERE status='pending' ORDER BY score DESC LIMIT n`.
  // Without an ordered path to score SQLite builds a temp b-tree over the whole
  // table before applying the LIMIT, the same shape idx_edges_weight exists to
  // avoid on the graph read path.
  idx_insight_candidates_queue: `CREATE INDEX IF NOT EXISTS idx_insight_candidates_queue ON insight_candidates(status, score DESC)`,
  // Team edition tenancy (v3). Additive: single-user brains never read these and
  // rollback is a no-op. See docs/superpowers/specs/2026-08-24-team-edition-design.md.
  workspaces: `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  idx_workspaces_kind: `CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind)`,
  users: `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  // Token lookup is the hottest new read (every request resolves identity); UNIQUE
  // gives it the index for free.
  idx_users_token_hash: `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash)`,
  memberships: `CREATE TABLE IF NOT EXISTS memberships (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL, PRIMARY KEY (user_id, workspace_id))`,
  entry_events: `CREATE TABLE IF NOT EXISTS entry_events (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  idx_entry_events_entry: `CREATE INDEX IF NOT EXISTS idx_entry_events_entry ON entry_events(entry_id, created_at DESC)`,
  // Immutable administration audit trail. Same contract as entry_events:
  // application code only ever INSERTs here. Consumed by Phase 4.2.
  admin_events: `CREATE TABLE IF NOT EXISTS admin_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL DEFAULT '', target_user_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  idx_admin_events_created: `CREATE INDEX IF NOT EXISTS idx_admin_events_created ON admin_events(created_at DESC)`,
  // Single-row table driving the nightly round-robin over workspaces.
  maintenance_cursor: `CREATE TABLE IF NOT EXISTS maintenance_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id TEXT NOT NULL DEFAULT '', advanced_at INTEGER NOT NULL DEFAULT 0)`,
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
  // Tenancy (v3). Defaults are the legacy single-owner semantics: '' reads as
  // "the owner's own rows" so a brain that has not been team-enabled behaves
  // identically before and after this column exists. The one-time backfill to
  // real workspace ids happens in ensureTenantBootstrap (src/lib/tenancy.ts),
  // not here — deliberately, because it rewrites every row and belongs behind
  // an explicit, memoised bootstrap rather than on the migration path.
  workspace_id: `ALTER TABLE entries ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
  actor_id: `ALTER TABLE entries ADD COLUMN actor_id TEXT NOT NULL DEFAULT ''`,
};

/**
 * Columns added to `edges` after the table shipped. Same shape and reasoning as
 * ENTRIES_COLUMNS; kept separate because the two tables migrate independently.
 */
const EDGES_COLUMNS: Record<string, string> = {
  // Denormalized from the source entry at write time so graph walks can scope by
  // workspace without joining back to entries mid-traversal.
  workspace_id: `ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
};

/**
 * Columns added to `users` after the table shipped.
 */
const USERS_COLUMNS: Record<string, string> = {
  // Per-member capture-visibility override. '' inherits the org-level
  // TEAM_DEFAULT_WORKSPACE config; "personal" and "company" pin the member.
  default_share: `ALTER TABLE users ADD COLUMN default_share TEXT NOT NULL DEFAULT ''`,
  // Soft offboarding timestamp. Identity and actor-label lookups ignore rows
  // where this is set; company entries keep actor_id as history.
  removed_at: `ALTER TABLE users ADD COLUMN removed_at INTEGER`,
  // When this member's token last resolved an identity, throttled to at most one
  // write per user per hour (see LAST_USED_THROTTLE_MS in src/lib/identity.ts).
  // Nullable and deliberately NOT backfilled, for the same reason as updated_at
  // above: there is no value to backfill it TO. "Never seen since the column
  // shipped" and "seen at some unknown time before it shipped" are the same fact
  // to every reader, and inventing a timestamp would cost one row written per
  // user to make the roster say something untrue. NULL renders as "Never used".
  last_used_at: `ALTER TABLE users ADD COLUMN last_used_at INTEGER`,
};

/**
 * Columns added to `admin_events` after the table shipped.
 *
 * The trail shipped as (id, actor_id, event, payload, created_at) and gained its two
 * subject columns a release later, so a brain that wrote a single administration event
 * before that release has the narrow table and never gets the wide one from the
 * `CREATE TABLE IF NOT EXISTS` above. Nothing surfaces that on its own: adminAuditEvent
 * (src/lib/admin-audit.ts) binds all seven columns under ctx.waitUntil and ends in
 * .catch(console.error) by contract — an audit write must never fail the administration
 * action it records — so on such a brain every INSERT fails silently and the trail simply
 * stops. The two parity tests cannot see it either; they compare db/schema.sql with this
 * file, and those agree. test/unit/schema-upgrade-completeness.test.ts is the guard that
 * can: it asks what an EXISTING database ends up with, per table.
 *
 * '' rather than NULL matches the writer, which sends '' for an event with no target
 * user (team_renamed) or no workspace (member_created), and matches what the ALTER
 * itself writes into the rows already in the trail — so an old row and a new one with
 * no subject read identically. No backfill: '' is already the right value everywhere.
 */
const ADMIN_EVENTS_COLUMNS: Record<string, string> = {
  target_user_id: `ALTER TABLE admin_events ADD COLUMN target_user_id TEXT NOT NULL DEFAULT ''`,
  workspace_id: `ALTER TABLE admin_events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
};

/**
 * Objects that can only be built once the ALTERs above have run — an index over a
 * column that arrives via ALTER. These must NOT live in SCHEMA_OBJECTS: that loop
 * runs before the ALTERs on every pass, so on an upgraded brain (table exists,
 * column missing) the CREATE would throw before the ALTER ever ran, and it would
 * throw again on every later pass. Applying them after the ALTER loops converges
 * in one pass on both fresh and upgraded brains.
 */
const POST_COLUMN_OBJECTS: Record<string, string> = {
  idx_entries_workspace_created: `CREATE INDEX IF NOT EXISTS idx_entries_workspace_created ON entries(workspace_id, created_at DESC)`,
};

/**
 * One statement that reports every schema object this file knows how to create: table and
 * index names out of sqlite_master, and entries' columns out of the table-valued form of
 * PRAGMA table_info (SQLite rewrites neither list lazily — an ALTER shows up immediately).
 * `kind` is what stops a name that appears on both sides from being read as the wrong one.
 *
 * This exists because the fifteen statements it replaces cost fifteen subrequests to
 * discover that a migrated brain — which is every brain after its first request — needs
 * nothing done (#282). Free-plan invocations get 50 subrequests, ensureDbReady spends
 * them inside the request that triggered it, and GET /graph was already close enough to
 * the ceiling that a cold isolate pushed it over: 59 against a limit of 50, now 47.
 *
 * Cost is one subrequest and one row read per catalogue entry, flat in the number of
 * entries because neither side of the UNION touches table data — measured on real D1
 * (workerd via Miniflare), not the mock, which is not something that can be re-verified
 * from a laptop. rows_read = 23 was that measurement, but it predates insight_candidates
 * and its index: it was taken when SCHEMA_OBJECTS held seven objects, not the nine it
 * holds now (plus D1's own bookkeeping table, SQLite's implicit autoindexes, and twelve
 * columns), so 23 is stale by two rows and should be re-measured against a live database
 * rather than trusted as today's figure. What the measurement did establish, and what
 * still holds regardless of the exact count: it grows by one row per object added to
 * SCHEMA_OBJECTS, which is the cheap direction — adding a statement above now costs one
 * row here rather than one subrequest on every cold start.
 */
const PROBE_SQL =
  `SELECT type AS kind, name FROM sqlite_master WHERE type IN ('table','index') ` +
  `UNION ALL SELECT 'column' AS kind, name FROM pragma_table_info('entries')` +
  `UNION ALL SELECT 'edge_column' AS kind, name FROM pragma_table_info('edges')` +
  `UNION ALL SELECT 'user_column' AS kind, name FROM pragma_table_info('users')` +
  `UNION ALL SELECT 'admin_event_column' AS kind, name FROM pragma_table_info('admin_events')`;

type ObjectKind = "table" | "index";
/**
 * `objects` maps name to kind rather than being a set of names, because SQLite puts tables
 * and indexes in one namespace: a name can be taken by the wrong kind of thing. Skipping on
 * the name alone would let a user table called `idx_entries_source` stand in for the index,
 * which resolves init successfully and silently never creates it.
 */
type ExistingSchema = { objects: Map<string, ObjectKind>; columns: Set<string>; edgeColumns: Set<string>; userColumns: Set<string>; adminEventColumns: Set<string> };

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
  const edgeColumns = new Set<string>();
  const userColumns = new Set<string>();
  const adminEventColumns = new Set<string>();
  for (const row of rows as { kind?: unknown; name?: unknown }[]) {
    if (typeof row?.name !== "string") continue;
    if (row.kind === "column") columns.add(row.name);
    else if (row.kind === "edge_column") edgeColumns.add(row.name);
    else if (row.kind === "user_column") userColumns.add(row.name);
    else if (row.kind === "admin_event_column") adminEventColumns.add(row.name);
    else if (row.kind === "table" || row.kind === "index") objects.set(row.name, row.kind);
  }
  return { objects, columns, edgeColumns, userColumns, adminEventColumns };
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
  for (const [column, ddl] of Object.entries(EDGES_COLUMNS)) {
    if (existing?.edgeColumns.has(column)) continue;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(USERS_COLUMNS)) {
    if (existing?.userColumns.has(column)) continue;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [column, ddl] of Object.entries(ADMIN_EVENTS_COLUMNS)) {
    if (existing?.adminEventColumns.has(column)) continue;
    try {
      await env.DB.exec(ddl);
    } catch (e) {
      if (!isDuplicateColumn(e)) throw e;
    }
  }
  for (const [name, ddl] of Object.entries(POST_COLUMN_OBJECTS)) {
    if (existing?.objects.get(name) === kindOf(ddl)) continue;
    await env.DB.exec(ddl);
  }
}
