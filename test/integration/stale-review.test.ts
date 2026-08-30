/**
 * The out-of-date review queue.
 *
 * Home shows a chip reading "N may be out of date". Clicking it used to fire a
 * free-text recall for the phrase "What might be out of date?", which is a
 * vector search over the whole brain and can only return the flagged entries by
 * coincidence — on a real brain it returned two memories that merely contained
 * the words, and neither was the one the count referred to. The count comes from
 * an exact tag predicate, so the entries behind it are knowable exactly.
 *
 * Real SQLite rather than the SQL-matching mock, for the same reason the insight
 * queue's tests use it: this endpoint IS a WHERE clause, and a mock that matches
 * queries by substring cannot tell a correct predicate from a broken one.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
      // Each statement's rows are kept, not discarded: a batch carries reads as
      // well as writes now — identity resolution pairs its SELECT with the
      // throttled last_used_at stamp so the pair costs one subrequest — and D1
      // returns a result per statement. `changes: 1` is preserved for the write
      // paths that read it.
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1): Env => makeTestEnv(dbOf(s) as any);

function seedStale(s: SqliteD1, id: string, content: string, extraTags: string[] = []) {
  s.seed({ id, content, createdAt: 1000, tags: ["work", "stale:as-of", ...extraTags], source: "claude-desktop", vectorIds: [id] });
}

describe("GET /stale", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/stale", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("returns the flagged entries and nothing else", async () => {
    sq = await migrated();
    seedStale(sq, "old-1", "Our deploy target is the staging cluster");
    sq.seed({ id: "fresh", content: "A memory nobody has flagged", createdAt: 1000, tags: ["work"] });

    const data = await (await worker.fetch(req("GET", "/stale"), envOf(sq), ctx)).json() as any;

    expect(data.ok).toBe(true);
    expect(data.entries.map((e: any) => e.id)).toEqual(["old-1"]);
    expect(data.total).toBe(1);
  });

  it("carries the content and dates a reviewer needs to rule on it", async () => {
    // A review queue that shows only ids is a list of homework. The reviewer has
    // to be able to read the claim and see how old it is without a second fetch.
    sq = await migrated();
    seedStale(sq, "old-1", "Our deploy target is the staging cluster");

    const data = await (await worker.fetch(req("GET", "/stale"), envOf(sq), ctx)).json() as any;

    const entry = data.entries[0];
    expect(entry.content).toBe("Our deploy target is the staging cluster");
    expect(entry.created_at).toBe(1000);
    expect(entry).toHaveProperty("last_updated");
    expect(entry.tags).toContain("stale:as-of");
  });

  it("leaves a deprecated entry out of the queue", async () => {
    // Deprecated means retired from recall. Asking someone to re-verify a memory
    // that is already out of circulation is make-work.
    sq = await migrated();
    seedStale(sq, "retired", "Superseded long ago", ["status:deprecated"]);

    const data = await (await worker.fetch(req("GET", "/stale"), envOf(sq), ctx)).json() as any;

    expect(data.entries).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("counts the whole queue, not the page", async () => {
    sq = await migrated();
    for (let i = 0; i < 30; i++) seedStale(sq, `s${i}`, `Claim ${i}`);

    const data = await (await worker.fetch(req("GET", "/stale?limit=10"), envOf(sq), ctx)).json() as any;

    expect(data.entries).toHaveLength(10);
    expect(data.total).toBe(30);
  });

  // The chip on home and the queue behind it are two readings of one fact. If
  // they disagree the user is told a number and then shown a different one,
  // which is the failure this whole endpoint exists to end. They share a
  // predicate so they cannot drift; this is the test that says so.
  it("agrees with the count home puts on the chip", async () => {
    sq = await migrated();
    seedStale(sq, "live-1", "A claim that needs re-checking");
    seedStale(sq, "live-2", "Another claim that needs re-checking");
    seedStale(sq, "retired", "Already out of circulation", ["status:deprecated"]);
    sq.seed({ id: "fresh", content: "Never flagged", createdAt: 1000, tags: ["work"] });

    const brief = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    const queue = await (await worker.fetch(req("GET", "/stale"), envOf(sq), ctx)).json() as any;

    expect(brief.attention.stale).toBe(queue.total);
    expect(queue.entries).toHaveLength(brief.attention.stale);
  });

  it("pages without repeating or skipping", async () => {
    sq = await migrated();
    for (let i = 0; i < 25; i++) seedStale(sq, `s${i}`, `Claim ${i}`);

    const first = await (await worker.fetch(req("GET", "/stale?limit=10&offset=0"), envOf(sq), ctx)).json() as any;
    const second = await (await worker.fetch(req("GET", "/stale?limit=10&offset=10"), envOf(sq), ctx)).json() as any;

    const ids = [...first.entries, ...second.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(20);
  });
});

describe("POST /stale/keep", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/stale/keep", { token: null, body: { id: "x" } }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("clears stale:as-of without changing content", async () => {
    sq = await migrated();
    seedStale(sq, "old-1", "Our deploy target is the staging cluster");

    const res = await worker.fetch(req("POST", "/stale/keep", { body: { id: "old-1" } }), envOf(sq), ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    const row = (await sq.db.prepare(
      `SELECT content, tags, updated_at, staleness_checked_at FROM entries WHERE id = ?`,
    ).bind("old-1").first()) as any;
    expect(row.content).toBe("Our deploy target is the staging cluster");
    expect(JSON.parse(row.tags)).not.toContain("stale:as-of");
    expect(row.updated_at).toBeTypeOf("number");
    expect(row.staleness_checked_at).toBeTypeOf("number");

    const queue = await (await worker.fetch(req("GET", "/stale"), envOf(sq), ctx)).json() as any;
    expect(queue.total).toBe(0);
  });

  it("refuses an entry that is not flagged", async () => {
    sq = await migrated();
    sq.seed({ id: "fresh", content: "Never flagged", createdAt: 1000, tags: ["work"] });

    const res = await worker.fetch(req("POST", "/stale/keep", { body: { id: "fresh" } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });
});
