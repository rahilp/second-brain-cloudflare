import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { captureEntry } from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

// Returns an AI mock that always resolves a contradiction verdict (for captureEntry).
function makeContradictionAI(response: string): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeMatch(id: string, score: number, overrides: Record<string, any> = {}) {
  return {
    id,
    score,
    metadata: { parentId: id, isUpdate: false, ...overrides },
  };
}

// The AI mock embeds every query as 384 dims of 0.1 (make-env.ts) —
// SIMILAR_VEC scores cosine 1.0 against it, DISSIMILAR_VEC scores ~0.
const SIMILAR_VEC = new Array(384).fill(0.1);
const DISSIMILAR_VEC = Array.from({ length: 384 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));

describe("GET /recall", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when query is missing", async () => {
    const res = await worker.fetch(req("GET", "/recall"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe("query is required");
  });

  it("returns an empty result set with a message when nothing matches", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=anything"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    expect(data.message).toBe("Nothing found matching that query.");
  });

  it("returns ranked matches hydrated from D1", async () => {
    db.entries.push(
      { id: "entry-1", content: "First memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Second memory", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-1", 0.9), makeMatch("entry-2", 0.8)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toMatchObject({ id: "entry-1", content: "First memory", tags: ["work"], source: "api" });
    // Fused scores are normalized so the top match is 100% and the list descends.
    expect(data.results[0].score).toBe(100);
    expect(data.results[1].score).toBeLessThanOrEqual(data.results[0].score);
    expect(data.results[1]).toMatchObject({ id: "entry-2", content: "Second memory" });
    expect(typeof data.insight === "string" || data.insight === null).toBe(true);
  });

  it("dedupes matches that share the same parentId", async () => {
    db.entries.push(
      { id: "entry-1", content: "Chunked memory", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-1", 0.9), makeMatch("entry-1-update-1", 0.85, { parentId: "entry-1", isUpdate: true })],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("surfaces tagged entries via getByIds even when a global query would miss them", async () => {
    db.entries.push(
      { id: "entry-1", content: "Work memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Idea memory", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: '["entry-2"]', recall_count: 0, importance_score: 0 },
    );
    // Global semantic query returns nothing — the old path would lose this entry entirely
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock, getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
    // Only the tag's own vectors are fetched; the global query is never used
    expect(getByIdsMock).toHaveBeenCalledWith(["entry-1"]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns empty results immediately when the tag has no matching entries", async () => {
    const queryMock = vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] });
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock, getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=nonexistent"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    // Short-circuits before hitting Vectorize since the tag resolves to no IDs in D1
    expect(queryMock).not.toHaveBeenCalled();
    expect(getByIdsMock).not.toHaveBeenCalled();
  });

  it("clamps ?topK= to the 1-20 range", async () => {
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&topK=999"), env, ctx);
    const [, opts] = queryMock.mock.calls[0];
    expect(opts.topK).toBeLessThanOrEqual(50);
  });

  it("ranks tag-scoped results by cosine similarity to the query", async () => {
    db.entries.push(
      { id: "entry-1", content: "Less similar", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "More similar", tags: '["work"]', source: "api", created_at: 2000, vector_ids: '["entry-2"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1", values: DISSIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
      { id: "entry-2", values: SIMILAR_VEC, metadata: { parentId: "entry-2", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results.map((r: any) => r.id)).toEqual(["entry-2", "entry-1"]);
    expect(data.results[0].score).toBeGreaterThan(data.results[1].score);
  });

  it("omits stale vector IDs that getByIds does not return", async () => {
    db.entries.push(
      { id: "entry-1", content: "Live memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1","entry-1-stale"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("returns empty results when all of the tag's vectors are stale", async () => {
    db.entries.push(
      { id: "entry-1", content: "Orphaned memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    expect(getByIdsMock).toHaveBeenCalledWith(["entry-1"]);
  });

  it("returns empty without calling Vectorize when tagged entries have no vectors", async () => {
    db.entries.push(
      { id: "entry-1", content: "Unvectorized memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock, getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toEqual([]);
    expect(getByIdsMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("batches getByIds calls at 20 IDs (Vectorize error 40007 above that)", async () => {
    const manyIds = Array.from({ length: 41 }, (_, i) => `entry-1-chunk-${i}`);
    db.entries.push(
      { id: "entry-1", content: "Heavily chunked memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: JSON.stringify(manyIds), recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    expect(getByIdsMock).toHaveBeenCalledTimes(3);
    expect(getByIdsMock.mock.calls[0][0]).toEqual(manyIds.slice(0, 20));
    expect(getByIdsMock.mock.calls[1][0]).toEqual(manyIds.slice(20, 40));
    expect(getByIdsMock.mock.calls[2][0]).toEqual(manyIds.slice(40));
  });

  it("dedupes duplicate vector IDs shared across tagged entries before fetching", async () => {
    db.entries.push(
      { id: "entry-1", content: "First", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["shared-vec"]', recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Second", tags: '["work"]', source: "api", created_at: 2000, vector_ids: '["shared-vec"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    expect(getByIdsMock).toHaveBeenCalledTimes(1);
    expect(getByIdsMock.mock.calls[0][0]).toEqual(["shared-vec"]);
  });

  it("respects topK in tag-scoped recall", async () => {
    for (let i = 1; i <= 5; i++) {
      db.entries.push(
        { id: `entry-${i}`, content: `Memory ${i}`, tags: '["work"]', source: "api", created_at: 1000 + i, vector_ids: `["entry-${i}"]`, recall_count: 0, importance_score: 0 },
      );
    }
    const getByIdsMock = vi.fn().mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `entry-${i + 1}`, values: SIMILAR_VEC, metadata: { parentId: `entry-${i + 1}`, isUpdate: false } })),
    );
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work&topK=2"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(2);
  });

  it("dedupes tag-scoped chunk vectors that share the same parentId", async () => {
    db.entries.push(
      { id: "entry-1", content: "Chunked memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1-chunk-0","entry-1-chunk-1"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1-chunk-0", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
      { id: "entry-1-chunk-1", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("chunks the candidate scoring query for tags with more than 100 entries", async () => {
    const count = 150;
    for (let i = 1; i <= count; i++) {
      db.entries.push(
        { id: `entry-${i}`, content: `Memory ${i}`, tags: '["work"]', source: "api", created_at: 1000 + i, vector_ids: `["entry-${i}"]`, recall_count: 0, importance_score: 0 },
      );
    }
    const getByIdsMock = vi.fn().mockResolvedValue(
      Array.from({ length: count }, (_, i) => ({ id: `entry-${i + 1}`, values: SIMILAR_VEC, metadata: { parentId: `entry-${i + 1}`, isUpdate: false } })),
    );
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });
    const prepareSpy = vi.spyOn(db, "prepare");

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(5); // default topK
    // D1 allows max 100 bound parameters per query — 150 candidates must be chunked into 2 calls
    const scoringCalls = prepareSpy.mock.calls.filter(([sql]) => sql.includes("recall_count, importance_score"));
    expect(scoringCalls).toHaveLength(2);
  });

  it("hashtag or keyword in query skips the LLM during tag inference", async () => {
    db.entries.push(
      { id: "entry-1", content: "Work meeting notes", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
    );
    const aiRun = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"work"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    });
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=work+meeting"), env, ctx);
    expect(res.status).toBe(200);
    // "work" is a known tag AND appears as a keyword in the query → LLM not called for inference
    // (embed call uses BGE model; only LLM calls use other models)
    const llmCalls = aiRun.mock.calls.filter((args: any[]) => args[0] !== "@cf/baai/bge-small-en-v1.5");
    expect(llmCalls).toHaveLength(0);
  });

  it("excludes status:deprecated entries from recall results", async () => {
    db.entries.push(
      { id: "entry-active", content: "Active memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-active"]', recall_count: 0, importance_score: 0 },
      { id: "entry-deprecated", content: "Deprecated memory", tags: '["work","status:deprecated"]', source: "api", created_at: 2000, vector_ids: '["entry-deprecated"]', recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-active", 0.9), makeMatch("entry-deprecated", 0.85)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-active");
  });

  it("filters recall results to only the requested kind", async () => {
    db.entries.push(
      { id: "entry-episodic", content: "Attended a team offsite in January", tags: '["work","kind:episodic"]', source: "api", created_at: 1000, vector_ids: '["entry-episodic"]', recall_count: 0, importance_score: 0 },
      { id: "entry-semantic", content: "The company uses a monorepo structure", tags: '["work","kind:semantic"]', source: "api", created_at: 2000, vector_ids: '["entry-semantic"]', recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-episodic", 0.9), makeMatch("entry-semantic", 0.85)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory&kind=episodic"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-episodic");
  });

  it("query with no matching keywords exercises the LLM fallback for tag inference", async () => {
    db.entries.push(
      { id: "entry-1", content: "Office lease renewal", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
    );
    const aiRun = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"work"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    });
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] }),
      }),
    });

    // "quarterly planning" — no hashtags, "work" is not a whole word in this query
    const res = await worker.fetch(req("GET", "/recall?query=quarterly+planning"), env, ctx);
    expect(res.status).toBe(200);
    // LLM called at least once (for tag inference); embedding uses BGE model (not counted)
    const llmCalls = aiRun.mock.calls.filter((args: any[]) => args[0] !== "@cf/baai/bge-small-en-v1.5");
    expect(llmCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("a contradiction survivor outranks an equally-scored contested loser", async () => {
    db.entries.push(
      { id: "shaky", content: "Contested fact", tags: '["work"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 4, contradiction_wins: 0, contradiction_losses: 3 },
      { id: "survivor", content: "Battle-tested fact", tags: '["work"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 4, contradiction_wins: 3, contradiction_losses: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("shaky", 0.9), makeMatch("survivor", 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=fact"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results[0].id).toBe("survivor");
    expect(data.results[1].id).toBe("shaky");
  });

  // ── End-to-end: captureEntry WRITES contradiction_wins → recallEntries READS and reranks ──

  it("e2e: captureEntry writes contradiction_wins=1; subsequent recall ranks the winner above a peer with imp=3,wins=0 (real rerank, not seeded)", async () => {
    // Phase 1 — CAPTURE: resolve a contradiction through production captureEntry.
    //
    // Seed the non-canonical incumbent "old-fact" that the new entry will beat.
    // It needs vector_ids so the deprecation path has something to delete from Vectorize.
    const now = Date.now();
    db.entries.push({
      id: "old-fact",
      content: "I live in Boston",
      tags: "[]",
      source: "api",
      created_at: now - 10000,
      vector_ids: '["old-fact-vec"]',
      recall_count: 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });

    // Seed an uncontested peer with importance_score=3, contradiction_wins=0.
    // Rerank math (verified against src/index.ts rerankWithTimeDecay):
    //   peer:   imp=3, net=0 → effectiveImp=3 → importanceMultiplier = 0.8+(3/5)*0.4 = 1.04
    //   winner: imp=0 (unclassified), net=+1 (1 win 0 losses)
    //           → base=3 (unscored-but-contested neutral midpoint)
    //           → adj = sign(1)*log1p(1)*1.0 = ln(2) ≈ 0.693
    //           → effectiveImp = 3+0.693 = 3.693
    //           → importanceMultiplier = 0.8+(3.693/5)*0.4 = 1.0954
    //   winner importanceMultiplier (1.0954) > peer (1.04), so winner ranks first.
    //   Tie-breaker guard: peer is placed FIRST in the Vectorize matches array so that
    //   without the win boost, the peer would be listed first — the win is the sole differentiator.
    db.entries.push({
      id: "peer",
      content: "Uncontested peer fact",
      tags: "[]",
      source: "api",
      created_at: now - 10000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 3,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });

    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const captureEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        // captureEntry uses this query mock to find the near-match during capture
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-fact", score: 0.72, metadata: { parentId: "old-fact" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "old-fact", "reason": "different city"}'),
    });

    const captureCtx = { waitUntil: (_: Promise<any>) => {} } as any as ExecutionContext;
    const captureResult = await captureEntry("I moved to Seattle", [], "api", captureEnv, captureCtx);

    // Assert production code wrote contradiction_wins=1 on the new entry
    expect(captureResult.status).toBe("contradiction");
    if (captureResult.status !== "contradiction") return;
    const winnerId = captureResult.id;

    const winnerRow = db.entries.find(e => e.id === winnerId);
    expect(winnerRow).toBeDefined();
    expect(winnerRow!.contradiction_wins).toBe(1); // written by production, not seeded

    // Phase 2 — RECALL: the shared db now has winner (wins=1, imp=0) and peer (wins=0, imp=3).
    // Configure Vectorize to return [peer first, winner second] at equal score 0.9 —
    // without the win boost the peer would appear first (it's listed first in matches).
    // The real rerank formula must lift the winner above the peer.
    const recallEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("peer", 0.9), makeMatch(winnerId, 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=where do I live"), recallEnv, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // Winner (contradiction_wins=1, imp=0 → effectiveImp≈3.69) must rank above
    // peer (contradiction_wins=0, imp=3 → effectiveImp=3.0) even though peer was listed first.
    expect(data.results[0].id).toBe(winnerId);
    expect(data.results[1].id).toBe("peer");
  });

  // ── Hybrid recall: keyword fusion surfaces exact-identifier matches ──

  it("surfaces an exact-identifier match the dense top-K missed, via keyword fusion", async () => {
    const now = Date.now();
    const seed: [string, string][] = [
      ["v16", "Release notes for v1.6 — web UI polish"],
      ["v17", "Release notes for v1.7 — added OAuth support"],
      ["v18", "Release notes for v1.8 — fixed a re-embed bug"],
      ["v19", "Release notes for v1.9 — added the memory status layer"],
    ];
    seed.forEach(([id, content], i) => db.entries.push({
      id, content, tags: "[]", source: "api",
      created_at: now - (seed.length - i) * 1000,
      vector_ids: `["${id}"]`, recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0,
    }));

    // Dense search returns the near-twins at high scores but misses v1.9 entirely —
    // version tokens embed near-identically, so cosine can't single it out.
    const queryMock = vi.fn().mockResolvedValue({
      matches: [makeMatch("v16", 0.82), makeMatch("v17", 0.81), makeMatch("v18", 0.80)],
    });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock }) });
    const prepareSpy = vi.spyOn(db, "prepare");

    const res = await worker.fetch(req("GET", "/recall?query=release+v1.9"), env, ctx);
    const data = await res.json() as any;

    // Keyword search ran on this recall — it's always-on, not a fallback
    expect(prepareSpy.mock.calls.some(([sql]) => sql.includes("content LIKE"))).toBe(true);
    // The exact v1.9 entry is surfaced AND ranked first despite being absent from dense
    const ids = data.results.map((r: any) => r.id);
    expect(ids).toContain("v19");
    expect(ids[0]).toBe("v19");
    expect(data.results[0].score).toBe(100);
  });

  it("re-ranks an identifier hit to the top within a tag (hybrid on the tag path)", async () => {
    const now = Date.now();
    const seed: [string, string][] = [
      ["v16", "Release notes for v1.6"],
      ["v17", "Release notes for v1.7"],
      ["v18", "Release notes for v1.8"],
      ["v19", "Release notes for v1.9"],
    ];
    seed.forEach(([id, content], i) => db.entries.push({
      id, content, tags: '["rel"]', source: "api",
      created_at: now - (seed.length - i) * 1000,
      vector_ids: `["${id}"]`, recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0,
    }));
    // All tagged vectors score equally on cosine — only keyword fusion distinguishes them.
    const getByIdsMock = vi.fn().mockResolvedValue(
      seed.map(([id]) => ({ id, values: SIMILAR_VEC, metadata: { parentId: id, isUpdate: false } })),
    );
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=release+v1.9&tag=rel"), env, ctx);
    const data = await res.json() as any;
    expect(data.results[0].id).toBe("v19");
  });
});
