import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// A stateful Vectorize mock that faithfully models Cloudflare's semantics:
// insert() SKIPS ids that already exist, upsert() OVERWRITES them. The default
// mock's insert/upsert are indistinguishable no-op spies, which is exactly why
// the stale-vector bug (#208) went unnoticed — this reproduces it behaviorally.
function makeStatefulVectorize(seed: any[] = []) {
  const store = new Map<string, any>();
  for (const v of seed) store.set(v.id, v);
  const mock = makeVectorizeMock({
    insert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) if (!store.has(v.id)) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    upsert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => {
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    }),
    getByIds: vi.fn(async (ids: string[]): Promise<any> =>
      ids.map(id => store.get(id)).filter(Boolean)),
    query: vi.fn(async (): Promise<any> => ({ matches: [] })),
  });
  return { store, mock };
}

function seedEntry(db: D1Mock, overrides: Partial<ReturnType<typeof makeEntry>> = {}) {
  const entry = makeEntry(overrides);
  db.entries.push(entry);
  return entry;
}

function makeEntry(overrides: Partial<{
  id: string; content: string; tags: string; source: string;
  created_at: number; vector_ids: string; recall_count: number; importance_score: number;
}> = {}) {
  return {
    id: "entry-abc",
    content: "Original content",
    tags: '["work"]',
    source: "api",
    created_at: Date.now(),
    vector_ids: '["entry-abc"]',
    recall_count: 0,
    importance_score: 3,
    ...overrides,
  };
}

describe("POST /update", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "x", content: "new" }, token: null }),
      env, ctx
    );
    expect(res.status).toBe(401);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { content: "new content" } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/id/);
  });

  it("returns 400 when content is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc" } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/content/);
  });

  it("returns 400 when content is blank whitespace", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "   " } }),
      env, ctx
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when entry does not exist", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "nonexistent", content: "new content" } }),
      env, ctx
    );
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/nonexistent/);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("updates D1 content and returns ok:true with id", async () => {
    seedEntry(db);
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("entry-abc");
    expect(db.entries[0].content).toBe("Updated content");
  });

  it("preserves existing tags and source after update", async () => {
    seedEntry(db, { tags: '["work","important"]', source: "claude" });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content" } }),
      env, ctx
    );
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("important");
    expect(db.entries[0].source).toBe("claude");
  });

  // ── Hashtag merge ───────────────────────────────────────────────────────────

  it("merges new #hashtag from content into tags and strips it from stored content", async () => {
    seedEntry(db, { tags: '["work"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #newtag" } }),
      env, ctx
    );
    expect(db.entries[0].content).toBe("Updated content");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("newtag");
  });

  it("does not duplicate a tag already present when the same #tag appears in content", async () => {
    seedEntry(db, { tags: '["work"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #work" } }),
      env, ctx
    );
    expect(db.entries[0].content).toBe("Updated content");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags.filter((t: string) => t === "work")).toHaveLength(1);
  });

  it("re-embeds on update via upsert (overwrites the reused vector id)", async () => {
    // The re-embed must use upsert, not insert: a single-chunk entry's vector
    // id equals the entry id, and Vectorize insert() skips ids that already
    // exist, so insert would leave the old embedding in place.
    const upsertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, insert: insertMock }),
    });
    seedEntry(db);
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Brand new content" } }),
      env, ctx
    );
    expect(upsertMock).toHaveBeenCalledOnce();
    const upsertedVectors = upsertMock.mock.calls[0][0] as any[];
    expect(upsertedVectors[0].id).toBe("entry-abc");
    expect(upsertedVectors[0].metadata.content).toBe("Brand new content");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("refreshes the stored single-chunk vector on update (regression #208)", async () => {
    // Reproduces the reported bug end-to-end against a store with real
    // insert/upsert semantics. The entry already has a vector keyed by its id
    // (as `remember` would have created); updating must overwrite it. With the
    // old insert() call the write is skipped and the stale content survives.
    const { store, mock } = makeStatefulVectorize([
      {
        id: "entry-abc",
        values: new Array(384).fill(0.1),
        metadata: { content: "Original content", parentId: "entry-abc", chunkIndex: 0, totalChunks: 1 },
      },
    ]);
    env = makeTestEnv(db, { VECTORIZE: mock });
    seedEntry(db, { content: "Original content", vector_ids: '["entry-abc"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Brand new content" } }),
      env, ctx
    );

    // The vector the entry is keyed by must now hold the new content.
    expect(store.get("entry-abc")?.metadata.content).toBe("Brand new content");
  });

  // ── Vector orphan prevention ────────────────────────────────────────────────

  it("deletes only stale vectors, preserving the re-embedded (reused) id", async () => {
    // Entry previously had 2 chunks. The short update re-embeds to a single
    // chunk keyed by the entry id ("entry-abc"), which must NOT be deleted —
    // only the now-orphaned "entry-abc-chunk-1" should be removed.
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["entry-abc","entry-abc-chunk-1"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect(deleteByIdsMock.mock.calls[0][0]).toEqual(["entry-abc-chunk-1"]);
  });

  it("does NOT delete the re-embedded single-chunk vector (id-reuse regression)", async () => {
    // Single-chunk entry: vector id == entry id. The re-embed reuses that id,
    // so there is nothing stale — deleting it would make the entry unsearchable.
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("does not call deleteByIds when vector_ids is empty", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: "[]" });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  // ── Non-fatal error handling ────────────────────────────────────────────────

  it("fails loud and leaves the entry untouched when the re-embed throws (regression #212)", async () => {
    // A failed re-embed must NOT commit new content and then delete every vector,
    // which would leave the entry silently unsearchable. Embed-first: on failure the
    // caller gets a 500 and D1 content + vectors are unchanged.
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db); // content: "Original content", vector_ids: ["entry-abc"]
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    // D1 content stays as it was — the update did not commit.
    expect(db.entries[0].content).toBe("Original content");
    // The old vectors were never deleted.
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("returns ok:true even when deleteByIds throws", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("Delete failed")),
      }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  // ── Safe ordering ───────────────────────────────────────────────────────────

  it("reads vector_ids before D1 content update (safe ordering)", async () => {
    // Seed entry with known vector_ids
    seedEntry(db, { vector_ids: '["old-vec-1","old-vec-2"]' });

    const callOrder: string[] = [];
    const deleteByIdsMock = vi.fn().mockImplementation(async (ids: string[]) => {
      callOrder.push(`delete:${ids.join(",")}`);
      return { mutationId: "m" };
    });
    const upsertMock = vi.fn().mockImplementation(async () => {
      callOrder.push("upsert");
      return { mutationId: "m" };
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ upsert: upsertMock, deleteByIds: deleteByIdsMock }),
    });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Replaced content" } }),
      env, ctx
    );

    // re-embed must happen before delete — new vectors before old ones removed
    const insertIdx = callOrder.indexOf("upsert");
    const deleteIdx = callOrder.findIndex(s => s.startsWith("delete:"));
    expect(insertIdx).toBeLessThan(deleteIdx);
    expect(callOrder[deleteIdx]).toContain("old-vec-1");
    expect(callOrder[deleteIdx]).toContain("old-vec-2");
  });
});
