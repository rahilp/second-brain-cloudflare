import { describe, it, expect, vi, beforeEach } from "vitest";
import { derivePattern } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makePatternAI(response: string) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      return makeSseStream(response);
    }),
  } as unknown as Ai;
}

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

const sampleRows = [
  { id: "1", content: "I prefer building things in TypeScript over JavaScript." },
  { id: "2", content: "I always reach for TypeScript when starting a new project." },
  { id: "3", content: "I chose TypeScript for this project because of type safety." },
  { id: "4", content: "Switched another service to TypeScript this week." },
  { id: "5", content: "I like TypeScript's type inference features." },
];

describe("derivePattern()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("stores pattern when LLM returns sentence starting with 'You tend to'", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend to reach for TypeScript for all new projects.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("You tend to reach for TypeScript for all new projects.");
  });

  it("stores pattern when LLM returns sentence starting with \"There's a recurring\"", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("There's a recurring preference for strongly-typed languages.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("There's a recurring preference for strongly-typed languages.");
  });

  it("stores pattern when LLM returns sentence starting with 'Across your memories'", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("Across your memories, TypeScript is your default choice.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("Across your memories, TypeScript is your default choice.");
  });

  it("stores pattern with auto-pattern tag", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend to prefer TypeScript in all your projects.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("auto-pattern");
  });

  it("stores pattern with source=system", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend to prefer TypeScript in all your projects.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries[0].source).toBe("system");
  });

  it("does not store when LLM returns NONE", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("NONE") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries).toHaveLength(0);
  });

  it("does not store when LLM returns empty string", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries).toHaveLength(0);
  });

  it("does not store when LLM returns a sentence with invalid prefix", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("This person really likes TypeScript.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    expect(db.entries).toHaveLength(0);
  });

  it("does not throw when LLM call fails — non-fatal", async () => {
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          throw new Error("AI unavailable");
        }),
      } as unknown as Ai,
    });
    const { ctx } = makeCtx();
    await expect(derivePattern(sampleRows, env, ctx)).resolves.toBeUndefined();
  });

  it("uses the reasoning model (not the fast model) for the LLM call", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend to prefer TypeScript.") });
    const { ctx, drain } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    await drain();
    const aiRunMock = env.AI.run as ReturnType<typeof vi.fn>;
    const nonEmbedCalls = aiRunMock.mock.calls.filter(
      ([model]: [string]) => model !== "@cf/baai/bge-small-en-v1.5"
    );
    expect(nonEmbedCalls[0][0]).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });

  it("samples at most 20 rows from the input", async () => {
    const lotsOfRows = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      content: `Memory ${i}`,
    }));
    env = makeTestEnv(db, { AI: makePatternAI("NONE") });
    const { ctx } = makeCtx();
    await derivePattern(lotsOfRows, env, ctx);
    const aiRunMock = env.AI.run as ReturnType<typeof vi.fn>;
    const nonEmbedCall = aiRunMock.mock.calls.find(
      ([model]: [string]) => model !== "@cf/baai/bge-small-en-v1.5"
    );
    const prompt: string = nonEmbedCall![1].messages[0].content;
    // Only memories [1]–[20] should appear in the prompt
    expect(prompt).toContain("[20]");
    expect(prompt).not.toContain("[21]");
  });

  it("includes memory content in the prompt", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("NONE") });
    const { ctx } = makeCtx();
    await derivePattern(sampleRows, env, ctx);
    const aiRunMock = env.AI.run as ReturnType<typeof vi.fn>;
    const nonEmbedCall = aiRunMock.mock.calls.find(
      ([model]: [string]) => model !== "@cf/baai/bge-small-en-v1.5"
    );
    const prompt: string = nonEmbedCall![1].messages[0].content;
    expect(prompt).toContain("I prefer building things in TypeScript");
  });
});
