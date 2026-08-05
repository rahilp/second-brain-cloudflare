/**
 * All four nightly jobs are fired from a single scheduled() invocation (src/index.ts),
 * so they share ONE subrequest budget — 50 on the free plan. Each of them awaits
 * initializeDatabase, so before it was memoised the same thirteen DDL statements were paid
 * for once per job, and the pass that runs last could find the budget already spent.
 *
 * Memoisation cut that to thirteen; #282 cut the thirteen to a single catalogue read
 * on any brain that is already migrated, which every brain is after its first request.
 * The D1 mock answers the probe as a migrated brain, which is what a nightly cron always
 * runs against — a brain with no schema has no entries to compress.
 *
 * This measures the whole invocation rather than any one job, because per-job budget
 * assertions are not true in situ.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { resetDatabaseInit } from "../../src/db/init";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

const FREE_PLAN_SUBREQUESTS = 50;

function countingEnv(db: D1Mock) {
  const statements: string[] = [];
  const DB = {
    prepare(sql: string) { statements.push(sql.replace(/\s+/g, " ").trim()); return db.prepare(sql); },
    exec(sql: string) { statements.push(sql.replace(/\s+/g, " ").trim()); return db.exec(sql); },
    batch: (stmts: any[]) => db.batch(stmts),
  } as unknown as D1Database;
  return { env: makeTestEnv(db, { DB, VECTORIZE: makeVectorizeMock() }), statements };
}

async function runCron(env: any) {
  const pending: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;
  await (worker as any).scheduled({} as any, env, ctx);
  await Promise.allSettled(pending);
}

describe("nightly cron D1 subrequest cost", () => {
  beforeEach(() => {
    resetDatabaseInit();
    vi.restoreAllMocks();
  });

  it("probes the schema once per invocation, not once per job, and issues no DDL", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    // The signature statement of initializeDatabase, once for the whole cron.
    expect(statements.filter(s => s.startsWith("SELECT type AS kind, name FROM sqlite_master"))).toHaveLength(1);
    // #282: the schema is already there, and the whole point is that finding that out no
    // longer costs a CREATE and an ALTER per object.
    expect(statements.filter(s => /^(CREATE|ALTER)\b/.test(s))).toEqual([]);
  });

  it("keeps a whole nightly run inside the free-plan subrequest budget", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  it("still leaves the staleness pass room to run after the other jobs", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job", content: "Bob works at Example Inc", tags: "[]",
      source: "api", created_at: old, updated_at: old, vector_ids: "[]",
    });
    const { env } = countingEnv(db);

    await runCron(env);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
    expect(tags).toContain("stale:as-of");
  });
});
