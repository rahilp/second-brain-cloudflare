import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureEntry } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function makeContradictionAI(response: string) {
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

describe("captureEntry()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("stores a plain entry and returns status=stored with a UUID id", async () => {
    const { ctx } = makeCtx();
    const result = await captureEntry("My first memory", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    if (result.status !== "stored") return;
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("My first memory");
    expect(db.entries[0].source).toBe("api");
  });

  it("uses the provided source value", async () => {
    const { ctx } = makeCtx();
    await captureEntry("Memory from claude", [], "claude", env, ctx);
    expect(db.entries[0].source).toBe("claude");
  });

  // ── Hashtag extraction ──────────────────────────────────────────────────────

  it("strips hashtags from content and stores them as tags", async () => {
    const { ctx } = makeCtx();
    const result = await captureEntry("went for a run #health #fitness", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    expect(db.entries[0].content).toBe("went for a run");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("health");
    expect(tags).toContain("fitness");
  });

  it("merges explicit tags with hashtag tags and deduplicates case-insensitively", async () => {
    const { ctx } = makeCtx();
    await captureEntry("note #health", ["Health", "fitness"], "api", env, ctx);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags.filter(t => t === "health")).toHaveLength(1);
    expect(tags).toContain("fitness");
  });

  it("falls back to raw content when input is only hashtags", async () => {
    const { ctx } = makeCtx();
    await captureEntry("#task", [], "api", env, ctx);
    expect(db.entries[0].content).toBe("#task");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("task");
  });

  it("trims leading/trailing whitespace before storing", async () => {
    const { ctx } = makeCtx();
    await captureEntry("  padded note  ", [], "api", env, ctx);
    expect(db.entries[0].content).toBe("padded note");
  });

  // ── Duplicate: blocked ──────────────────────────────────────────────────────

  it("returns status=blocked and does not insert when similarity >= 0.95", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.97, metadata: { parentId: "existing" } }],
        }),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("Duplicate content", [], "api", env, ctx);
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.matchId).toBe("existing");
    expect(result.score).toBeCloseTo(0.97);
    expect(db.entries).toHaveLength(0);
  });

  it("does not call ctx.waitUntil when blocked (no scoring needed)", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.97, metadata: { parentId: "existing" } }],
        }),
      }),
    });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext;
    await captureEntry("Duplicate content", [], "api", env, ctx);
    expect(pending).toHaveLength(0);
  });

  // ── Duplicate: flagged ──────────────────────────────────────────────────────

  it("returns status=flagged, stores entry, and adds duplicate-candidate tag", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
        }),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("Similar note", [], "api", env, ctx);
    expect(result.status).toBe("flagged");
    if (result.status !== "flagged") return;
    expect(result.matchId).toBe("near");
    expect(db.entries).toHaveLength(1);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("duplicate-candidate");
  });

  // ── Contradiction ───────────────────────────────────────────────────────────

  it("returns status=contradiction, stores new entry, and removes conflicting entry", async () => {
    db.entries.push({
      id: "old-entry",
      content: "I live in NYC",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-entry", score: 0.72, metadata: { parentId: "old-entry" } }],
        }),
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "old-entry", "reason": "different city"}'),
    });

    const { ctx } = makeCtx();
    const result = await captureEntry("I moved to LA", [], "api", env, ctx);

    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    expect(result.resolvedConflict).toBe("old-entry");
    expect(result.reason).toBe("different city");
    expect(typeof result.id).toBe("string");

    // New entry stored, conflicting entry removed
    expect(db.entries.some(e => e.id === result.id)).toBe(true);
    expect(db.entries.some(e => e.id === "old-entry")).toBe(false);
  });

  it("adds contradiction-resolved tag when contradiction detected", async () => {
    db.entries.push({
      id: "conflict",
      content: "I live in NYC",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "conflict", score: 0.72, metadata: { parentId: "conflict" } }],
        }),
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "conflict", "reason": "changed location"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I moved to LA", [], "api", env, ctx);
    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    const storedEntry = db.entries.find(e => e.id === result.id);
    const tags: string[] = JSON.parse(storedEntry!.tags);
    expect(tags).toContain("contradiction-resolved");
  });

  // ── Smart merge: replace ────────────────────────────────────────────────────

  it("replace: updates existing entry content, does NOT insert a new entry", async () => {
    db.entries.push({
      id: "existing", content: "I use VSCode", tags: '["work"]', source: "api",
      created_at: Date.now(), vector_ids: '["existing"]', recall_count: 0, importance_score: 3,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I switched to Cursor", [], "api", env, ctx);
    expect(result.status).toBe("replaced");
    if (result.status !== "replaced") return;
    expect(result.id).toBe("existing");
    // No new entry — only the existing one remains
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("I switched to Cursor");
  });

  it("replace: deletes old vectors after re-embedding", async () => {
    db.entries.push({
      id: "existing", content: "I use VSCode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["existing","existing-chunk-1"]', recall_count: 0, importance_score: 0,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx } = makeCtx();
    await captureEntry("I switched to Cursor", [], "api", env, ctx);
    expect(deleteByIdsMock).toHaveBeenCalledWith(["existing", "existing-chunk-1"]);
  });

  it("replace: falls through to normal insert when target not found in DB", async () => {
    // Vectorize returns a match but D1 has no corresponding entry
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "ghost-id", score: 0.88, metadata: { parentId: "ghost-id" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"replace","target_id":"ghost-id"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I switched to Cursor", [], "api", env, ctx);
    // Falls through → stores as a new entry
    expect(result.status).toBe("flagged");
    expect(db.entries).toHaveLength(1);
  });

  // ── Smart merge: merge ──────────────────────────────────────────────────────

  it("merge: updates existing entry with merged_content, does NOT insert a new entry", async () => {
    db.entries.push({
      id: "existing", content: "I prefer dark mode", tags: '["personal"]', source: "api",
      created_at: Date.now(), vector_ids: '["existing"]', recall_count: 0, importance_score: 2,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"merge","target_id":"existing","merged_content":"I prefer dark mode in all apps, especially at night"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I like dark mode especially at night", [], "api", env, ctx);
    expect(result.status).toBe("merged");
    if (result.status !== "merged") return;
    expect(result.id).toBe("existing");
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("I prefer dark mode in all apps, especially at night");
  });

  it("merge: uses merged_content (not new content) for re-embedding", async () => {
    db.entries.push({
      id: "existing", content: "I prefer dark mode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["existing"]', recall_count: 0, importance_score: 0,
    });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
        insert: insertMock,
      }),
      AI: makeContradictionAI('{"action":"merge","target_id":"existing","merged_content":"Combined merged memory"}'),
    });
    const { ctx } = makeCtx();
    await captureEntry("I like dark mode at night", [], "api", env, ctx);
    // The inserted vector metadata should contain the merged content
    const insertedVectors = insertMock.mock.calls[0][0] as any[];
    expect(insertedVectors[0].metadata.content).toBe("Combined merged memory");
  });

  it("merge: deletes old vectors after re-embedding", async () => {
    db.entries.push({
      id: "existing", content: "I prefer dark mode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["existing","existing-chunk-1"]', recall_count: 0, importance_score: 0,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"action":"merge","target_id":"existing","merged_content":"Combined"}'),
    });
    const { ctx } = makeCtx();
    await captureEntry("I like dark mode at night", [], "api", env, ctx);
    expect(deleteByIdsMock).toHaveBeenCalledWith(["existing", "existing-chunk-1"]);
  });

  // ── Smart merge: keep_both falls back to flagged (existing behaviour) ────────

  it("keep_both: stores new entry with duplicate-candidate tag (unchanged behaviour)", async () => {
    db.entries.push({
      id: "near", content: "I prefer dark mode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"keep_both"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I like dark themes", [], "api", env, ctx);
    expect(result.status).toBe("flagged");
    expect(db.entries).toHaveLength(2);
    const tags: string[] = JSON.parse(db.entries[1].tags);
    expect(tags).toContain("duplicate-candidate");
  });

  // ── Importance scoring ──────────────────────────────────────────────────────

  it("schedules importance scoring via ctx.waitUntil for stored entries", async () => {
    const { ctx, drain } = makeCtx();
    await captureEntry("Important decision", [], "api", env, ctx);
    await drain();
    expect(db.entries[0].importance_score).toBeGreaterThanOrEqual(1);
  });

  // ── Non-fatal error handling ────────────────────────────────────────────────

  it("stores to D1 and returns stored even when Vectorize insert throws", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("Vectorize unavailable")),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("Note with broken vectorize", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    expect(db.entries).toHaveLength(1);
  });
});
