import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { resetDatabaseInit } from "../../src/db/init";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
import { makeTestDb, makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

function countingEnv(db: D1Mock, kv = makeMemoryKV()) {
  const statements: string[] = [];
  const bill = (sql: string) => statements.push(sql.replace(/\s+/g, " ").trim());
  const wrap = (stmt: any, sql: string): any => ({
    bind: (...a: any[]) => wrap(stmt.bind(...a), sql),
    run: () => { bill(sql); return stmt.run(); },
    first: (...a: any[]) => { bill(sql); return stmt.first(...a); },
    all: () => { bill(sql); return stmt.all(); },
    __inner: stmt,
  });
  const DB = {
    prepare(sql: string) { return wrap(db.prepare(sql), sql); },
    exec(sql: string) { bill(sql); return db.exec(sql); },
    batch: (stmts: any[]) => { bill("BATCH"); return db.batch(stmts.map((s: any) => s.__inner ?? s)); },
  } as unknown as D1Database;
  const env = makeTestEnv(db, { DB, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock() });
  return { env, statements, db, kv };
}

async function start(env: Env, entry_total: number, edge_total = 0) {
  const res = await worker.fetch(req("POST", "/import/start", {
    body: { version: 2, entry_total, edge_total },
  }), env, ctx);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ job_id: string; entry_pages: number; edge_pages: number }>;
}

async function append(env: Env, job_id: string, phase: "entries" | "edges", page: number, rows: unknown[]) {
  const res = await worker.fetch(req("POST", "/import/append", {
    body: { job_id, phase, page, rows },
  }), env, ctx);
  return { res, data: await res.json() as any };
}

async function cont(env: Env, job_id: string, phase: "entries" | "edges", page: number) {
  const res = await worker.fetch(req("POST", "/import/continue", {
    body: { job_id, phase, page },
  }), env, ctx);
  return { res, data: await res.json() as any };
}

async function status(env: Env, job_id: string) {
  const res = await worker.fetch(req("GET", `/import/status?job_id=${job_id}`), env, ctx);
  return { res, data: await res.json() as any };
}

