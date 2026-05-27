import { describe, it, expect, vi } from "vitest";
import { checkDuplicateAndContradiction } from "../../src/index";
import type { MergeAction } from "../../src/index";
import { makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";

function makeEnv(aiResponse: string, vectorMatches: any[] = [], dbEntries: any[] = []): Env {
  const db = makeTestDb();
  db.entries = dbEntries;
  return {
    DB: db as unknown as D1Database,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: vectorMatches }),
    }),
    AI: {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === "@cf/baai/bge-small-en-v1.5")
          return { data: [new Array(384).fill(0.1)] };
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(aiResponse)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as unknown as Ai,
    AUTH_TOKEN: "test-token",
  };
}

function entry(id: string, content: string) {
  return { id, content, tags: "[]", source: "claude", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0 };
}

function match(id: string, score: number) {
  return { id, score, metadata: { parentId: id } };
}

describe("checkDuplicateAndContradiction()", () => {
  it("returns unique + no contradiction when all matches are below threshold", async () => {
    const env = makeEnv("", [match("a", 0.3)], [entry("a", "I enjoy hiking")]);
    const { duplicate, contradiction } = await checkDuplicateAndContradiction("I live in Paris", env);
    expect(duplicate.status).toBe("unique");
    expect(contradiction.detected).toBe(false);
  });

  it("returns no contradiction when LLM says no contradiction", async () => {
    const env = makeEnv(
      '{"contradicts": false}',
      [match("a", 0.7)],
      [entry("a", "I enjoy hiking")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I live in NYC", env);
    expect(contradiction.detected).toBe(false);
  });

  it("detects a contradiction and returns conflicting_id and reason", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "abc123", "reason": "different city"}',
      [match("abc123", 0.72)],
      [entry("abc123", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA last year", env);
    expect(contradiction.detected).toBe(true);
    expect(contradiction.conflicting_id).toBe("abc123");
    expect(contradiction.reason).toBe("different city");
  });

  it("ignores a hallucinated ID not in the candidate results", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "made-up-id", "reason": "different city"}',
      [match("real-id", 0.72)],
      [entry("real-id", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(false);
  });

  it("returns no contradiction when LLM returns malformed JSON", async () => {
    const env = makeEnv(
      "Sorry, I cannot help with that.",
      [match("a", 0.7)],
      [entry("a", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(false);
  });

  it("returns no contradiction when AI throws", async () => {
    const db = makeTestDb();
    db.entries = [entry("a", "I live in NYC")];
    const env: Env = {
      DB: db as unknown as D1Database,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [match("a", 0.72)] }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          throw new Error("AI service unavailable");
        }),
      } as unknown as Ai,
      AUTH_TOKEN: "test-token",
    };
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(false);
  });

  it("returns blocked duplicate and skips contradiction check", async () => {
    const queryFn = vi.fn().mockResolvedValue({ matches: [match("a", 0.96)] });
    const env = makeEnv("", [match("a", 0.96)], [entry("a", "Original content")]);
    (env.VECTORIZE as any).query = queryFn;
    const { duplicate, contradiction } = await checkDuplicateAndContradiction("Original content", env);
    expect(duplicate.status).toBe("blocked");
    expect(contradiction.detected).toBe(false);
    // AI should only have been called once (for embed), not for contradiction LLM check
    expect((env.AI.run as any).mock.calls.length).toBe(1);
  });

  it("returns flagged duplicate status", async () => {
    // score 0.88 → flagged band; combined prompt runs; "keep_both" is the safe default
    const env = makeEnv('{"action":"keep_both"}', [match("a", 0.88)], [entry("a", "Similar content")]);
    const { duplicate, mergeAction } = await checkDuplicateAndContradiction("Similar content", env);
    expect(duplicate.status).toBe("flagged");
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  // ── Smart merge (flagged band 0.85–0.95) ────────────────────────────────────

  it("returns mergeAction=keep_both for flagged entry when LLM says keep_both", async () => {
    const env = makeEnv('{"action":"keep_both"}', [match("near", 0.88)], [entry("near", "I prefer dark mode")]);
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("returns mergeAction=replace with validated target_id for flagged entry", async () => {
    const env = makeEnv(
      '{"action":"replace","target_id":"near"}',
      [match("near", 0.88)],
      [entry("near", "I use VSCode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I switched to Cursor", env);
    expect(mergeAction).toEqual({ action: "replace", target_id: "near" });
  });

  it("returns mergeAction=merge with target_id and merged_content for flagged entry", async () => {
    const env = makeEnv(
      '{"action":"merge","target_id":"near","merged_content":"I prefer dark mode in all apps, especially at night"}',
      [match("near", 0.88)],
      [entry("near", "I prefer dark mode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode especially at night", env);
    expect(mergeAction).toEqual({
      action: "merge",
      target_id: "near",
      merged_content: "I prefer dark mode in all apps, especially at night",
    });
  });

  it("returns contradiction (not mergeAction) when combined prompt returns contradiction for flagged entry", async () => {
    const env = makeEnv(
      '{"action":"contradiction","conflicting_id":"near","reason":"different city"}',
      [match("near", 0.88)],
      [entry("near", "I live in NYC")]
    );
    const { contradiction, mergeAction } = await checkDuplicateAndContradiction("I live in LA", env);
    expect(contradiction.detected).toBe(true);
    expect(contradiction.conflicting_id).toBe("near");
    expect(mergeAction).toBeNull();
  });

  it("falls back to keep_both when flagged LLM throws", async () => {
    const db = makeTestDb();
    db.entries = [entry("near", "I prefer dark mode")];
    const env: Env = {
      DB: db as unknown as D1Database,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [match("near", 0.88)] }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          throw new Error("AI unavailable");
        }),
      } as unknown as Ai,
      AUTH_TOKEN: "test-token",
    };
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when flagged LLM returns malformed JSON", async () => {
    const env = makeEnv("Sorry, I cannot help.", [match("near", 0.88)], [entry("near", "I prefer dark mode")]);
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when replace target_id is a hallucinated ID", async () => {
    const env = makeEnv(
      '{"action":"replace","target_id":"made-up-id"}',
      [match("real-id", 0.88)],
      [entry("real-id", "I use VSCode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I switched to Cursor", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when merge target_id is hallucinated", async () => {
    const env = makeEnv(
      '{"action":"merge","target_id":"fake-id","merged_content":"combined text"}',
      [match("real-id", 0.88)],
      [entry("real-id", "I prefer dark mode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode at night", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when merge merged_content is empty", async () => {
    const env = makeEnv(
      '{"action":"merge","target_id":"near","merged_content":"   "}',
      [match("near", 0.88)],
      [entry("near", "I prefer dark mode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("returns mergeAction=null for non-flagged entries (0.45–0.85 range unchanged)", async () => {
    const env = makeEnv(
      '{"contradicts": false}',
      [match("a", 0.72)],
      [entry("a", "I enjoy hiking")]
    );
    const { mergeAction, contradiction } = await checkDuplicateAndContradiction("I live in Paris", env);
    expect(mergeAction).toBeNull();
    expect(contradiction.detected).toBe(false);
  });

  it("returns mergeAction=null for blocked entries", async () => {
    const env = makeEnv("", [match("a", 0.97)], [entry("a", "Original content")]);
    const { mergeAction, contradiction } = await checkDuplicateAndContradiction("Original content", env);
    expect(mergeAction).toBeNull();
    expect(contradiction.detected).toBe(false);
  });

  it("uses contradiction-only prompt (not combined) for 0.45–0.85 range", async () => {
    // AI mock returns old contradiction format — should still be parsed correctly
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "abc123", "reason": "different city"}',
      [match("abc123", 0.72)],
      [entry("abc123", "I live in NYC")]
    );
    const { contradiction, mergeAction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(true);
    expect(contradiction.conflicting_id).toBe("abc123");
    expect(mergeAction).toBeNull();
  });
});
