import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import { TAG_VOCABULARY_KEY } from "../../src/tags/vocabulary";
import { FTS_READY_KV_KEY } from "../../src/constants";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { snapshotRecallBudget } from "../helpers/recall-budget";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";

describe("recall stays within the Cloudflare Free operation envelope", () => {
  const open: SqliteD1[] = [];
  afterEach(() => open.splice(0).forEach(sqlite => sqlite.close()));

  async function setup(hops: 0 | 1) {
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    await sqlite.db.prepare(`ALTER TABLE entries ADD COLUMN updated_at INTEGER`).run();
    sqlite.seed({ id: "root", content: "atlas ledger changed", createdAt: 1000, tags: ["work"] });
    if (hops) {
      sqlite.seed({ id: "neighbor", content: "reconciliation rationale", createdAt: 1001, tags: ["work"] });
      await sqlite.db.prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("edge", "root", "neighbor", "decided", 1, "explicit", "{}", 1, 1).run();
    }

    const kv = makeMemoryKV();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    const vectorQuery = vi.fn().mockResolvedValue({
      matches: [{ id: "root", score: .9, metadata: { parentId: "root", created_at: 1000 } }],
    });
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => deferred.push(promise) } as unknown as ExecutionContext;
    const diagnostics: RecallDiagnostics = {};
    return { env, ctx, diagnostics, deferred };
  }

  async function run(hops: 0 | 1, query = "why atlas ledger changed") {
    // Each case models its own invocation; the readiness answer is cached per
    // isolate for FTS_READY_CACHE_MS, so a cold start must be simulated or the
    // second case would inherit the first case's cached answer and undercount.
    resetFtsReadyMemo();
    const state = await setup(hops);
    const result = await recallEntries(
      { query, topK: 5, hops, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);
    return snapshotRecallBudget(state.diagnostics, result);
  }

  it("charges one existing operation path for direct recall", async () => {
    const budget = await run(0);

    expect(budget).toMatchObject({
      workerRequests: 1,
      // Existing behavior: one embedding plus one tag-inference LLM because
      // the warm vocabulary has no literal query match. Recovery may not add a
      // third call.
      aiCalls: 2,
      embeddingCalls: 1,
      vectorizeQueries: 1,
      vectorizeGets: 0,
      // Tag vocabulary read plus the FTS readiness flag read (Task 3): the
      // keyword arm checks fts:ready on every non-tag recall. The answer is
      // cached per isolate for FTS_READY_CACHE_MS in both directions, so a
      // cold isolate pays one read per recall window, not per request.
      kvReads: 2,
      kvWrites: 0,
      graphSeeds: 0,
      expandedNodes: 0,
      renderedResults: 1,
    });
    expect(budget.d1Statements).toBe(5);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
    // D1's first() response omits metadata, so a complete per-invocation row
    // total is unknowable and must not be reported as a fabricated number.
    expect(budget.d1RowsRead).toBeNull();
    expect(budget.d1RowsWritten).toBeNull();
  });

  it("charges one df statement for a single-token direct recall", async () => {
    const budget = await run(0, "atlas");
    // The former single-token shortcut used four D1 calls. Corpus df now adds
    // one LIKE aggregation, matching the five-call multi-token path above.
    expect(budget.d1Statements).toBe(5);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
  });

  it("adds graph reads but no extra AI, embedding, or Vectorize path", async () => {
    const budget = await run(1);

    expect(budget.aiCalls).toBe(2);
    expect(budget.embeddingCalls).toBe(1);
    expect(budget.vectorizeQueries).toBe(1);
    expect(budget.vectorizeGets).toBe(0);
    // Tag vocabulary read plus the FTS readiness flag read (Task 3); the
    // ready-cache reset in run() models each case's cold isolate.
    expect(budget.kvReads).toBe(2);
    expect(budget.kvWrites).toBe(0);
    expect(budget.workerRequests).toBe(1);
    expect(budget.graphSeeds).toBe(1);
    expect(budget.expandedNodes).toBe(1);
    expect(budget.renderedResults).toBeLessThanOrEqual(5);
    expect(budget.d1Statements).toBe(7);
    expect(budget.d1Statements).toBeLessThanOrEqual(30);
    expect(budget.d1RowsRead).toBeNull();
    expect(budget.d1RowsWritten).toBeNull();
  });

  it("a warm isolate's second recall pays zero readiness KV reads", async () => {
    // The readiness answer is cached for FTS_READY_CACHE_MS in both
    // directions. With the flag absent, the cached false must serve the second
    // recall within the TTL: otherwise every recall on a stable warm isolate
    // pays the flag read the arm was meant to cut.
    resetFtsReadyMemo();
    const state = await setup(0);
    const cold = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);
    expect(snapshotRecallBudget(state.diagnostics, cold).kvReads).toBe(2); // tag vocabulary + the readiness flag

    const warmDiagnostics: RecallDiagnostics = {};
    const warm = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: warmDiagnostics },
    );
    await Promise.all(state.deferred);
    expect(snapshotRecallBudget(warmDiagnostics, warm).kvReads).toBe(1); // tag vocabulary only; no readiness re-read
  });

  // Write-path isolation v2.2: the liveness check (src/recall/fts.ts) rides
  // in the SAME env.DB.batch() as the FTS query, so it costs one extra SQL
  // statement but zero extra subrequests — a batch counts as one D1 call
  // (src/recall/diagnostics.ts's observeD1) regardless of how many
  // statements it carries, the same convention production D1 bills by.
  // MOVED 6 -> 5 (T-0065): entry_counts replaced distillation's scoped
  // COUNT(*)/cache with an exact, O(1) per-workspace counter, so total, every
  // per-term count, and the liveness check now ride in ONE batch always — the
  // same one D1 call the LIKE df scan cost, not two. Cold and warm are now
  // identical: there is no cache left to be cold against.
  it("a live FTS index costs no extra D1 call over the LIKE-path baseline — distillation's total is exact, not scanned", async () => {
    resetFtsReadyMemo();
    const state = await setup(0);
    await state.env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    const result = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env,
      state.ctx,
      DEFAULTS,
      { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);

    expect(state.diagnostics.ftsUsed).toBe(true); // the live index actually served this
    expect(state.diagnostics.distillSource).toBe("fts"); // T-0059: distillation counted through the index too
    const budget = snapshotRecallBudget(state.diagnostics, result);
    // T-0059/T-0065 (distill.ts): the LIKE df scan (1 D1 call) is replaced by
    // ONE batch — liveness, entry_counts' total, and every per-term count
    // together — the same one call, so the 5-call LIKE-path baseline above
    // does not move. keywordSearch's own FTS query (liveness + MATCH rows) is
    // unchanged at one batch.
    expect(budget.d1Statements).toBe(5);
  });

  it("a second recall costs the same as the first — entry_counts is exact, not cached, so there is no cold/warm split", async () => {
    resetFtsReadyMemo();
    const state = await setup(0);
    await state.env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env, state.ctx, DEFAULTS, { diagnostics: state.diagnostics },
    );
    await Promise.all(state.deferred);

    const warmDiagnostics: RecallDiagnostics = {};
    const warm = await recallEntries(
      { query: "why atlas ledger changed", topK: 5, hops: 0, synthesize: false },
      state.env, state.ctx, DEFAULTS, { diagnostics: warmDiagnostics },
    );
    await Promise.all(state.deferred);

    expect(warmDiagnostics.ftsUsed).toBe(true);
    expect(warmDiagnostics.distillSource).toBe("fts");
    // Matches the first call above exactly (T-0065): entry_counts has no
    // warm/cold distinction left to be cheaper than the first call.
    expect(snapshotRecallBudget(warmDiagnostics, warm).d1Statements).toBe(5);
  });

  // MINOR 4b (final review): every case above calls recallEntries directly,
  // in-process, bypassing auth and schema readiness entirely. This one goes
  // through the real Worker entry point — real token authentication (the
  // legacy AUTH_TOKEN bootstrapped into a genuine admin row via
  // ensureTenantBootstrap, resolved through the Authorization header the
  // same way production does) against a freshly migrated real SQLite brain
  // (initializeDatabase, not a pre-populated D1 mock) — so the pinned count
  // reflects an actual request's real cost, not a hand-assembled one.
  it("a real GET /recall request through worker.fetch pins its D1 subrequest count end to end", async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    const sqlite = makeSqliteD1();
    open.push(sqlite);
    const kv = makeMemoryKV();
    const bootEnv = makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database, OAUTH_KV: kv });
    await initializeDatabase(bootEnv);
    const roots = await ensureTenantBootstrap(bootEnv);
    sqlite.seed({ id: "root", content: "atlas ledger changed", createdAt: 1000, tags: ["work"] });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = 'root'`)
      .bind(roots.ownerPersonalWorkspaceId).run();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
    sqlite.issued.length = 0; // setup's own DDL/bootstrap/seed statements are not what this pins

    const vectorQuery = vi.fn().mockResolvedValue({
      matches: [{ id: "root", score: .9, metadata: { parentId: "root", created_at: 1000 } }],
    });
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: kv,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p) } as unknown as ExecutionContext;

    const res = await worker.fetch(
      new Request("http://localhost/recall?query=why+atlas+ledger+changed&topK=5", {
        headers: { Authorization: "Bearer test-token" },
      }),
      env, ctx,
    );
    await Promise.all(deferred);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; results: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.results.map(m => m.id)).toContain("root");
    // Exact pin, real end-to-end path (measured, not assumed): identity
    // resolution, distillation, the keyword and dense arms, candidate
    // hydration, and the deferred recall_count bump. If this number moves,
    // say why in the same commit.
    expect(sqlite.issued.length).toBe(7);
  });
});
