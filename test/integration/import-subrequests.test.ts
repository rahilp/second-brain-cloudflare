/**
 * Pins /import's D1 subrequest cost per invocation, driven against real SQLite.
 *
 * The endpoint exists to migrate a brain, and most brains run on the D1 free plan,
 * which allows roughly 50 queries per Worker invocation. The paging design holds
 * the per-call cost flat — one chunked existence lookup plus one insert batch per
 * page, regardless of file size or how far in the cursor is. An earlier version
 * resolved ids lazily, one query per entry and two per edge, which spent the whole
 * budget partway through a real restore (measured: 201 round trips for page 5 of a
 * 5,000-entry export). These tests are what keeps that from coming back.
 *
 * Counting: `issued` logs one entry per D1 call; the batch shim below collapses a
 * batch's statements into one entry, because DB.batch() is one subrequest in
 * production however many statements it carries.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { importExportPayload, IMPORT_DEFAULT_LIMIT } from "../../src/entries/import";
import type { Env } from "../../src/env";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function envOf(s: SqliteD1): Env {
  return {
    DB: {
      prepare: (sql: string) => s.db.prepare(sql),
      exec: (sql: string) => s.db.exec(sql),
      async batch(stmts: { run(): Promise<unknown> }[]) {
        for (const st of stmts) await st.run();
        // The helper logs at prepare() time, so the batch's statements are the log's
        // tail by the time this runs — collapse them into the one subrequest they are.
        s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;
}

/** Fresh DB with the runtime ALTERs applied, subrequest log cleared. */
async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase(envOf(s));
  s.issued.length = 0;
  return s;
}

const entry = (i: number) => ({
  id: `id-${i}`,
  content: `content ${i}`,
  created_at: 1_700_000_000_000 + i,
});

describe("/import subrequest budget (D1 free plan: ~50 per invocation)", () => {
  it("a fresh default page costs one lookup and one batch", async () => {
    sq = await migrated();
    const entries = Array.from({ length: IMPORT_DEFAULT_LIMIT }, (_, i) => entry(i));
    const summary = await importExportPayload(envOf(sq), { entries }, {});

    expect(summary.imported).toBe(IMPORT_DEFAULT_LIMIT);
    expect(sq.rows()).toHaveLength(IMPORT_DEFAULT_LIMIT);
    // 1 existence lookup (40 ids, one chunk) + 1 insert batch.
    expect(sq.issued).toHaveLength(2);
  });

  it("a late page of a large export costs the same as the first page", async () => {
    sq = await migrated();
    for (let i = 0; i < 160; i++) {
      sq.seed({ id: `id-${i}`, content: `content ${i}`, createdAt: 1_700_000_000_000 + i });
    }
    sq.issued.length = 0;

    const entries = Array.from({ length: 5000 }, (_, i) => entry(i));
    const summary = await importExportPayload(envOf(sq), { entries }, { offset: 160 });

    expect(summary.imported).toBe(IMPORT_DEFAULT_LIMIT);
    expect(summary.next_offset).toBe(200);
    expect(summary.remaining_entries).toBe(4800);
    expect(sq.rows()).toHaveLength(200);
    // Position in the file must not change the price: still 1 lookup + 1 batch.
    expect(sq.issued).toHaveLength(2);
  });

  it("an edges-only page stays in single digits", async () => {
    sq = await migrated();
    for (let i = 0; i < 41; i++) {
      sq.seed({ id: `id-${i}`, content: `content ${i}`, createdAt: 1_700_000_000_000 + i });
    }
    sq.issued.length = 0;

    const edges = Array.from({ length: 40 }, (_, i) => ({
      source_id: `id-${i}`,
      target_id: `id-${i + 1}`,
      type: "relates_to",
    }));
    const summary = await importExportPayload(envOf(sq), { entries: [], edges }, {});

    expect(summary.edges_imported).toBe(40);
    // 1 endpoint lookup (41 distinct ids, one chunk) + 1 edge-key lookup (41
    // endpoints double-bound, one chunk of 50) + 1 insert batch.
    expect(sq.issued).toHaveLength(3);
  });

  it("a rerun of an already-imported page is one lookup and no writes", async () => {
    sq = await migrated();
    const entries = Array.from({ length: IMPORT_DEFAULT_LIMIT }, (_, i) => entry(i));
    await importExportPayload(envOf(sq), { entries }, {});
    sq.issued.length = 0;

    const summary = await importExportPayload(envOf(sq), { entries }, {});
    expect(summary.skipped).toBe(IMPORT_DEFAULT_LIMIT);
    expect(summary.imported).toBe(0);
    expect(sq.issued).toHaveLength(1);
  });
});

describe("/import on a freshly deployed brain", () => {
  it("succeeds as the first request ever, before ensureDbReady's background init lands", async () => {
    // schema.sql only — the updated_at ALTER has not run, which is every new brain's
    // state when its first request arrives. The route awaits initializeDatabase
    // itself; leaning on ensureDbReady's waitUntil means racing it, and losing
    // fails every insert with "table entries has no column named updated_at".
    //
    // setDbReady(true) keeps ensureDbReady from firing its background init at all.
    // Against synchronous SQLite that init always wins the race, which would let a
    // route that forgot its own await pass here while losing in production, where
    // D1 calls take real time.
    sq = makeSqliteD1();
    resetDatabaseInit();
    setDbReady(true);
    const env = makeTestEnv(envOf(sq).DB as any);
    const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

    const res = await worker.fetch(req("POST", "/import", {
      body: { version: 2, entries: [{ id: "first", content: "First ever request", created_at: 1000 }] },
    }), env, ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.imported).toBe(1);
    expect(data.failed).toBe(0);
    expect(sq.rows()).toHaveLength(1);
    expect(sq.columns()).toContain("updated_at");
  });
});
