import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { runStalenessPass, STALENESS_AGE_MS, STALENESS_PASS_LIMIT } from "../../src/staleness/pass";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

describe("runStalenessPass", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("flags state entries older than threshold with stale:as-of", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job",
      content: "Alice works at Acme Corp",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const row = db.entries.find(e => e.id === "job")!;
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("volatility:state");
    expect(tags).toContain("stale:as-of");
  });

  it("does not flag durable entries", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "bday",
      content: "Birthday is March 12",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "bday")!.tags);
    expect(tags).toContain("volatility:durable");
    expect(tags).not.toContain("stale:as-of");
  });

  it("skips entries newer than STALENESS_AGE_MS", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    const recent = Date.now() - 7 * 86400000;
    db.entries.push(
      {
        id: "old-job",
        content: "Alice works at Acme Corp",
        tags: "[]",
        source: "api",
        created_at: old,
        updated_at: old,
        vector_ids: "[]",
      },
      {
        id: "recent-job",
        content: "Bob works at Beta Inc",
        tags: "[]",
        source: "api",
        created_at: recent,
        updated_at: recent,
        vector_ids: "[]",
      },
    );
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const oldTags: string[] = JSON.parse(db.entries.find(e => e.id === "old-job")!.tags);
    const recentTags: string[] = JSON.parse(db.entries.find(e => e.id === "recent-job")!.tags);
    expect(oldTags).toContain("stale:as-of");
    expect(recentTags).not.toContain("stale:as-of");
    expect(recentTags).not.toContain("volatility:state");
  });

  it(`processes at most STALENESS_PASS_LIMIT (${STALENESS_PASS_LIMIT}) entries per run`, async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 30; i++) {
      db.entries.push({
        id: `job-${i}`,
        content: `Person ${i} works at Company ${i}`,
        tags: "[]",
        source: "api",
        created_at: old + i,
        updated_at: old + i,
        vector_ids: "[]",
      });
    }
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const flagged = db.entries.filter(e => {
      const tags: string[] = JSON.parse(e.tags);
      return tags.includes("stale:as-of");
    });
    expect(flagged).toHaveLength(STALENESS_PASS_LIMIT);
    const unprocessed = db.entries.filter(e => {
      const tags: string[] = JSON.parse(e.tags);
      return !tags.includes("stale:as-of");
    });
    expect(unprocessed).toHaveLength(30 - STALENESS_PASS_LIMIT);
  });

  it("clears stale:as-of when reclassified as durable", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "bday-stale",
      content: "Birthday is March 12",
      tags: '["stale:as-of"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "bday-stale")!.tags);
    expect(tags).toContain("volatility:durable");
    expect(tags).not.toContain("stale:as-of");
  });

  it("does not overwrite existing volatility tag", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "user-vol",
      content: "Birthday is March 12",
      tags: '["volatility:volatile"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const row = db.entries.find(e => e.id === "user-vol")!;
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("volatility:volatile");
    expect(tags).not.toContain("volatility:durable");
    // The seeded tag surviving proves nothing on its own — a pass that did nothing at all
    // would satisfy that. Pin evidence that the row was actually processed and written:
    // volatile entries get flagged, and the cursor advanced.
    expect(tags).toContain("stale:as-of");
    expect(row.staleness_checked_at).toBeGreaterThan(0);
  });

  it("advances staleness_checked_at even when classification is null", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "uncertain",
      content: "Some random note without clear signals",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const row = db.entries.find(e => e.id === "uncertain")!;
    expect(row.staleness_checked_at).toBeGreaterThan(0);
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).not.toContain("volatility:state");
    expect(tags).not.toContain("stale:as-of");
  });

  it("convergence: two passes inspect more than 25 entries total", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 30; i++) {
      db.entries.push({
        id: `job-${i}`,
        content: `Person ${i} works at Company ${i}`,
        tags: "[]",
        source: "api",
        created_at: old + i,
        updated_at: old + i,
        vector_ids: "[]",
      });
    }
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);
    const afterFirst = db.entries.filter(e => e.staleness_checked_at != null).length;
    expect(afterFirst).toBe(STALENESS_PASS_LIMIT);

    await runStalenessPass(env, {} as ExecutionContext);
    const afterSecond = db.entries.filter(e => e.staleness_checked_at != null).length;
    expect(afterSecond).toBeGreaterThan(25);
  });

  it("flags volatile (task) entries with stale:as-of", async () => {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "task-entry",
      content: "Finish the quarterly report",
      tags: '["task"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "task-entry")!.tags);
    expect(tags).toContain("volatility:volatile");
    expect(tags).toContain("stale:as-of");
  });
});

