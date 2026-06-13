import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

// Prompt-aware AI stub that distinguishes 3 call types:
//   1. embed  — model === "@cf/baai/bge-small-en-v1.5" → return vector
//   2. merge  — prompt contains "Choose exactly one action" → return mergeResponse
//   3. classify — prompt contains "Classify this memory" → return classifyResponse
function makePromptAwareAI(mergeResponse: string, classifyResponse: string): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      const prompt: string = (opts?.messages ?? []).map((m: any) => m.content).join("\n");
      if (prompt.includes("Choose exactly one action")) {
        return makeSseStream(mergeResponse);
      }
      // classify call
      if (prompt.includes("Classify this memory")) {
        return makeSseStream(classifyResponse);
      }
      throw new Error(`Unexpected AI.run call in makePromptAwareAI. Prompt starts: ${prompt.slice(0, 120)}`);
    }),
  } as unknown as Ai;
}

// AI mock that returns a specific LLM response while still handling embed calls
function makeMergeAI(response: string): Ai {
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

function seedEntry(db: D1Mock, id = "existing-id", content = "I use VSCode", vectorIds = '["existing-id"]') {
  db.entries.push({
    id,
    content,
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 1000,
    vector_ids: vectorIds,
    recall_count: 0,
    importance_score: 3,
  });
}

describe("POST /capture — smart merge (flagged band 0.85–0.95)", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
  });

  // ── Replace ─────────────────────────────────────────────────────────────────

  it("returns action=replaced, updates existing entry, does not insert a new one", async () => {
    seedEntry(db);
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"existing-id"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor IDE" } }),
      env, ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.action).toBe("replaced");
    expect(data.id).toBe("existing-id");

    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("I switched to Cursor IDE");
  });

  it("replace: deletes old vectors and re-embeds with new content", async () => {
    seedEntry(db, "existing-id", "I use VSCode", '["existing-id","existing-id-chunk-1"]');
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"existing-id"}'),
    });

    await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor" } }),
      env, ctx
    );

    expect(insertMock).toHaveBeenCalledOnce();
    // Only the stale chunk is deleted; the reused "existing-id" vector survives.
    expect(deleteByIdsMock).toHaveBeenCalledWith(["existing-id-chunk-1"]);
  });

  it("replace: new vector is inserted before old ones are deleted (safe ordering)", async () => {
    seedEntry(db, "existing-id", "I use VSCode", '["old-vec"]');
    const callOrder: string[] = [];
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        insert: vi.fn().mockImplementation(async () => { callOrder.push("insert"); return { mutationId: "m" }; }),
        deleteByIds: vi.fn().mockImplementation(async () => { callOrder.push("delete"); return { mutationId: "m" }; }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"existing-id"}'),
    });

    await worker.fetch(req("POST", "/capture", { body: { content: "Cursor IDE" } }), env, ctx);
    expect(callOrder.indexOf("insert")).toBeLessThan(callOrder.indexOf("delete"));
  });

  // ── Merge ───────────────────────────────────────────────────────────────────

  it("returns action=merged, updates existing entry with merged_content, no new entry", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
      }),
      AI: makeMergeAI('{"action":"merge","target_id":"existing-id","merged_content":"I prefer dark mode in all apps, especially at night"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode especially at night" } }),
      env, ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.action).toBe("merged");
    expect(data.id).toBe("existing-id");

    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("I prefer dark mode in all apps, especially at night");
  });

  it("merge: embeds merged_content (not the raw new content)", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode");
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        insert: insertMock,
      }),
      AI: makeMergeAI('{"action":"merge","target_id":"existing-id","merged_content":"THE MERGED RESULT"}'),
    });

    await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night" } }),
      env, ctx
    );

    const insertedVectors = insertMock.mock.calls[0][0] as any[];
    expect(insertedVectors[0].metadata.content).toBe("THE MERGED RESULT");
  });

  it("merge: deletes old vectors after re-embedding", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode", '["v1","v2"]');
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeMergeAI('{"action":"merge","target_id":"existing-id","merged_content":"Combined"}'),
    });

    await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night" } }),
      env, ctx
    );

    expect(deleteByIdsMock).toHaveBeenCalledWith(["v1", "v2"]);
  });

  // ── keep_both → existing flagged behaviour unchanged ─────────────────────────

  it("keep_both: stores new entry with duplicate-candidate tag (existing behaviour preserved)", async () => {
    seedEntry(db, "near-id", "I prefer dark mode");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "near-id", score: 0.88, metadata: { parentId: "near-id" } }],
        }),
      }),
      AI: makeMergeAI('{"action":"keep_both"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark themes generally" } }),
      env, ctx
    );

    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.warning).toBe("similar");
    expect(db.entries).toHaveLength(2);
    const newTags: string[] = JSON.parse(db.entries[1].tags);
    expect(newTags).toContain("duplicate-candidate");
  });

  // ── Contradiction via combined prompt ─────────────────────────────────────────

  it("contradiction detected via combined prompt in flagged band — new entry stored, conflicting DEPRECATED (not deleted)", async () => {
    seedEntry(db, "old-id", "I live in NYC");
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-id", score: 0.88, metadata: { parentId: "old-id" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeMergeAI('{"action":"contradiction","conflicting_id":"old-id","reason":"different city"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I moved to LA" } }),
      env, ctx
    );

    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.resolved_conflict).toBe("old-id");
    expect(data.reason).toBe("different city");
    // Conflicting row is deprecated (kept in D1), not deleted
    const conflictRow = db.entries.find((e: any) => e.id === "old-id");
    expect(conflictRow).toBeDefined();
    const conflictTags: string[] = JSON.parse(conflictRow!.tags);
    expect(conflictTags).toContain("status:deprecated");
    expect(conflictRow!.vector_ids).toBe("[]");
    // Vectors deleted from Vectorize
    expect(deleteByIdsMock).toHaveBeenCalledWith(["existing-id"]);
    // New entry also stored (total: old deprecated + new = 2)
    expect(db.entries).toHaveLength(2);
  });

  // ── Non-fatal error handling ──────────────────────────────────────────────────

  it("replace: returns ok:true even when Vectorize re-embed throws", async () => {
    seedEntry(db);
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        insert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"existing-id"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor" } }),
      env, ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // D1 content still updated even if Vectorize failed
    expect(db.entries[0].content).toBe("I switched to Cursor");
  });

  it("merge: returns ok:true even when deleteByIds throws", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode", '["old-vec"]');
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete failed")),
      }),
      AI: makeMergeAI('{"action":"merge","target_id":"existing-id","merged_content":"Combined"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night" } }),
      env, ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.action).toBe("merged");
  });

  // ── Canonical guard ───────────────────────────────────────────────────────────

  it("replace: canonical target is NOT overwritten; new entry stored with status=flagged", async () => {
    // importance_score=2 so the existing importance guard (>=4) would NOT fire.
    // Only the new canonical guard should prevent overwrite.
    db.entries.push({
      id: "canonical-id",
      content: "Canonical source of truth",
      tags: '["work","status:canonical"]',
      source: "api",
      created_at: Date.now() - 1000,
      vector_ids: '["canonical-id"]',
      recall_count: 0,
      importance_score: 2,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "canonical-id", score: 0.88, metadata: { parentId: "canonical-id" } }],
        }),
      }),
      AI: makeMergeAI('{"action":"replace","target_id":"canonical-id"}'),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "Replacement attempt" } }),
      env, ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // Result is flagged (not replaced) — HTTP response uses warning:"similar"
    expect(data.warning).toBe("similar");

    // Canonical entry content must be unchanged — NOT overwritten
    const canonical = db.entries.find((e: any) => e.id === "canonical-id");
    expect(canonical?.content).toBe("Canonical source of truth");

    // No new entry was inserted — the early-return guard returns a synthetic ID
    // without persisting to DB (mirrors importance guard behaviour)
    expect(db.entries).toHaveLength(1);
  });

  // ── Classification on smart-merge path ───────────────────────────────────────

  it("merge: classifies the TARGET entry (kind + importance_score set) after draining waitUntil", async () => {
    seedEntry(db, "existing-id", "I prefer dark mode", '["existing-id"]');
    // The seeded entry has no kind tag and importance_score=3 (from seedEntry default).
    const { ctx: testCtx, drain } = makeCtx();
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
      }),
      AI: makePromptAwareAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"I prefer dark mode in all apps"}',
        '{"importance":4,"canonical":false,"kind":"semantic"}'
      ),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode everywhere" } }),
      env, testCtx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.action).toBe("merged");

    // Before drain: classification hasn't run yet
    const target = db.entries.find((e: any) => e.id === "existing-id");
    expect(target).toBeDefined();

    // Drain all waitUntil promises (classification fires here)
    await drain();

    // After drain: importance_score and kind:semantic tag must be set on the target
    const updated = db.entries.find((e: any) => e.id === "existing-id");
    expect(updated!.importance_score).toBe(4);
    const updatedTags: string[] = JSON.parse(updated!.tags);
    expect(updatedTags).toContain("kind:semantic");
  });

  it("replace: classifies the TARGET entry (kind + importance_score set) after draining waitUntil", async () => {
    seedEntry(db, "existing-id", "I use VSCode", '["existing-id"]');
    const { ctx: testCtx, drain } = makeCtx();
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
      }),
      AI: makePromptAwareAI(
        '{"action":"replace","target_id":"existing-id"}',
        '{"importance":2,"canonical":false,"kind":"episodic"}'
      ),
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor IDE" } }),
      env, testCtx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.action).toBe("replaced");

    await drain();

    const updated = db.entries.find((e: any) => e.id === "existing-id");
    expect(updated!.importance_score).toBe(2);
    const updatedTags: string[] = JSON.parse(updated!.tags);
    expect(updatedTags).toContain("kind:episodic");
  });

  // ── Existing functionality unaffected ─────────────────────────────────────────

  it("blocked (≥0.95): still blocked, no LLM call for merge", async () => {
    const aiRunMock = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      throw new Error("LLM should not be called for blocked entries");
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "dup", score: 0.97, metadata: { parentId: "dup" } }],
        }),
      }),
      AI: { run: aiRunMock } as unknown as Ai,
    });

    const res = await worker.fetch(
      req("POST", "/capture", { body: { content: "Duplicate" } }),
      env, ctx
    );

    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.duplicate).toBe(true);
    // LLM called only once — for embed, never for contradiction/merge
    expect(aiRunMock).toHaveBeenCalledOnce();
  });
});
