/**
 * A D1 facade over real SQLite, for tests whose subject is the SQL itself.
 *
 * `test/helpers/d1-mock.ts` matches query strings and returns canned rows. That
 * is the right tool for most tests — it is fast and it keeps fixtures obvious —
 * but it cannot evaluate SQL, so anything whose correctness *is* the query is
 * untestable against it. The embedding migration is exactly that: a keyset
 * cursor whose comparison decides whether entries are skipped or repeated, and
 * an aggregate that projects chunk counts with integer division.
 *
 * D1 is SQLite, and `node:sqlite` ships with Node, so those queries can be run
 * for real against the project's own `db/schema.sql`. A wrong comparison then
 * fails the test instead of passing a string match.
 *
 * Only the surface the code under test uses is implemented — `prepare`, `bind`,
 * `all`, `first`, `run`. Reach for `d1-mock` for everything else.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = resolve(import.meta.dirname, "../../db/schema.sql");

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, args);
  }

  async all(): Promise<{ results: unknown[]; success: true }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    return { results: rows, success: true };
  }

  async first(): Promise<unknown | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return row ?? null;
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true };
  }
}

export interface SqliteD1 {
  /** Shaped like `env.DB`. */
  db: { prepare(sql: string): SqliteStatement; exec(sql: string): Promise<void> };
  /** Insert an entry directly, bypassing the capture pipeline. */
  seed(entry: {
    id: string;
    content: string;
    createdAt: number;
    tags?: string[];
    source?: string;
    vectorIds?: string[];
  }): void;
  /** Every row, for assertions about what the code under test wrote. */
  rows(): Record<string, unknown>[];
  close(): void;
}

/**
 * A fresh in-memory database with the project's real schema applied.
 *
 * Using the shipped schema rather than a hand-written CREATE TABLE means a
 * column rename breaks these tests, which is the point — the migration's SQL
 * names columns.
 */
export function makeSqliteD1(): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  // The schema uses D1-flavoured DDL; execute it statement by statement so one
  // unsupported pragma cannot take the whole file down silently.
  const schema = readFileSync(SCHEMA, "utf8");
  for (const statement of schema.split(";")) {
    // Strip comment lines rather than skipping any chunk that starts with one:
    // splitting on ";" leaves the preceding comment attached to the statement
    // after it, so a "starts with --" test silently drops real DDL.
    const sql = statement
      .split("\n")
      .filter(line => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (!sql) continue;
    try {
      raw.exec(sql);
    } catch (e) {
      // Indexes on tables this facade does not need, or D1-only syntax. Fail
      // loudly for anything touching `entries`, which the migration reads.
      if (/\bentries\b/i.test(sql)) {
        throw new Error(`schema.sql statement failed:\n${sql}\n${String(e)}`);
      }
    }
  }

  return {
    db: {
      prepare: (sql: string) => new SqliteStatement(raw, sql),
      // Present so a whole-Worker request against this facade runs the real
      // initializeDatabase path rather than failing on a missing method. The
      // schema is already applied above; that DDL is idempotent, and the ALTERs
      // raise the same "duplicate column name" D1 does, which init.ts expects.
      exec: async (sql: string) => { raw.exec(sql); },
    },
    seed({ id, content, createdAt, tags = [], source = "api", vectorIds = [] }) {
      raw
        .prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
        )
        .run(id, content, JSON.stringify(tags), source, createdAt, JSON.stringify(vectorIds));
    },
    rows() {
      return raw
        .prepare(`SELECT * FROM entries ORDER BY created_at ASC, id ASC`)
        .all() as Record<string, unknown>[];
    },
    close() {
      raw.close();
    },
  };
}
