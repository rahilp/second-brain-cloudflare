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
 * The schema migration in `src/db/init.ts` is the other case, and the sharper
 * one: `d1-mock`'s `exec()` is a no-op, so it cannot express "that column is
 * already there" or "that table is not" — the two facts the migration now reads
 * before it writes. Against real SQLite a probe that misreports an empty
 * database as migrated leaves the tables uncreated and the next statement fails,
 * which is exactly the regression worth catching. Pass `{ schema: false }` for a
 * database with nothing in it at all.
 *
 * Only the surface the code under test uses is implemented — `prepare`, `bind`,
 * `all`, `first`, `run`, `exec`. Reach for `d1-mock` for everything else.
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

  async all(): Promise<{ results: unknown[]; success: true; meta: { rows_written: 0 } }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    // SQLite can prove that this SELECT wrote no rows, but it cannot reproduce
    // Cloudflare D1's billed rows_read (which includes index/table work rather
    // than merely returned rows). Leave rows_read absent instead of inventing it.
    return { results: rows, success: true, meta: { rows_written: 0 } };
  }

  async first(): Promise<unknown | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return row ?? null;
  }

  /**
   * D1 returns each batched statement's ROWS as well as its meta, and a batch
   * carries reads as well as writes — identity resolution pairs its SELECT with
   * the throttled last_used_at write so the pair costs one subrequest. batch()
   * below executes statements through run(), and several tests wrap batch() with
   * their own `st.run()` loop, so a SELECT has to answer with its rows here or
   * the identity read comes back empty through every one of them.
   *
   * Additive for writes: `meta.rows_written` is unchanged, and `results` is
   * simply absent where there are no rows to report.
   */
  async run(): Promise<{ results?: unknown[]; success: true; meta: { rows_written: number } }> {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      return { results: statement.all(...(this.args as never[])), success: true, meta: { rows_written: 0 } };
    }
    const result = statement.run(...(this.args as never[]));
    return { success: true, meta: { rows_written: Number(result.changes) } };
  }
}

export interface SqliteD1 {
  /** Shaped like `env.DB`. */
  db: {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): Promise<void>;
    batch(statements: SqliteStatement[]): Promise<{ results?: unknown[]; success: true; meta: { rows_written: number } }[]>;
  };
  /**
   * One entry per D1 call made through `db` — which is one entry per subrequest,
   * since `prepare()` here is only ever followed by a single execution.
   */
  issued: string[];
  /** Column names currently on `entries`, straight from SQLite. */
  columns(): string[];
  /** Insert an entry directly, bypassing the capture pipeline. */
  seed(entry: {
    id: string;
    content: string;
    createdAt: number;
    tags?: string[];
    source?: string;
    vectorIds?: string[];
    /** Drives the compression and resurfacing rules; defaults to 0. */
    importanceScore?: number;
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
/**
 * Remove `-- …` line comments, respecting single-quoted string literals so a
 * "--" inside a default value is not mistaken for a comment.
 */
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
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // Skip to end of line, keeping the newline so line structure survives.
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

export function makeSqliteD1({ schema: applySchema = true }: { schema?: boolean } = {}): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  // The schema uses D1-flavoured DDL; execute it statement by statement so one
  // unsupported pragma cannot take the whole file down silently.
  const schema = applySchema ? readFileSync(SCHEMA, "utf8") : "";
  // Strip comments BEFORE splitting, not after. Splitting the raw file on ";"
  // and filtering comment lines out of each chunk looks equivalent but is not:
  // a ";" inside a trailing `-- comment` cuts the statement it is attached to
  // in half, and the two halves then fail to parse. Wrangler's own splitter is
  // comment-aware, so such a file migrates fine in production while silently
  // losing tables here — which is exactly how the whole `users` table (and with
  // it every tenancy test) went missing without a single red test.
  for (const statement of stripSqlComments(schema).split(";")) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      raw.exec(sql);
    } catch (e) {
      // A CREATE TABLE that does not apply leaves tests asserting against a
      // database that is missing the thing under test, so no table creation is
      // ever allowed to fail quietly. Indexes are the tolerated case: some use
      // D1-only syntax this facade does not need.
      if (/^\s*CREATE\s+TABLE\b/i.test(sql) || /\bentries\b/i.test(sql)) {
        throw new Error(`schema.sql statement failed:\n${sql}\n${String(e)}`);
      }
    }
  }

  const issued: string[] = [];

  return {
    issued,
    db: {
      prepare: (sql: string) => {
        issued.push(sql);
        return new SqliteStatement(raw, sql);
      },
      // Present so a whole-Worker request against this facade runs the real
      // initializeDatabase path rather than failing on a missing method. The
      // schema is already applied above; that DDL is idempotent, and the ALTERs
      // raise the same "duplicate column name" D1 does, which init.ts expects.
      exec: async (sql: string) => {
        issued.push(sql);
        raw.exec(sql);
      },
      // A batch is ONE subrequest whatever it carries, which is the whole reason
      // production uses it — so it must count as one entry in `issued`, or the
      // budget tests measure something the platform does not charge for.
      //
      // Callers build the statements with env.DB.prepare(), and `prepare` above
      // has already pushed one entry per statement by the time this runs. The
      // last `statements.length` entries are therefore exactly this batch's, so
      // they are replaced by the single entry the platform actually charges for.
      batch: async (statements: SqliteStatement[]) => {
        issued.splice(Math.max(0, issued.length - statements.length), statements.length, "BATCH");
        const out: { results?: unknown[]; success: true; meta: { rows_written: number } }[] = [];
        for (const statement of statements) out.push(await statement.run());
        return out;
      },
    },
    columns() {
      return (raw.prepare(`SELECT name FROM pragma_table_info('entries')`).all() as { name: string }[])
        .map(r => r.name);
    },
    seed({ id, content, createdAt, tags = [], source = "api", vectorIds = [], importanceScore = 0 }) {
      raw
        .prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, content, JSON.stringify(tags), source, createdAt, JSON.stringify(vectorIds), importanceScore);
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
