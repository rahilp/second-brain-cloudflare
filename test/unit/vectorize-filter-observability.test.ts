import { describe, expect, it, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import {
  queryVectorizeScoped,
  resetVectorizeFilterState,
  singleWorkspaceFilter,
  vectorizeFilterState,
} from "../../src/vectorize/scope";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV, makeKVMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";

// The latch (`workspaceFiltersSupported`) and `degradedQueryCount` in
// src/vectorize/scope.ts are module-scope state that persists across every
// test in THIS file (vitest isolates modules per file, not per test). Reset
// deliberately before every case so one test's latch can never decide
// another's outcome.
beforeEach(() => {
  resetVectorizeFilterState();
});

describe("vectorizeFilterState / resetVectorizeFilterState", () => {
  it("starts (and resets back to) supported: null, degradedQueries: 0", () => {
    expect(vectorizeFilterState()).toEqual({ supported: null, degradedQueries: 0 });
  });
});

describe("queryVectorizeScoped — observability", () => {
  it("a filter-shaped rejection degrades, increments degradedQueries, and latches supported: false", async () => {
    const v = makeVectorizeMock({
      query: vi.fn().mockRejectedValueOnce(new Error("unknown filter field")).mockResolvedValue({ matches: [{ id: "x", score: 0.5 }] }),
    });
    const { degraded } = await queryVectorizeScoped(
      v as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter },
    );
    expect(degraded).toBe(true);
    expect(vectorizeFilterState()).toEqual({ supported: false, degradedQueries: 1 });
  });

  it("a non-filter error still propagates and does not move the degraded counter", async () => {
    const v = makeVectorizeMock({
      query: vi.fn().mockRejectedValue(new Error("index unavailable")),
    });
    await expect(
      queryVectorizeScoped(v as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter }),
    ).rejects.toThrow(/index unavailable/);
    expect(vectorizeFilterState()).toEqual({ supported: null, degradedQueries: 0 });
  });

  it("calls onDegrade exactly once, on the transition, not on every subsequent degraded query", async () => {
    const v = makeVectorizeMock({
      // Only the FIRST call (the filtered attempt, before the latch trips)
      // rejects; every unfiltered retry after that must succeed like a real
      // degraded-mode Vectorize call would.
      query: vi.fn().mockRejectedValueOnce(new Error("unknown filter field")).mockResolvedValue({ matches: [] }),
    });
    const onDegrade = vi.fn();
    await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter, onDegrade });
    await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter, onDegrade });
    await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter, onDegrade });
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(vectorizeFilterState().degradedQueries).toBe(3);
  });
});

describe("GET /health — workspaceFilter", () => {
  it("reports supported: false and a non-zero degradedQueries after a degraded query in the same isolate", async () => {
    const db = makeTestDb();
    const kv = makeMemoryKV();
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      OAUTH_KV: kv,
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

    // Force the latch to trip, using the module scope.ts shares with admin.ts
    // in this isolate.
    const rejecting = makeVectorizeMock({
      query: vi.fn().mockRejectedValueOnce(new Error("unknown filter field")).mockResolvedValue({ matches: [] }),
    });
    await queryVectorizeScoped(rejecting as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter });

    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.vectorize.workspaceFilter.supported).toBe(false);
    expect(data.vectorize.workspaceFilter.degradedQueries).toBeGreaterThanOrEqual(1);
  });

  it("reports supported: null and latchedAt: null on a fresh isolate that never rejected a filter", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    const data = await res.json() as any;
    expect(data.vectorize.workspaceFilter).toEqual({ supported: null, degradedQueries: 0, latchedAt: null });
  });

  it("reports latchedAt from the durable KV marker once it has been written", async () => {
    const db = makeTestDb();
    const kv = makeMemoryKV();
    await kv.put("vectorize:workspace-filter-unsupported", "1700000000000");
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      OAUTH_KV: kv,
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    const data = await res.json() as any;
    expect(data.vectorize.workspaceFilter.latchedAt).toBe(1700000000000);
  });

  it("still answers 200 with the rest of its body intact when OAUTH_KV.get rejects", async () => {
    const db = makeTestDb();
    const kv = makeKVMock();
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("KV is down"));
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      OAUTH_KV: kv,
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.vectorize.ok).toBe(true);
    expect(data.vectorize.workspaceFilter.supported).toBe(null);
    // Degrades to "unknown" rather than surfacing the KV outage as a marker.
    expect(data.vectorize.workspaceFilter.latchedAt).toBe(null);
    expect(typeof data.team).toBe("boolean");
  });
});
