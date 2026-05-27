import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

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
    expect(deleteByIdsMock).toHaveBeenCalledWith(["existing-id", "existing-id-chunk-1"]);
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

  it("contradiction detected via combined prompt in flagged band — new entry stored, conflicting removed", async () => {
    seedEntry(db, "old-id", "I live in NYC");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-id", score: 0.88, metadata: { parentId: "old-id" } }],
        }),
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
    expect(db.entries.some((e: any) => e.id === "old-id")).toBe(false);
    expect(db.entries).toHaveLength(1);
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
