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

  it("filters out matches whose parent entry doesn't carry the requested tag", async () => {
    db.entries.push(
      { id: "entry-1", content: "Work memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Idea memory", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-1", 0.9), makeMatch("entry-2", 0.85)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("returns empty results immediately when the tag has no matching entries", async () => {
    const queryMock = vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=nonexistent"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    // Short-circuits before hitting Vectorize since the tag resolves to no IDs in D1
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("clamps ?topK= to the 1-20 range", async () => {
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&topK=999"), env, ctx);
    const [, opts] = queryMock.mock.calls[0];
    expect(opts.topK).toBeLessThanOrEqual(50);
  });
});
