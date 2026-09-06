/**
 * The guard the schema-parity tests structurally cannot be.
 *
 * test/unit/db-init.test.ts and test/integration/graph-read-budget.test.ts both
 * compare `db/schema.sql` against `src/db/init.ts`. Those two agreeing says
 * nothing about the database an upgraded brain is actually running: schema.sql
 * only ever runs against a fresh install (`npm run db:migrate`), and init.ts's
 * `CREATE TABLE IF NOT EXISTS` is a no-op the moment the table exists. A column
 * added to a table that already shipped therefore reaches every NEW brain and no
 * EXISTING one, and both declarations agree the whole time. That is how
 * admin_events lost target_user_id and workspace_id on a live brain while every
 * parity test stayed green.
 *
 * So this asks the only question that distinguishes the two: take a database
 * carrying an EARLIER version of a table, run the real initialisation against
 * it, and require that every column db/schema.sql declares today is there
 * afterwards — and that a write binding all of them lands.
 *
 * The legacy shapes below are frozen historical DDL, deliberately not derived
 * from schema.sql. Deriving them would make this test vacuous: a newly added
 * column would appear in the "old" table too and there would be nothing to
 * migrate. Frozen, a column added to schema.sql without a matching entry in
 * init.ts's ALTER maps fails here on the next run, which is the whole point.
 * Adding a TABLE fails the coverage test until its shape is recorded here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

/**
 * Every table shape a brain could have been created with before the columns it
 * carries today existed, keyed by table.
 *
 * Where a table has never gained a column its entry is simply today's shape —
 * which is not filler: it is what makes the FIRST column added to that table
 * fail here rather than silently only reaching new brains.
 */
const LEGACY_SHAPES: Record<string, string> = {
  // v1. Everything after vector_ids arrived by ALTER.
  entries: `CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`,
  // Issue #16, before v3 denormalised the workspace onto each edge.
  edges: `CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_id, target_id, type))`,
  // Never widened since it shipped.
  insight_candidates: `CREATE TABLE insight_candidates (id TEXT PRIMARY KEY, a_id TEXT NOT NULL, b_id TEXT NOT NULL, similarity REAL NOT NULL, gap_ms INTEGER NOT NULL, score REAL NOT NULL, signal TEXT NOT NULL DEFAULT 'vector', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(a_id, b_id))`,
  workspaces: `CREATE TABLE workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'personal', name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  // v3 as first provisioned: default_share, removed_at and last_used_at all
  // arrived afterwards, against team brains that already had members in them.
  users: `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  memberships: `CREATE TABLE memberships (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL, PRIMARY KEY (user_id, workspace_id))`,
  entry_events: `CREATE TABLE entry_events (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  // The regression this file exists for: shipped with five columns, gained
  // target_user_id and workspace_id a release later.
  admin_events: `CREATE TABLE admin_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL DEFAULT '', event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)`,
  maintenance_cursor: `CREATE TABLE maintenance_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id TEXT NOT NULL DEFAULT '', advanced_at INTEGER NOT NULL DEFAULT 0)`,
};

/** `-- …` line comments, without mistaking a "--" inside a string literal for one. */
function stripSqlComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Table-level constraints, which sit in the column list but are not columns. */
const CONSTRAINT_KEYWORDS = new Set(["primary", "unique", "check", "foreign", "constraint"]);

/** Column name -> declared type, per table, as db/schema.sql declares them today. */
function declaredTables(sql: string): Record<string, Record<string, string>> {
  const tables: Record<string, Record<string, string>> = {};
  for (const match of stripSqlComments(sql).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
    const [, table, body] = match;
    const columns: Record<string, string> = {};
    let depth = 0;
    let current = "";
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const [name, type] = part.trim().split(/\s+/);
      // `UNIQUE(a, b)` has no space before its paren, so split on it too — the
      // first token of a table constraint has to be recognised as a keyword
      // rather than taken for a column called `UNIQUE(a,`.
      if (!name || CONSTRAINT_KEYWORDS.has(name.split("(")[0].toLowerCase())) continue;
      columns[name] = (type ?? "TEXT").toUpperCase();
    }
    tables[table] = columns;
  }
  return tables;
}

const DECLARED = declaredTables(readFileSync(resolve(import.meta.dirname, "../../db/schema.sql"), "utf8"));

/** A value SQLite will accept for a column of this declared type. */
const sampleFor = (type: string, index: number): string | number =>
  type.startsWith("INT") ? index : type.startsWith("REAL") ? 0.5 : `v${index}`;

describe("an existing database gains every column db/schema.sql declares", () => {
  let d1: SqliteD1;
  const envFor = (sqlite: SqliteD1) => makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });

  beforeEach(resetDatabaseInit);
  afterEach(() => { d1?.close(); });

  it("has a recorded earlier shape for every table schema.sql declares", () => {
    // A new table with no entry here would otherwise be exempt from the whole
    // guard the moment it gains its first column.
    expect(Object.keys(LEGACY_SHAPES).sort()).toEqual(Object.keys(DECLARED).sort());
  });

  for (const [table, legacyDdl] of Object.entries(LEGACY_SHAPES)) {
    it(`migrates a pre-existing ${table} to today's columns without losing its rows`, async () => {
      const declared = DECLARED[table];
      // Guards the fixture itself: a legacy shape naming a column the table no
      // longer declares means one was renamed or dropped, and this test would
      // otherwise be asserting against a table nothing in production has.
      const legacyColumns = Object.keys(declaredTables(`${legacyDdl.replace(/\)$/, "\n);")}`)[table]);
      expect(declared).toBeDefined();
      expect(legacyColumns.filter(c => !(c in declared))).toEqual([]);

      d1 = makeSqliteD1({ schema: false });
      await d1.db.exec(legacyDdl);
      // One row written by the release that shipped this shape. It must survive,
      // and it must be readable through the columns the table gains.
      const legacyValues = legacyColumns.map((c, i) => sampleFor(declared[c], i + 1));
      await d1.db
        .prepare(`INSERT INTO ${table} (${legacyColumns.join(", ")}) VALUES (${legacyColumns.map(() => "?").join(", ")})`)
        .bind(...legacyValues)
        .run();

      await initializeDatabase(envFor(d1));

      const after = ((await d1.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all())
        .results as { name: string }[]).map(c => c.name);
      const missing = Object.keys(declared).filter(c => !after.includes(c));
      // The message names the fix: an ALTER map entry in src/db/init.ts, not a
      // wider CREATE, which an existing table never reaches.
      expect(missing, `${table} is missing ${missing.join(", ")} after init — db/schema.sql declares ${
        Object.keys(declared).length} columns but src/db/init.ts has no ALTER TABLE ${table} ADD COLUMN for these, so only fresh brains get them`).toEqual([]);

      // Not backfilled and not rewritten: the legacy row is still exactly what
      // the earlier release wrote.
      const row = await d1.db.prepare(`SELECT ${legacyColumns.join(", ")} FROM ${table}`).first() as Record<string, unknown>;
      expect(row).toEqual(Object.fromEntries(legacyColumns.map((c, i) => [c, legacyValues[i]])));

      // Existence of the columns is the mechanism; a write that binds all of
      // them is the behaviour every caller depends on. OR REPLACE only so the
      // fixture row's key constraints do not decide the outcome.
      const columns = Object.keys(declared);
      await expect(
        d1.db
          .prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .bind(...columns.map((c, i) => (table === "maintenance_cursor" && c === "id" ? 1 : sampleFor(declared[c], i + 100))))
          .run(),
      ).resolves.toMatchObject({ success: true });
    });
  }
});
