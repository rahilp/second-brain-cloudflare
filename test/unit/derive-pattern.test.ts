import { describe, it, expect, vi, beforeEach } from "vitest";
import { derivePattern } from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/index";

// SSE stream helper — used by scoreImportance (streaming) inside captureEntry
function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

// AI mock that handles:
//   - EMBEDDING_MODEL calls → vector data
//   - streaming LLM calls (scoreImportance inside captureEntry) → SSE stream
//   - non-streaming LLM call (derivePattern itself) → { response: string }
function makePatternAI(patternResponse: string | null = "You tend to work in short focused bursts") {
  return {
    run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
      if (_model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream)
        return makeSseStream("3");
      if (patternResponse === null)
        throw new Error("AI failure");
      return { response: patternResponse };
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

function makeRows(n: number): { id: string; content: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, content: `Memory number ${i + 1}` }));
}

describe("derivePattern()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db, { AI: makePatternAI() });
  });

  // ── Early-return guard ───────────────────────────────────────────────────────

  it("returns without calling AI when rows is empty", async () => {
    const { ctx } = makeCtx();
    await derivePattern([], env, ctx);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns without calling AI when rows.length is 4 (below threshold)", async () => {
    const { ctx } = makeCtx();
    await derivePattern(makeRows(4), env, ctx);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("calls AI when rows.length is exactly 5 (at threshold)", async () => {
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(env.AI.run).toHaveBeenCalled();
  });

  // ── Sampling ─────────────────────────────────────────────────────────────────

  it("only passes first 20 rows to AI even when more are provided", async () => {
    const { ctx } = makeCtx();
    await derivePattern(makeRows(25), env, ctx);
    // First non-embedding call is the pattern derivation call
    const calls = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls;
    const llmCall = calls.find((call: any[]) => call[0] !== "@cf/baai/bge-small-en-v1.5");
    const prompt: string = llmCall![1].messages[0].content;
    expect(prompt).toContain("[20]");
    expect(prompt).not.toContain("[21]");
  });

  it("truncates each memory's content to 300 characters in the prompt", async () => {
    const long = "x".repeat(400);
    const { ctx } = makeCtx();
    await derivePattern([...makeRows(4), { id: "long", content: long }], env, ctx);
    const calls = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls;
    const llmCall = calls.find((call: any[]) => call[0] !== "@cf/baai/bge-small-en-v1.5");
    const prompt: string = llmCall![1].messages[0].content;
    expect(prompt).toContain("x".repeat(300));
    expect(prompt).not.toContain("x".repeat(301));
  });

  it("includes all memory content in the prompt", async () => {
    const rows = [
      { id: "a", content: "Unique memory alpha" },
      { id: "b", content: "Unique memory beta" },
      { id: "c", content: "Unique memory gamma" },
      { id: "d", content: "Unique memory delta" },
      { id: "e", content: "Unique memory epsilon" },
    ];
    const { ctx } = makeCtx();
    await derivePattern(rows, env, ctx);
    const calls = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls;
    const llmCall = calls.find((call: any[]) => call[0] !== "@cf/baai/bge-small-en-v1.5");
    const prompt: string = llmCall![1].messages[0].content;
    for (const r of rows) expect(prompt).toContain(r.content);
  });

  it("sends a non-streaming request to AI (no stream flag)", async () => {
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    const calls = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls;
    const llmCall = calls.find((call: any[]) => call[0] !== "@cf/baai/bge-small-en-v1.5");
    expect(llmCall![1].stream).toBeUndefined();
    expect(llmCall![1].max_tokens).toBeDefined();
  });

  // ── Response filtering ────────────────────────────────────────────────────────

  it("does not store entry when AI returns NONE", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("NONE") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(0);
  });

  it("does not store entry when AI returns empty string", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(0);
  });

  it("does not store entry when AI returns only whitespace", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("   ") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(0);
  });

  it("does not store entry when AI returns NONE with surrounding whitespace", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("  NONE  ") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(0);
  });

  it("does not store entry when AI response lacks a valid starter", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("I notice you tend to work late.") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(0);
  });

  it("does not store entry when AI response begins with similar-but-wrong prefix", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend") }); // incomplete — still valid prefix but no trailing text
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    // "You tend" does start with "You tend to"? No — "You tend to" !== "You tend"
    // "You tend".startsWith("You tend to") === false
    expect(db.entries).toHaveLength(0);
  });

  // ── Valid patterns are stored ────────────────────────────────────────────────

  it("stores pattern when AI returns text starting with 'You tend to'", async () => {
    const pattern = "You tend to start new projects on Mondays.";
    env = makeTestEnv(db, { AI: makePatternAI(pattern) });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe(pattern);
  });

  it("stores pattern when AI returns text starting with \"There's a recurring\"", async () => {
    const pattern = "There's a recurring theme of late-night coding sessions.";
    env = makeTestEnv(db, { AI: makePatternAI(pattern) });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe(pattern);
  });

  it("stores pattern when AI returns text starting with 'Across your memories'", async () => {
    const pattern = "Across your memories, exercise features heavily on weekends.";
    env = makeTestEnv(db, { AI: makePatternAI(pattern) });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe(pattern);
  });

  it("stores pattern with 'auto-pattern' tag", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend to prefer async communication.") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("auto-pattern");
  });

  it("stores pattern with source 'system'", async () => {
    env = makeTestEnv(db, { AI: makePatternAI("You tend to prefer async communication.") });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries[0].source).toBe("system");
  });

  it("trims whitespace from AI response before validation and storage", async () => {
    const pattern = "You tend to journal in the mornings.";
    env = makeTestEnv(db, { AI: makePatternAI(`  ${pattern}  `) });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe(pattern);
  });

  // ── Response format: choices path ────────────────────────────────────────────

  it("reads pattern from choices[0].message.content when present", async () => {
    const pattern = "You tend to prefer written notes over verbal explanations.";
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string, opts: any) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          if (opts?.stream) return makeSseStream("3");
          return { choices: [{ message: { content: pattern } }] };
        }),
      } as unknown as Ai,
    });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe(pattern);
  });

  it("prefers choices path over response when both are present", async () => {
    const fromChoices = "You tend to prefer written notes.";
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string, opts: any) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          if (opts?.stream) return makeSseStream("3");
          return { choices: [{ message: { content: fromChoices } }], response: "You tend to use voice notes." };
        }),
      } as unknown as Ai,
    });
    const { ctx } = makeCtx();
    await derivePattern(makeRows(5), env, ctx);
    expect(db.entries[0].content).toBe(fromChoices);
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  it("does not throw when AI call rejects — error is non-fatal", async () => {
    env = makeTestEnv(db, { AI: makePatternAI(null) });
    const { ctx } = makeCtx();
    await expect(derivePattern(makeRows(5), env, ctx)).resolves.toBeUndefined();
    expect(db.entries).toHaveLength(0);
  });
});
