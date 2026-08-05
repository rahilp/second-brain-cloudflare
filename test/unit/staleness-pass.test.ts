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

// A free-plan Worker invocation gets 50 subrequests, and the nightly cron already runs
// several jobs against that budget, so the staleness pass has to be cheap or it never gets
// to run at all on a free deployment.
//
// What D1 bills is EXECUTIONS, not prepares: run/first/all/exec spend one each, and a
// batch() spends one however many statements it carries. `billed` counts it that way —
// counting prepares would price a batch as if it were still one write per row.
describe("runStalenessPass D1 round-trip cost", () => {
  const SUBREQUEST_BUDGET = 50;

  /**
   * `prepared` is the pass's own statements. initializeDatabase's schema probe is dropped
   * because it is not per-row cost and it is memoised across the whole invocation, so
   * counting it would make these assertions depend on whether some earlier test in the
   * file happened to warm the memo first. The cron budget test is where init's cost lives.
   */
  function countingEnv(db: D1Mock, overrides: Partial<D1Database> = {}) {
    const prepared: string[] = [];
    const execd: string[] = [];
    const isSchemaProbe = (sql: string) => sql.startsWith("SELECT type AS kind, name FROM sqlite_master");
    const billed = { run: 0, first: 0, all: 0, exec: 0, batch: 0, batched: [] as number[],
      get total() { return this.run + this.first + this.all + this.exec + this.batch; } };
    const wrap = (stmt: any): any => ({
      bind: (...a: any[]) => wrap(stmt.bind(...a)),
      run: () => { billed.run++; return stmt.run(); },
      first: (...a: any[]) => { billed.first++; return stmt.first(...a); },
      all: () => { billed.all++; return stmt.all(); },
      __inner: stmt,
    });
    const DB = {
      prepare(sql: string) { if (!isSchemaProbe(sql)) prepared.push(sql); return wrap(db.prepare(sql)); },
      exec(sql: string) { billed.exec++; execd.push(sql); return db.exec(sql); },
      batch: (stmts: any[]) => {
        billed.batch++;
        billed.batched.push(stmts.length);
        return db.batch(stmts.map((s: any) => s.__inner ?? s));
      },
      ...overrides,
    } as unknown as D1Database;
    return { env: makeTestEnv(db, { DB }), prepared, execd, billed };
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

  it("re-reads no row it already selected", async () => {
    const db = makeTestDb();
    seedAged(db, STALENESS_PASS_LIMIT);
    const { env, prepared } = countingEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    // The candidate query already returned tags and content for all 25 rows; re-reading
    // any of them is pure duplication. Optimistic concurrency is preserved by the CAS
    // guard instead, and the retry re-read below only fires for rows that actually lost.
    expect(prepared.filter(s => s.startsWith("SELECT id, tags, content FROM entries WHERE id IN"))).toEqual([]);
    expect(prepared.filter(s => s.includes("FROM entries WHERE id = ?"))).toEqual([]);
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(STALENESS_PASS_LIMIT);
  });

  it("spends one subrequest on the whole write set, not one per row", async () => {
    const db = makeTestDb();
    seedAged(db, STALENESS_PASS_LIMIT);
    const { env, prepared, billed } = countingEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    // One candidate query plus one batch carrying every CAS — nothing per-row on either
    // side. The DDL is not counted here because it is memoised across the whole
    // invocation; see test/unit/cron-subrequest-budget.test.ts, where the 50 actually binds.
    expect(prepared.filter(s => s.includes("COALESCE(updated_at, created_at) <"))).toHaveLength(1);
    expect(billed.batched).toEqual([STALENESS_PASS_LIMIT]);
    expect(billed.run).toBe(0);
    expect(billed.total).toBe(2);
    expect(billed.total).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(STALENESS_PASS_LIMIT);
  });

  // batch() is atomic on D1, so a losing CAS must not look like a failure: it comes back
  // as changes: 0 with the rest of the batch committed (verified against workerd). What
  // this pins is the code's half of that contract — that per-statement results are mapped
  // back to the right rows, so only the loser is retried and the winners are left alone.
  it("retries only the row whose CAS lost, not the batch", async () => {
    const db = makeTestDb();
    seedAged(db, 5);
    const { env, prepared, billed } = countingEnv(db);
    const original = db.prepare.bind(db);
    let flipped = false;
    (db as any).prepare = (sql: string) => {
      if (!flipped && sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        flipped = true; // only job-0's guard is invalidated
        db.entries[0].tags = '["touched-by-someone-else"]';
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    expect(prepared.filter(s => s.startsWith("SELECT id, tags, content FROM entries WHERE id IN"))).toHaveLength(1);
    expect(billed.batched).toEqual([5, 1]); // the retry batch carries the loser alone
    for (const row of db.entries) {
      const tags: string[] = JSON.parse(row.tags);
      expect(tags).toContain("stale:as-of");
      expect(row.staleness_checked_at).toBeGreaterThan(0);
    }
    expect(JSON.parse(db.entries[0].tags)).toContain("touched-by-someone-else");
  });

  // A genuine SQL error rolls the whole batch back, so every row in it would keep a NULL
  // cursor and camp the front of the next run's queue. Degrade to the per-row writes this
  // replaced rather than lose the run.
  it("falls back to per-row writes when the batch is rejected", async () => {
    const db = makeTestDb();
    seedAged(db, 3);
    let batches = 0;
    const { env, billed } = countingEnv(db, {
      // Reject without applying anything, the way an atomic batch fails.
      batch: (async () => { batches++; throw new Error("D1_ERROR: no such column"); }) as any,
    });

    await runStalenessPass(env, {} as ExecutionContext);

    expect(batches).toBe(1);
    expect(billed.run).toBe(3); // one write per row, exactly as before the batching
    for (const row of db.entries) {
      expect(JSON.parse(row.tags)).toContain("stale:as-of");
      expect(row.staleness_checked_at).toBeGreaterThan(0);
    }
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

  // Nothing below strands a row: a row the pass could not settle still leaves the front of
  // the queue, so a later run gets to it. The failure mode this guards against is a row
  // that quietly holds one of the 25 slots forever.
  it("advances the cursor for a row whose tags cannot be classified", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "corrupt",
      content: "Alice works at Acme Corp",
      tags: '"not-an-array"', // parses, but not into anything classify can walk
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    const { env } = countingEnv(db);

    await runStalenessPass(env, {} as ExecutionContext);

    expect(db.entries[0].tags).toBe('"not-an-array"'); // untouched — no verdict was invented
    expect(db.entries[0].staleness_checked_at).toBeGreaterThan(0);
  });

  it("advances the cursor when the retry re-read fails", async () => {
    const db = makeTestDb();
    seedAged(db, 1);
    const { env } = countingEnv(db);
    const original = db.prepare.bind(db);
    let flipped = false;
    (db as any).prepare = (sql: string) => {
      if (sql.startsWith("SELECT id, tags, content FROM entries WHERE id IN")) {
        return { bind: () => ({ all: async () => { throw new Error("D1_ERROR: connection lost"); } }) };
      }
      if (!flipped && sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        flipped = true;
        db.entries[0].tags = '["touched-by-someone-else"]';
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    expect(db.entries[0].staleness_checked_at).toBeGreaterThan(0);
  });

  it("advances the cursor for a row whose write fails on the fallback path too", async () => {
    const db = makeTestDb();
    seedAged(db, 3);
    const original = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const stmt = original(sql);
      const isCas = sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?");
      const isCursor = sql.startsWith("UPDATE entries SET staleness_checked_at = ?");
      if (!isCas && !isCursor) return stmt;
      return {
        bind: (...args: any[]) => {
          const bound = stmt.bind(...args);
          // The two statements bind the id in different positions — casWrite is
          // (tags, now, id, …) and cursorWrite is (now, id) — so a single index would
          // silently miss one of them and leave this test looking like coverage it is not.
          const id = isCas ? args[2] : args[1];
          // Only job-1's CAS ever fails. Its cursor write is deliberately left working,
          // because the guarantee under test is that the cursor still lands when the
          // verdict cannot; the test below covers a cursor write that fails.
          if (!isCas || id !== "job-1") return bound;
          return { ...bound, run: async () => { throw new Error("D1_ERROR: write failed"); } };
        },
      };
    };
    const { env } = countingEnv(db, {
      batch: (async () => { throw new Error("D1_ERROR: batch rejected"); }) as any,
    });

    await runStalenessPass(env, {} as ExecutionContext);

    const byId = (id: string) => db.entries.find(e => e.id === id)!;
    expect(JSON.parse(byId("job-0").tags)).toContain("stale:as-of");
    expect(JSON.parse(byId("job-2").tags)).toContain("stale:as-of");
    expect(JSON.parse(byId("job-1").tags)).not.toContain("stale:as-of"); // never settled
    for (const id of ["job-0", "job-1", "job-2"]) {
      expect(byId(id).staleness_checked_at).toBeGreaterThan(0); // but not stranded either
    }
  });

  // A row that short-circuits to a cursor advance — deprecated, or unparseable tags — has
  // no CAS to lose, so it never enters the retry set. That makes the failure of its one
  // write the only thing standing between it and a permanently NULL cursor, which would
  // put it first in every future candidate query forever. One transient failure is enough
  // to cause it: everything after the first batch here succeeds.
  it("advances the cursor for a non-retryable row whose first write fails", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "corrupt",
      content: "Alice works at Acme Corp",
      tags: '"not-an-array"', // parses, but not into anything classify can walk
      source: "api",
      created_at: old,
      updated_at: old,
      vector_ids: "[]",
    });
    let writeAttempts = 0;
    const original = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const stmt = original(sql);
      if (!sql.startsWith("UPDATE entries SET staleness_checked_at = ?")) return stmt;
      return {
        bind: (...args: any[]) => {
          const bound = stmt.bind(...args);
          return {
            ...bound,
            run: async () => {
              if (writeAttempts++ === 0) throw new Error("D1_ERROR: transient");
              return bound.run();
            },
          };
        },
      };
    };
    let batches = 0;
    const { env } = countingEnv(db, {
      batch: (async (stmts: any[]) => {
        if (batches++ === 0) throw new Error("D1_ERROR: batch rejected");
        return db.batch(stmts.map((s: any) => s.__inner ?? s));
      }) as any,
    });

    await runStalenessPass(env, {} as ExecutionContext);

    expect(writeAttempts).toBeGreaterThan(1); // the failed cursor write was actually retried
    expect(db.entries[0].staleness_checked_at).toBeGreaterThan(0);
    expect(db.entries[0].tags).toBe('"not-an-array"'); // still no verdict invented
  });

  // Deprecated rows are excluded by the candidate query, so the only way one reaches the
  // pass is by being deprecated after it was selected. It must not be classified: the
  // cursor moves and nothing else.
  it("short-circuits a row deprecated mid-pass to a cursor advance", async () => {
    const db = makeTestDb();
    seedAged(db, 1);
    const { env } = countingEnv(db);
    const original = db.prepare.bind(db);
    let deprecated = false;
    (db as any).prepare = (sql: string) => {
      if (!deprecated && sql.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ?")) {
        deprecated = true;
        db.entries[0].tags = '["status:deprecated"]';
      }
      return original(sql);
    };

    await runStalenessPass(env, {} as ExecutionContext);

    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toEqual(["status:deprecated"]);
    expect(db.entries[0].staleness_checked_at).toBeGreaterThan(0);
  });

  it("still re-reads tags when a concurrent write makes the CAS lose", async () => {
    const db = makeTestDb();
    seedAged(db, 1);
    const { env, prepared, billed } = countingEnv(db);
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

    expect(prepared.filter(s => s.startsWith("SELECT id, tags, content FROM entries WHERE id IN"))).toHaveLength(1);
    expect(billed.first).toBe(0); // the re-read is the batched one, not a per-row lookup
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
