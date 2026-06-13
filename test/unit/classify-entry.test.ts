import { describe, it, expect, vi } from "vitest";
import { classifyEntry } from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/index";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makeClassifyAI(response: string | null = null, shouldThrow = false) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      if (shouldThrow) throw new Error("AI failure");
      return makeSseStream(response ?? "");
    }),
  } as unknown as Ai;
}

describe("classifyEntry()", () => {
  it('parses {"importance":5,"canonical":true} correctly', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":5,"canonical":true}'),
    });
    const result = await classifyEntry("I decided to quit my job and start a company", env);
    expect(result).toEqual({ importance: 5, canonical: true });
  });

  it('parses {"importance":2,"canonical":false} correctly', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"canonical":false}'),
    });
    const result = await classifyEntry("Had coffee this morning", env);
    expect(result).toEqual({ importance: 2, canonical: false });
  });

  it("falls back to { importance: 3, canonical: false } when LLM returns unparseable text", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI("sorry I cannot help with that"),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false });
  });

  it("falls back to { importance: 0, canonical: false } when env.AI.run throws", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI(null, true),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 0, canonical: false });
  });
});
