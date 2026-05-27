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