// A free-plan Worker invocation gets 50 subrequests, and every D1 statement spends one.
// The nightly cron already runs several jobs against that budget, so the staleness pass
// has to be cheap or it never gets to run at all on a free deployment.
describe("runStalenessPass D1 round-trip cost", () => {
  const SUBREQUEST_BUDGET = 50;

  /**
   * `prepared` is the pass's own statements. initializeDatabase's schema probe is dropped
   * because it is not per-row cost and it is memoised across the whole invocation, so
   * counting it would make these assertions depend on whether some earlier test in the
   * file happened to warm the memo first — which is exactly what it did before this
   * filter existed. The cron budget test is where init's cost is measured.
   */
  function countingEnv(db: D1Mock) {
    const prepared: string[] = [];
    const execd: string[] = [];
    const isSchemaProbe = (sql: string) => sql.startsWith("SELECT type AS kind, name FROM sqlite_master");
    const DB = {
      prepare(sql: string) { if (!isSchemaProbe(sql)) prepared.push(sql); return db.prepare(sql); },
      exec(sql: string) { execd.push(sql); return db.exec(sql); },
      batch: (stmts: any[]) => db.batch(stmts),
    } as unknown as D1Database;
    return { env: makeTestEnv(db, { DB }), prepared, execd };
  }

  function seedAged(db: D1Mock, n: number) {
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < n; i++) {
      db.entries.push({
        id: `job-${i}`,
        content: `Person ${i} works at Company ${i}`,
        tags: "[]",
        source: "api",
        created_at: old + i,
        updated_at: old + i,
        vector_ids: "[]",
      });
    }
  }

  it("re-reads no tags it already selected", async () => {
    const db = makeTestDb();
    seedAged(db, STALENESS_PASS_LIMIT);
    const { env, prepared } = countingEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    // The candidate query already returned tags for all 25 rows; a per-row SELECT is
    // pure duplication. Optimistic concurrency is preserved by the CAS guard instead.
    expect(prepared.filter(s => s.startsWith("SELECT tags, content FROM entries WHERE id = ?"))).toEqual([]);
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(STALENESS_PASS_LIMIT);
  });

  it("spends nothing per row beyond the write it has to make", async () => {
    const db = makeTestDb();
    seedAged(db, STALENESS_PASS_LIMIT);
    const { env, prepared, execd } = countingEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    // One candidate query plus one CAS write per entry — nothing per-row on the read side.
    expect(prepared.filter(s => s.includes("COALESCE(updated_at, created_at) <"))).toHaveLength(1);
    expect(prepared.filter(s => s.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")))
      .toHaveLength(STALENESS_PASS_LIMIT);
    // The pass's own cost: 1 candidate query + 25 CAS writes. Schema init is not counted
    // here — countingEnv drops its probe and its DDL is memoised across the whole
    // invocation. See the cron budget test in test/unit/cron-subrequest-budget.test.ts,
    // which is where the 50 actually binds.
    expect(prepared).toHaveLength(STALENESS_PASS_LIMIT + 1);
    expect(execd.length).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
  });

  // The classification is derived from content, but the tag mutation is a no-op for an
  // entry carrying neither a volatility: nor a stale:as-of tag — the common case. Without
  // content in the CAS guard, a concurrent rewrite would leave tags identical, the CAS
  // would succeed, and the pass would commit a verdict about content that no longer
  // exists. It does not self-correct: the concurrent write bumps updated_at past the
  // 90-day cutoff, so the row drops out of future passes still wrongly flagged.
  it("does not flag an entry whose content was rewritten mid-pass", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "rewritten",
      content: "Alice works at Acme Corp", // volatility:state — would be flagged stale
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const { env } = countingEnv(db);
    const original = db.prepare.bind(db);
    let rewritten = false;
    (db as any).prepare = (sql: string) => {
      // Land the concurrent rewrite between the candidate query and the CAS write.
      if (!rewritten && sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        rewritten = true;
        db.entries[0].content = "Birthday is March 12"; // now durable
        db.entries[0].updated_at = Date.now();
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).not.toContain("stale:as-of");
    expect(tags).not.toContain("volatility:state");
    // The retry re-read the fresh content and classified that instead.
    expect(tags).toContain("volatility:durable");
  });

  it("re-reads both fields when content and tags change together mid-pass", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "both",
      content: "Alice works at Acme Corp",
      tags: '["work"]',
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const { env } = countingEnv(db);
    const original = db.prepare.bind(db);
    let raced = false;
    (db as any).prepare = (sql: string) => {
      if (!raced && sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        raced = true;
        db.entries[0].content = "Birthday is March 12";
        db.entries[0].tags = '["personal"]';
        db.entries[0].updated_at = Date.now();
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("personal");       // the concurrent tag write survived
    expect(tags).not.toContain("work");       // and was not clobbered by the stale snapshot
    expect(tags).toContain("volatility:durable");
    expect(tags).not.toContain("stale:as-of");
  });

  // The candidate query orders by COALESCE(staleness_checked_at, 0) ASC, so a row left
  // with a NULL cursor sorts first on every subsequent pass — permanently occupying one
  // of the 25 slots. A row that loses every CAS attempt must still have its cursor moved.
  it("advances the cursor even when every CAS attempt is lost", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "hot",
      content: "Alice works at Acme Corp",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const { env } = countingEnv(db);
    const original = db.prepare.bind(db);
    let rewrites = 0;
    (db as any).prepare = (sql: string) => {
      // Rewrite before every attempt, so no CAS can ever land.
      if (sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        db.entries[0].content = `rewritten ${++rewrites}`;
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    expect(rewrites).toBeGreaterThanOrEqual(3); // all attempts consumed
    expect(db.entries[0].staleness_checked_at).toBeGreaterThan(0);
  });

  it("still re-reads tags when a concurrent write makes the CAS lose", async () => {
    const db = makeTestDb();
    seedAged(db, 1);
    const { env, prepared } = countingEnv(db);
    // Flip the row's tags out from under the pass on the first CAS attempt, exactly as a
    // concurrent writer would. The retry must go back to the database for fresh tags.
    const original = db.prepare.bind(db);
    let flipped = false;
    (db as any).prepare = (sql: string) => {
      if (!flipped && sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        flipped = true;
        db.entries[0].tags = '["touched-by-someone-else"]';
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    expect(prepared.filter(s => s.startsWith("SELECT tags, content FROM entries WHERE id = ?"))).toHaveLength(1);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("touched-by-someone-else"); // retry built on the fresh tags
    expect(tags).toContain("stale:as-of");
  });
});

describe("scheduled handler staleness wiring", () => {
  it("runs staleness pass alongside other nightly jobs", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job",
      content: "Bob works at Example Inc",
      tags: "[]",
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const env = makeTestEnv(db, { VECTORIZE: { query: vi.fn(), getByIds: vi.fn(), upsert: vi.fn(), insert: vi.fn(), deleteByIds: vi.fn() } as any });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;

    await (worker as any).scheduled({} as any, env, ctx);
    await Promise.allSettled(pending);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
    expect(tags).toContain("stale:as-of");
  });
});
