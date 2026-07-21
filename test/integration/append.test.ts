import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// Content just over CHUNK_MAX_CHARS (1600) to trigger the full re-embed path
const LONG_CONTENT = "a".repeat(1601);

describe("POST /append", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { addition: "update" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when addition is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "abc" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("auto-links the entry to a similar neighbor after appending (#16)", async () => {
    db.entries.push({ id: "target", content: "Original note", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    db.entries.push({ id: "neighbor", content: "Related memory", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "neighbor", score: 0.85, metadata: { parentId: "neighbor" } }] }),
      }),
    });

    const res = await worker.fetch(req("POST", "/append", { body: { id: "target", addition: "New related detail" } }), env, ctx);
    expect(res.status).toBe(200);

    const e = db.edges.find((x: any) => x.type === "relates_to");
    expect(e).toBeTruthy();
    expect([e.source_id, e.target_id].sort()).toEqual(["neighbor", "target"]);
    expect(e.provenance).toBe("inferred");
  });

  it("does not link a loosely-related neighbor below the threshold", async () => {
    db.entries.push({ id: "target", content: "Original note", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "loose", score: 0.6, metadata: { parentId: "loose" } }] }),
      }),
    });

    const res = await worker.fetch(req("POST", "/append", { body: { id: "target", addition: "New detail" } }), env, ctx);
    expect(res.status).toBe(200);
    expect(db.edges).toHaveLength(0);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "no-such-id", addition: "update" } }), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("appends to existing entry", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries[0].content).toContain("Original content");
    expect(db.entries[0].content).toContain("New info");
  });

  // ── Short append: append-only path (≤ CHUNK_MAX_CHARS) ──────────────────────

  it("short append: uses -update- vector ID style, does not delete old vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Short original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Small addition" } }),
      env,
      ctx
    );

    // vector_ids should have a new -update- entry appended, not chunk-style IDs
    const vectorIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(vectorIds).toHaveLength(2);
    expect(vectorIds[0]).toBe("entry-1");
    expect(vectorIds[1]).toMatch(/^entry-1-update-\d+$/);
    // Old vectors should NOT be deleted on the short path
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  // ── Oversized append: full re-embed path (> CHUNK_MAX_CHARS) ────────────────

  it("oversized append: triggers full re-embed and deletes old vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1","entry-1-update-111"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    // D1 content updated with full combined text
    expect(db.entries[0].content).toContain(LONG_CONTENT);
    expect(db.entries[0].content).toContain("More info");

    // vector_ids updated to chunk-style IDs (not -update- style)
    const vectorIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(vectorIds.every((id: string) => !id.includes("-update-"))).toBe(true);

    // Old vectors deleted
    expect(deleteByIdsMock).toHaveBeenCalledWith(["entry-1", "entry-1-update-111"]);
  });

  it("oversized append: new vectors written before old ones are deleted (safe ordering)", async () => {
    const callOrder: string[] = [];
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockImplementation(async () => { callOrder.push("upsert"); return { mutationId: "m" }; }),
        deleteByIds: vi.fn().mockImplementation(async () => { callOrder.push("delete"); return { mutationId: "m" }; }),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(callOrder.indexOf("upsert")).toBeLessThan(callOrder.indexOf("delete"));
  });

  it("oversized append: re-embed failure fails loud, D1 unchanged, old vectors kept (regression #212)", async () => {
    // The oversized-append re-embed must run before D1 is mutated. On failure the
    // handler returns an error and leaves content + vectors intact — never commits
    // the new content and then deletes every vector.
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        upsert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
        deleteByIds: deleteByIdsMock,
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(500);
    // D1 content unchanged — the append did not commit.
    expect(db.entries[0].content).toBe(LONG_CONTENT);
    // Old vectors never deleted.
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("oversized append: old vector deletion failure is non-fatal", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete failed")),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("populates per-tag metadata keys when entry has non-empty tags (short path)", async () => {
    db.entries.push({
      id: "tagged-entry",
      content: "Original",
      tags: '["work","idea"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "tagged-entry", addition: "Short update" } }),
      env, ctx
    );
    expect(res.status).toBe(200);

    // Verify Vectorize.insert was called with tag_* metadata fields
    const insertMock = env.VECTORIZE.insert as ReturnType<typeof import("vitest").vi.fn>;
    const vectors = insertMock.mock.calls[0][0] as any[];
    expect(vectors[0].metadata).toMatchObject({ tag_work: true, tag_idea: true });
  });

  it("returns 500 when appendToEntry throws due to Vectorize failure (short path)", async () => {
    db.entries.push({
      id: "fail-entry",
      content: "Short content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const failEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("Vectorize unavailable")),
      }),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "fail-entry", addition: "short addition" } }),
      failEnv, ctx
    );
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });
});
