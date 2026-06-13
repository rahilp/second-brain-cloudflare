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
  it('parses {"importance":5,"canonical":true,"kind":"semantic"} correctly', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":5,"canonical":true,"kind":"semantic"}'),
    });
    const result = await classifyEntry("I decided to quit my job and start a company", env);
    expect(result).toEqual({ importance: 5, canonical: true, kind: "semantic" });
  });

  it('parses {"importance":2,"canonical":false,"kind":"episodic"} correctly', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"canonical":false,"kind":"episodic"}'),
    });
    const result = await classifyEntry("Had coffee this morning", env);
    expect(result).toEqual({ importance: 2, canonical: false, kind: "episodic" });
  });

  it("returns kind:null when JSON is missing kind field", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false}'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: null });
  });

  it("returns kind:null when JSON has bogus kind value", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false,"kind":"bogus"}'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: null });
  });

  it("falls back to { importance: 3, canonical: false, kind: null } when LLM returns unparseable text", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI("sorry I cannot help with that"),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: null });
  });

  it("falls back to { importance: 0, canonical: false, kind: null } when env.AI.run throws", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI(null, true),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 0, canonical: false, kind: null });
  });

  // normalizeKind synonym/case/substring mapping tests
  it('maps kind:"event" → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"canonical":false,"kind":"event"}'),
    });
    const result = await classifyEntry("Attended a conference today", env);
    expect(result).toEqual({ importance: 2, canonical: false, kind: "episodic" });
  });

  it('maps kind:"milestone" → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":2,"canonical":false,"kind":"milestone"}'),
    });
    const result = await classifyEntry("Shipped the first release", env);
    expect(result).toEqual({ importance: 2, canonical: false, kind: "episodic" });
  });

  it('maps kind:"fact" → "semantic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false,"kind":"fact"}'),
    });
    const result = await classifyEntry("The office is in downtown", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: "semantic" });
  });

  it('maps kind:"preference" → "semantic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false,"kind":"preference"}'),
    });
    const result = await classifyEntry("I prefer dark mode", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: "semantic" });
  });

  it('maps kind:"Episodic" (mixed case) → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false,"kind":"Episodic"}'),
    });
    const result = await classifyEntry("Went for a run this morning", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: "episodic" });
  });

  it('maps kind:"episodic event" (substring) → "episodic"', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false,"kind":"episodic event"}'),
    });
    const result = await classifyEntry("Had a team meeting", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: "episodic" });
  });

  it('maps kind:"banana" (unknown synonym) → null', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":3,"canonical":false,"kind":"banana"}'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: null });
  });

  // ── Malformed JSON / tolerant parsing ─────────────────────────────────────

  it('salvages kind from real regression payload: {"importance": 3, "canonical":, "kind": "episodic"}', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance": 3, "canonical":, "kind": "episodic"}'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: "episodic" });
  });

  it('salvages canonical and kind when importance is malformed: {"importance":, "canonical": true, "kind": "semantic"}', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('{"importance":, "canonical": true, "kind": "semantic"}'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: true, kind: "semantic" });
  });

  it('extracts kind from garbage-surrounding text: blah blah "kind": "episodic" blah', async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI('blah blah "kind": "episodic" blah'),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: "episodic" });
  });

  it("returns all defaults when no recoverable fields exist: 'not json at all'", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeClassifyAI("not json at all"),
    });
    const result = await classifyEntry("Some memory", env);
    expect(result).toEqual({ importance: 3, canonical: false, kind: null });
  });
});
