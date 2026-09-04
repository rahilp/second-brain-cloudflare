/**
 * C — reading a typed relationship out of the insight call that already runs.
 *
 * The weekly pass already asks a reasoning model to look at two memories
 * together. It was throwing away everything except the prose: the model had
 * plainly decided how the two relate in order to answer at all, and that verdict
 * was discarded. Asking for it costs no extra call — only a few more output
 * tokens on a call already made.
 *
 * Two things make this worth testing carefully rather than trusting:
 *
 *   - the relationship is parsed BEFORE the `insight: true` gate, because the
 *     model refusing to write a publishable insight is not the same as it having
 *     no opinion about how the pair relates. Most calls decline; if the
 *     relationship only survived on the accepted path, the feature would fire on
 *     the small minority of runs.
 *   - `supersedes` is deliberately NOT in the enum. It is welded to deprecation
 *     semantics elsewhere in the codebase, and a model volunteering it here
 *     would retire a memory the person never asked to retire.
 */
import { describe, it, expect, vi } from "vitest";
import { parseRelationship, reasonOverPair } from "../../src/insight/reason";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";

function makeAI(payload: string) {
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as any;
}

const A = { content: "The vendor contract renewal was signed on Tuesday under the Halloway terms." };
const B = { content: "We cancelled the Halloway renewal after the pricing review came back." };
/** Names something only A has and something only B has, so it clears the vocabulary floor. */
const GOOD_TEXT =
  "You signed the vendor contract on Tuesday and then cancelled it once the pricing review came back, so the commitment held for less than a week.";

describe("parseRelationship", () => {
  it("reads the type and which side is the source", () => {
    expect(parseRelationship('{"relationship": "caused_by", "source": "B", "target": "A"}'))
      .toEqual({ type: "caused_by", source: "B" });
  });

  it("reads a relationship out of a response that also carries an insight", () => {
    expect(parseRelationship(`{"insight": true, "shape": "connection", "text": "x", "relationship": "decided", "source": "A", "target": "B"}`))
      .toEqual({ type: "decided", source: "A" });
  });

  it("returns null for none", () => {
    expect(parseRelationship('{"relationship": "none"}')).toBeNull();
  });

  it("returns null when no relationship is offered at all", () => {
    expect(parseRelationship('{"insight": false}')).toBeNull();
  });

  // Not an oversight: supersedes deprecates the memory it points at, and no
  // model volunteering it here should be able to retire something silently.
  it("refuses supersedes even though it is a real edge type", () => {
    expect(parseRelationship('{"relationship": "supersedes", "source": "A", "target": "B"}')).toBeNull();
  });

  it("refuses a type that is not in the enum", () => {
    expect(parseRelationship('{"relationship": "vibes_with", "source": "A", "target": "B"}')).toBeNull();
  });

  it("refuses a relationship with no usable direction", () => {
    expect(parseRelationship('{"relationship": "caused_by", "source": "C"}')).toBeNull();
  });

  // A response naming one memory as both ends is not a direction the model
  // committed to; taking `source` alone would silently invent one.
  it("refuses a relationship whose target is the same side as its source", () => {
    expect(parseRelationship('{"relationship": "caused_by", "source": "A", "target": "A"}')).toBeNull();
  });

  it("refuses a relationship with no target at all", () => {
    expect(parseRelationship('{"relationship": "caused_by", "source": "A"}')).toBeNull();
  });

  it("returns null on unparseable output rather than throwing", () => {
    expect(parseRelationship("the model wrote prose instead")).toBeNull();
  });
});

