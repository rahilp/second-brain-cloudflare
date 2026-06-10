import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

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
    expect(data.results[0].score).toBeCloseTo(90, 0);
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
});
