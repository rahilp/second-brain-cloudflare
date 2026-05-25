import { describe, it, expect, vi } from "vitest";
import { checkContradiction } from "../../src/index";
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

describe("checkContradiction()", () => {
  it("returns not detected when all matches are below threshold", async () => {
    const env = makeEnv("", [match("a", 0.3)], [entry("a", "I enjoy hiking")]);
    const result = await checkContradiction("I live in Paris", env);
    expect(result.detected).toBe(false);
  });

  it("returns not detected when LLM says no contradiction", async () => {
    const env = makeEnv(
      '{"contradicts": false}',
      [match("a", 0.7)],
      [entry("a", "I enjoy hiking")]
    );
    const result = await checkContradiction("I live in NYC", env);
    expect(result.detected).toBe(false);
  });

  it("detects a contradiction and returns conflicting_id and reason", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "abc123", "reason": "different city"}',
      [match("abc123", 0.72)],
      [entry("abc123", "I live in NYC")]
    );
    const result = await checkContradiction("I moved to LA last year", env);
    expect(result.detected).toBe(true);
    expect(result.conflicting_id).toBe("abc123");
    expect(result.reason).toBe("different city");
  });

  it("ignores a hallucinated ID not in the candidate results", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "made-up-id", "reason": "different city"}',
      [match("real-id", 0.72)],
      [entry("real-id", "I live in NYC")]
    );
    const result = await checkContradiction("I moved to LA", env);
    expect(result.detected).toBe(false);
  });

  it("returns not detected when LLM returns malformed JSON", async () => {
    const env = makeEnv(
      "Sorry, I cannot help with that.",
      [match("a", 0.7)],
      [entry("a", "I live in NYC")]
    );
    const result = await checkContradiction("I moved to LA", env);
    expect(result.detected).toBe(false);
  });

  it("returns not detected when AI throws", async () => {
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
    const result = await checkContradiction("I moved to LA", env);
    expect(result.detected).toBe(false);
  });
});