describe("reasonOverPair carries the relationship", () => {
  it("returns it alongside an accepted insight", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI(`{"insight": true, "shape": "contradiction", "text": ${JSON.stringify(GOOD_TEXT)}, "relationship": "caused_by", "source": "B", "target": "A"}`),
    });

    expect(await reasonOverPair(A, B, env)).toEqual({
      outcome: "insight",
      shape: "contradiction",
      text: GOOD_TEXT,
      relationship: { type: "caused_by", source: "B" },
    });
  });

  // The whole yield of this phase. Declines are the common case, and the model
  // still answered the relationship question on the way to declining.
  it("returns it when the model declined to write an insight", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI('{"insight": false, "relationship": "follows", "source": "B", "target": "A"}'),
    });

    expect(await reasonOverPair(A, B, env)).toEqual({
      outcome: "declined",
      relationship: { type: "follows", source: "B" },
    });
  });

  it("returns it when the insight was rejected by the quality floor", async () => {
    const env = makeTestEnv(makeTestDb(), {
      // Too short for MIN_INSIGHT_TEXT_CHARS, so the insight is dropped.
      AI: makeAI('{"insight": true, "shape": "connection", "text": "too short", "relationship": "decided", "source": "A", "target": "B"}'),
    });

    expect(await reasonOverPair(A, B, env)).toEqual({
      outcome: "declined",
      relationship: { type: "decided", source: "A" },
    });
  });

  it("omits the field entirely when the model offers no relationship", async () => {
    const env = makeTestEnv(makeTestDb(), { AI: makeAI('{"insight": false}') });

    expect(await reasonOverPair(A, B, env)).toEqual({ outcome: "declined" });
  });

  /**
   * A truncated or non-JSON response is NOT a considered refusal.
   *
   * `declined` marks the candidate `rejected` forever, and re-accrual cannot
   * resurrect it. The model running out of tokens mid-object — likelier now
   * that the prompt asks for a second answer — must therefore leave the pair
   * `pending`, exactly as a thrown call does, or one truncation permanently
   * costs a pair that would otherwise have produced an insight.
   */
  it("treats an unparseable response as failed, not as a decline", async () => {
    const env = makeTestEnv(makeTestDb(), { AI: makeAI("the model wrote prose and never opened a brace") });
    expect(await reasonOverPair(A, B, env)).toEqual({ outcome: "failed" });
  });

  it("treats a truncated JSON object as failed", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: makeAI('{"insight": true, "shape": "connection", "text": "cut off mid'),
    });
    expect(await reasonOverPair(A, B, env)).toEqual({ outcome: "failed" });
  });

  it("still reports failure when the call itself fails", async () => {
    const env = makeTestEnv(makeTestDb(), {
      AI: { run: vi.fn().mockRejectedValue(new Error("model unavailable")) } as any,
    });

    expect(await reasonOverPair(A, B, env)).toEqual({ outcome: "failed" });
  });
});

/**
 * The prompt is the contract with the model, and the yield of this phase rests
 * on two properties of it that are easy to break while editing prose.
 */
describe("the reasoning prompt", () => {
  async function promptSent(): Promise<string> {
    const prompts: string[] = [];
    const env = makeTestEnv(makeTestDb(), {
      AI: {
        run: vi.fn().mockImplementation(async (_m: string, opts: any) => {
          prompts.push(String(opts?.messages?.[0]?.content ?? ""));
          return new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"response":"{\\"insight\\": false}"}\n\n'));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as any,
    });
    await reasonOverPair(A, B, env);
    return prompts[0];
  }

  it("still offers both original response alternatives verbatim", async () => {
    const prompt = await promptSent();
    // The insight half of the contract predates this work and must survive it:
    // an edit that replaced these with a relationship-only schema would quietly
    // turn the weekly pass into an edge generator that writes no insights.
    expect(prompt).toContain('{"insight": false}');
    expect(prompt).toContain('{"insight": true, "shape": "<shape>", "text": "<the insight>"}');
  });

  it("puts the relationship spec last, after the insight instructions", async () => {
    const prompt = await promptSent();
    // Last on purpose: the insight is still the primary task, and instructions
    // placed after it read as the refinement rather than the headline.
    expect(prompt.indexOf('"relationship"')).toBeGreaterThan(prompt.indexOf('{"insight": false}'));
    expect(prompt).toMatch(/caused_by[\s\S]*decided[\s\S]*follows[\s\S]*none/);
  });

  it("never offers supersedes to the model", async () => {
    expect(await promptSent()).not.toContain("supersedes");
  });
});
