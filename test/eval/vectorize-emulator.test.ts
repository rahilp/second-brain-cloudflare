import { afterEach, describe, expect, it, vi } from "vitest";
import { queryVectorizeScoped, resetVectorizeFilterState } from "../../src/vectorize/scope";
import { controlledVector, cosine, hashVector } from "./vectors";
import { ExactVectorize } from "./vectorize-emulator";

const DIMS = 16;
const query = hashVector("query", DIMS);

async function seeded() {
  const index = new ExactVectorize({ dimensions: DIMS });
  await index.upsert([
    { id: "a", values: controlledVector(query, 0.9, "a"), metadata: { workspace_id: "w1", parentId: "a" } },
    { id: "b", values: controlledVector(query, 0.5, "b"), metadata: { workspace_id: "w2", parentId: "b" } },
    { id: "c", values: controlledVector(query, 0.7, "c"), metadata: { workspace_id: "w1", parentId: "c", tag_x: true } },
  ]);
  return index;
}

afterEach(() => resetVectorizeFilterState());

describe("ExactVectorize", () => {
  it("matches brute-force exact cosine top-k on deterministic random vectors", async () => {
    const index = new ExactVectorize({ dimensions: DIMS });
    const vectors = Array.from({ length: 64 }, (_, i) => ({
      id: `v${String(i).padStart(2, "0")}`,
      values: hashVector(`random-${i}`, DIMS),
    }));
    await index.upsert(vectors);

    for (let trial = 0; trial < 8; trial++) {
      const probe = hashVector(`probe-${trial}`, DIMS);
      const storedProbe = Array.from(Float32Array.from(probe));
      const expected = vectors
        .map(v => ({ id: v.id, score: cosine(Array.from(Float32Array.from(v.values)), storedProbe) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 10);
      const result = await index.query(probe, { topK: 10 });
      expect(result.count).toBe(10);
      expect(result.matches.map(m => m.id)).toEqual(expected.map(v => v.id));
      result.matches.forEach((match, i) => expect(match.score).toBeCloseTo(expected[i].score, 12));
    }
  });

  it("returns the requested metadata and values with the scored match shape", async () => {
    const index = await seeded();
    const result = await index.query(query, { topK: 3, returnMetadata: "all", returnValues: true });
    expect(result.matches.map(m => m.id)).toEqual(["a", "c", "b"]);
    expect(result.matches[0].score).toBeCloseTo(0.9, 6);
    expect(result.matches[0].metadata).toMatchObject({ workspace_id: "w1", parentId: "a" });
    expect(cosine(result.matches[0].values as number[], query)).toBeCloseTo(0.9, 6);
    const bare = (await index.query(query, { topK: 1 })).matches[0];
    expect(bare).toHaveProperty("id", "a");
    expect(bare).toHaveProperty("score");
    expect(bare).not.toHaveProperty("metadata");
    expect(bare).not.toHaveProperty("values");
  });

  it("applies workspace and scalar metadata filters before taking top-k", async () => {
    const index = await seeded();
    const ids = async (filter: Record<string, unknown>) =>
      (await index.query(query, { topK: 5, filter })).matches.map(m => m.id);
    expect(await ids({ workspace_id: { $in: ["w1"] } })).toEqual(["a", "c"]);
    expect(await ids({ workspace_id: { $eq: "w2" } })).toEqual(["b"]);
    expect(await ids({ workspace_id: { $ne: "w1" } })).toEqual(["b"]);
    expect(await ids({ workspace_id: { $nin: ["w1", "w2"] } })).toEqual([]);
    expect(await ids({ workspace_id: "w1" })).toEqual(["a", "c"]);
    expect(await ids({ tag_x: true })).toEqual(["c"]);
    expect(await ids({ workspace_id: { $in: [] } })).toEqual([]);
  });

  it("never returns another workspace under a workspace filter", async () => {
    const index = new ExactVectorize({ dimensions: DIMS });
    const workspaces = ["alpha", "beta", "gamma", "delta"];
    await index.upsert(workspaces.flatMap((workspace_id, wi) =>
      Array.from({ length: 20 }, (_, i) => ({
        id: `${workspace_id}-${i}`,
        values: controlledVector(query, wi === 0 ? 0.2 + i / 1000 : 0.8 + i / 1000, `${workspace_id}-${i}`),
        metadata: { workspace_id },
      })),
    ));
    for (const workspace_id of workspaces) {
      for (const topK of [1, 5, 25]) {
        const result = await index.query(query, {
          topK,
          returnMetadata: "all",
          filter: { workspace_id: { $in: [workspace_id] } },
        });
        expect(result.matches.every(m => m.metadata?.workspace_id === workspace_id)).toBe(true);
        expect(result.matches).toHaveLength(Math.min(topK, 20));
      }
    }
  });

  it("overwrites upserts, preserves missing-id behavior, and deletes by ID", async () => {
    const index = await seeded();
    expect((await index.getByIds(["a", "missing"])).map(v => v.id)).toEqual(["a"]);
    await index.upsert([{ id: "b", values: controlledVector(query, 0.99, "replacement"), metadata: { workspace_id: "w1" } }]);
    expect(index.size).toBe(3);
    expect((await index.getByIds(["b"]))[0].metadata).toEqual({ workspace_id: "w1" });
    expect((await index.query(query, { topK: 1 })).matches[0].id).toBe("b");
    await index.deleteByIds(["b", "missing"]);
    expect((await index.query(query, { topK: 5 })).matches.map(m => m.id)).toEqual(["a", "c"]);
  });

  it("inserts new append chunks and reports index size", async () => {
    const index = new ExactVectorize({ dimensions: 2 });
    await index.insert([{ id: "update-1", values: [1, 0], metadata: { workspace_id: "w1" } }]);
    expect(await index.getByIds(["update-1"])).toEqual([
      { id: "update-1", values: [1, 0], metadata: { workspace_id: "w1" } },
    ]);
    expect(await index.describe()).toMatchObject({ dimensions: 2, vectorCount: 1 });
    await index.insert([{ id: "update-1", values: [0, 1] }, { id: "update-2", values: [0, 1] }]);
    expect(await index.getByIds(["update-1", "update-2"])).toEqual([
      { id: "update-1", values: [1, 0], metadata: { workspace_id: "w1" } },
      { id: "update-2", values: [0, 1] },
    ]);
    await index.insert([{ id: "same-batch", values: [1, 0] }, { id: "same-batch", values: [0, 1] }]);
    expect((await index.getByIds(["same-batch"]))[0].values).toEqual([1, 0]);
  });

  it("returns the whole smaller index and breaks score ties by ascending ID", async () => {
    const index = new ExactVectorize({ dimensions: 2 });
    await index.upsert([{ id: "z", values: [1, 0] }, { id: "m", values: [1, 0] }]);
    const result = await index.query([1, 0], { topK: 50 });
    expect(result.count).toBe(2);
    expect(result.matches.map(m => m.id)).toEqual(["m", "z"]);
    expect((await index.query([1, 0], { topK: 100 })).count).toBe(2);
    expect((await index.query([1, 0], { topK: 100, returnMetadata: "indexed" })).count).toBe(2);
    await expect(index.query([1, 0], { topK: 101 })).rejects.toThrow(/topK/);
    await expect(index.query([1, 0], { topK: 51, returnValues: true })).rejects.toThrow(/topK/);
    await expect(index.query([1, 0], { topK: 51, returnMetadata: "all" })).rejects.toThrow(/topK/);
    await expect(index.upsert([{ id: "bad", values: [1, 0, 0] }])).rejects.toThrow(/dimension/);
    await expect(index.query([1, 0, 0], { topK: 1 })).rejects.toThrow(/dimension/);
  });

  it("rejects unsupported filters so queryVectorizeScoped takes its documented fallback", async () => {
    const index = await seeded();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const scoped = await queryVectorizeScoped<{ id: string; metadata?: Record<string, unknown> }>(
        index as never,
        query,
        { topK: 3, filter: { workspace_id: { $in: ["w1"] } } },
      );
      expect(scoped.degraded).toBe(false);
      expect(scoped.matches.map(m => m.id)).toEqual(["a", "c"]);
      resetVectorizeFilterState();

      const degraded = await queryVectorizeScoped<{ id: string }>(
        index as never, query, { topK: 3, filter: { workspace_id: { $unsupported: "w1" } } as never },
      );
      expect(degraded.degraded).toBe(true);
      expect(degraded.matches.map(m => m.id)).toEqual(["a", "c", "b"]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("rejects malformed filter keys and an empty filter with filter-matching errors", async () => {
    const index = await seeded();
    for (const filter of [{}, { $bad: 1 }, { "a.b": 1 }, { 'a"b': 1 }, { "": 1 }, { ["x".repeat(513)]: 1 }]) {
      await expect(index.query(query, { filter })).rejects.toThrow(/filter/i);
    }
  });

  it("requires configured metadata indexes and returns only indexed metadata", async () => {
    const index = new ExactVectorize({ dimensions: 2, indexedProperties: ["workspace_id"] });
    await index.upsert([{ id: "a", values: [1, 0], metadata: { workspace_id: "w1", note: "private" } }]);
    expect((await index.query([1, 0], { filter: { workspace_id: "w1" }, returnMetadata: "indexed" })).matches[0].metadata)
      .toEqual({ workspace_id: "w1" });
    expect((await index.query([1, 0], { returnMetadata: "all" })).matches[0].metadata)
      .toEqual({ workspace_id: "w1", note: "private" });
    // Real Vectorize answers a filter on an unindexed field with nothing, not an error (#394).
    expect(await index.query([1, 0], { filter: { note: "private" } })).toEqual({ count: 0, matches: [] });
  });

  it("degrades a scoped query when workspace_id is not indexed", async () => {
    const index = new ExactVectorize({ dimensions: DIMS, indexedProperties: [] });
    await index.upsert([{ id: "a", values: query, metadata: { workspace_id: "w1" } }]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await queryVectorizeScoped<{ id: string }>(
        index as never, query, { topK: 1, filter: { workspace_id: { $in: ["w1"] } } },
      );
      expect(result.degraded).toBe(true);
      expect(result.matches.map(m => m.id)).toEqual(["a"]);
      expect(errorLog).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("rejects namespaces rather than silently querying or storing outside scope", async () => {
    const index = new ExactVectorize({ dimensions: 2 });
    await expect(index.upsert([{ id: "a", values: [1, 0], namespace: "other" }])).rejects.toThrow(/namespace/i);
    await expect(index.insert([{ id: "a", values: [1, 0], namespace: "other" }])).rejects.toThrow(/namespace/i);
    await expect(index.query([1, 0], { namespace: "other" })).rejects.toThrow(/namespace/i);
  });

  it("enforces UTF-8 ID length at 64 bytes for insert and upsert", async () => {
    const index = new ExactVectorize({ dimensions: 2 });
    await index.upsert([{ id: "é".repeat(32), values: [1, 0] }]);
    await index.insert([{ id: "x".repeat(64), values: [1, 0] }]);
    await expect(index.upsert([{ id: "é".repeat(33), values: [1, 0] }])).rejects.toThrow(/id/i);
    await expect(index.insert([{ id: "x".repeat(65), values: [1, 0] }])).rejects.toThrow(/id/i);
  });

  it("enforces the 1000-vector Workers batch limit without partial writes", async () => {
    const index = new ExactVectorize({ dimensions: 2 });
    const batch = Array.from({ length: 1001 }, (_, i) => ({ id: `v${i}`, values: [1, 0] }));
    await index.upsert(batch.slice(0, 1000));
    expect(index.size).toBe(1000);
    await expect(index.insert(batch)).rejects.toThrow(/batch/i);
    await expect(index.upsert(batch)).rejects.toThrow(/batch/i);
    expect(index.size).toBe(1000);
  });

  it("enforces 10 KiB of JSON metadata per vector", async () => {
    const index = new ExactVectorize({ dimensions: 2 });
    await index.upsert([{ id: "a", values: [1, 0], metadata: { c: "x".repeat(10232) } }]);
    expect(index.size).toBe(1);
    await expect(index.insert([{ id: "b", values: [1, 0], metadata: { c: "x".repeat(10233) } }]))
      .rejects.toThrow(/metadata/i);
    expect(index.size).toBe(1);
  });

  it("requires compact filter JSON to be smaller than 2048 bytes", async () => {
    const index = await seeded();
    expect((await index.query(query, { filter: { note: "x".repeat(2036) } })).count).toBe(0);
    await expect(index.query(query, { filter: { note: "x".repeat(2037) } })).rejects.toThrow(/filter/i);
  });
});