describe("POST /import/* cursor job", () => {
  let db: D1Mock;
  let env: Env;
  let kv: KVNamespace;

  beforeEach(() => {
    resetDatabaseInit();
    db = makeTestDb();
    kv = makeMemoryKV();
    env = makeTestEnv(db, { OAUTH_KV: kv, VECTORIZE: makeVectorizeMock() });
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/import/start", {
      body: { version: 2, entry_total: 0, edge_total: 0 },
      token: null,
    }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects version !== 2", async () => {
    const res = await worker.fetch(req("POST", "/import/start", {
      body: { version: 1, entry_total: 1, edge_total: 0 },
    }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.code).toBe("invalid_version");
  });

  it("round-trips export-shaped entries with deferred vector_ids", async () => {
    const { job_id } = await start(env, 2, 0);
    const rows = [
      { id: "e1", content: "hello", tags: ["work"], source: "obsidian", created_at: 1000 },
      { id: "e2", content: "world", tags: [], source: "api", created_at: 2000 },
    ];
    expect((await append(env, job_id, "entries", 0, rows)).res.status).toBe(200);
    const { res, data } = await cont(env, job_id, "entries", 0);
    expect(res.status).toBe(200);
    expect(data.imported).toBe(2);
    expect(data.skipped).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.done).toBe(true);
    expect(data.clean).toBe(true);
    expect(data.vectorize_hint).toMatch(/vectorize-pending/);

    expect(db.entries).toHaveLength(2);
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(db.entries[0].updated_at).toBe(1000);
    expect(db.entries[0].tags).toBe(JSON.stringify(["work"]));
  });

  it("is idempotent on page replay and does not inflate counters", async () => {
    const { job_id } = await start(env, 1, 0);
    await append(env, job_id, "entries", 0, [{ id: "e1", content: "once" }]);
    const first = await cont(env, job_id, "entries", 0);
    expect(first.data.imported).toBe(1);
    const second = await cont(env, job_id, "entries", 0);
    expect(second.data.imported).toBe(0);
    expect(second.data.skipped).toBe(1);
    expect(db.entries).toHaveLength(1);

    const st = await status(env, job_id);
    expect(st.data.imported).toBe(0); // upsert replaced, not incremented
    expect(st.data.skipped).toBe(1);
    expect(st.data.done).toBe(true);
  });

  it("locks append after continue (page_already_processed)", async () => {
    const { job_id } = await start(env, 1, 0);
    await append(env, job_id, "entries", 0, [{ id: "e1", content: "a" }]);
    await cont(env, job_id, "entries", 0);
    const { res, data } = await append(env, job_id, "entries", 0, [{ id: "e1", content: "b" }]);
    expect(res.status).toBe(409);
    expect(data.code).toBe("page_already_processed");
  });

  it("returns page_missing then succeeds after append", async () => {
    const { job_id } = await start(env, 1, 0);
    const missing = await cont(env, job_id, "entries", 0);
    expect(missing.res.status).toBe(409);
    expect(missing.data.code).toBe("page_missing");

    await append(env, job_id, "entries", 0, [{ id: "e1", content: "late" }]);
    const ok = await cont(env, job_id, "entries", 0);
    expect(ok.res.status).toBe(200);
    expect(ok.data.imported).toBe(1);
  });

  it("imports edges after entries and resolves endpoints against D1", async () => {
    const { job_id } = await start(env, 2, 1);
    await append(env, job_id, "entries", 0, [
      { id: "a", content: "A" },
      { id: "b", content: "B" },
    ]);
    await cont(env, job_id, "entries", 0);
    await append(env, job_id, "edges", 0, [
      { source_id: "a", target_id: "b", type: "relates_to", weight: 0.8, provenance: "explicit", created_at: 42 },
    ]);
    const { data } = await cont(env, job_id, "edges", 0);
    expect(data.imported).toBe(1);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].created_at).toBe(42);
  });

  it("edge page before entries fails missing_endpoint then succeeds on rerun", async () => {
    const { job_id } = await start(env, 2, 1);
    await append(env, job_id, "edges", 0, [
      { source_id: "a", target_id: "b", type: "relates_to" },
    ]);
    const early = await cont(env, job_id, "edges", 0);
    expect(early.data.failed).toBe(1);
    expect(early.data.retriable_failed).toBe(1);
    expect(early.data.results[0].reason).toBe("missing_endpoint");

    let st = await status(env, job_id);
    expect(st.data.failed_pages).toEqual([
      { phase: "edges", page: 0, retriable_failed: 1 },
    ]);
    expect(st.data.clean).toBe(false);

    await append(env, job_id, "entries", 0, [
      { id: "a", content: "A" },
      { id: "b", content: "B" },
    ]);
    await cont(env, job_id, "entries", 0);
    const again = await cont(env, job_id, "edges", 0);
    expect(again.data.imported).toBe(1);
    expect(again.data.failed).toBe(0);

    st = await status(env, job_id);
    expect(st.data.failed_pages).toEqual([]);
    expect(st.data.done).toBe(true);
    expect(st.data.clean).toBe(true);
  });

  it("one invalid row does not block the rest of the page", async () => {
    const { job_id } = await start(env, 3, 0);
    await append(env, job_id, "entries", 0, [
      { id: "ok1", content: "good" },
      { id: 42, content: "bad" },
      { id: "ok2", content: "also good" },
    ]);
    const { data } = await cont(env, job_id, "entries", 0);
    expect(data.imported).toBe(2);
    expect(data.failed).toBe(1);
    expect(data.results[0].reason).toBe("invalid_id");
    expect(db.entries.map((e: any) => e.id).sort()).toEqual(["ok1", "ok2"]);
  });

  it("terminal-only failure leaves done true and stays out of failed_pages", async () => {
    const { job_id } = await start(env, 1, 0);
    await append(env, job_id, "entries", 0, [{ id: "", content: "nope" }]);
    const { data } = await cont(env, job_id, "entries", 0);
    expect(data.failed).toBe(1);
    expect(data.retriable_failed).toBe(0);
    expect(data.done).toBe(true);
    expect(data.clean).toBe(true);

    const st = await status(env, job_id);
    expect(st.data.failed).toBe(1);
    expect(st.data.retriable_failed).toBe(0);
    expect(st.data.failed_pages).toEqual([]);
    expect(st.data.done).toBe(true);
    expect(st.data.clean).toBe(true);
  });

  it("status next_*_page tracks out-of-order coverage", async () => {
    const { job_id, entry_pages } = await start(env, 1001, 0);
    expect(entry_pages).toBe(3);
    // Only process page 1 first
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      id: `p1-${i}`, content: `c${i}`,
    }));
    await append(env, job_id, "entries", 1, page1);
    await cont(env, job_id, "entries", 1);

    const st = await status(env, job_id);
    expect(st.data.next_entry_page).toBe(0);
    expect(st.data.pages_done_entries).toBe(1);
    expect(st.data.done).toBe(false);
  });

  it("existence probes are page-scoped (constant query count vs destination size)", async () => {
    // Pre-seed a large destination brain — quadratic designs would scale with this.
    for (let i = 0; i < 2000; i++) {
      db.entries.push({
        id: `seed-${i}`, content: "x", tags: "[]", source: "api",
        created_at: i, updated_at: i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }

    const counted = countingEnv(db, kv);
    const { job_id } = await start(counted.env, 100, 0);
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `new-${i}`, content: `n${i}` }));
    await append(counted.env, job_id, "entries", 0, rows);

    counted.statements.length = 0;
    await cont(counted.env, job_id, "entries", 0);

    const existence = counted.statements.filter(s => s.includes("SELECT id FROM entries WHERE id IN"));
    // 100 ids / 100 bound params = 1 probe, independent of the 2000 seed rows
    expect(existence.length).toBe(Math.ceil(100 / D1_MAX_BOUND_PARAMS));
  });

  it("bounded fallback keeps subrequests ≤ 50 and marks deferred_retry", async () => {
    const counted = countingEnv(db, kv);
    const { job_id } = await start(counted.env, 100, 0);
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `b-${i}`, content: `c${i}` }));
    await append(counted.env, job_id, "entries", 0, rows);

    // Force every batch() to fail so row-by-row retry engages.
    const originalBatch = (counted.env.DB as any).batch;
    (counted.env.DB as any).batch = async () => {
      counted.statements.push("BATCH");
      throw new Error("forced batch failure");
    };

    counted.statements.length = 0;
    const { data } = await cont(counted.env, job_id, "entries", 0);
    expect(counted.statements.length).toBeLessThanOrEqual(50);
    expect(data.results.some((r: any) => r.reason === "deferred_retry" || r.reason === "insert_error")).toBe(true);

    (counted.env.DB as any).batch = originalBatch;
  });

  it("rejects oversized append with 413", async () => {
    const { job_id } = await start(env, 1000, 0);
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: `x-${i}`, content: "c" }));
    const { res, data } = await append(env, job_id, "entries", 0, rows);
    expect(res.status).toBe(413);
    expect(data.code).toBe("page_too_large");
  });

  it("reset deletes the ledger", async () => {
    const { job_id } = await start(env, 1, 0);
    await append(env, job_id, "entries", 0, [{ id: "e1", content: "a" }]);
    await cont(env, job_id, "entries", 0);

    const reset = await worker.fetch(req("POST", "/import/reset", {
      body: { job_id },
    }), env, ctx);
    expect(reset.status).toBe(200);

    const st = await status(env, job_id);
    expect(st.res.status).toBe(404);
  });

  it("start reports write ceiling estimate", async () => {
    const res = await worker.fetch(req("POST", "/import/start", {
      body: { version: 2, entry_total: 25000, edge_total: 0 },
    }), env, ctx);
    const data = await res.json() as any;
    expect(data.estimated_row_writes).toBe(100_000);
    expect(data.days_at_least).toBe(1);
    expect(data.write_ceiling_hint).toMatch(/row writes\/day/);
  });
});
