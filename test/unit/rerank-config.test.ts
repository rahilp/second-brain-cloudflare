/**
 * #245 — rerankWithTimeDecay takes config as a parameter and stays pure.
 *
 * The reason config is threaded rather than read from module scope: this
 * function is the ranking seam, and keeping it "config in, ordering out" means
 * it is assertable with no env, no KV, and no mocks. Every test in this file
 * calls it directly.
 */
import { describe, it, expect } from "vitest";
import { rerankWithTimeDecay, type VectorizeMatch } from "../../src/recall/math";
import { DEFAULTS } from "../../src/config";

const DAY = 86400000;
const OLD = Date.now() - 400 * DAY;

function match(id: string, score: number, tags: string[], createdAt = OLD): VectorizeMatch {
  return { id, score, metadata: { parentId: id, created_at: createdAt, tags } } as VectorizeMatch;
}

describe("rerankWithTimeDecay() config threading", () => {
  it("applies the volatile floor from the passed config to an aged task", async () => {
    const matches = [match("t", 1.0, ["task"])];

    const withDefaults = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map(), DEFAULTS);
    const withHighFloor = rerankWithTimeDecay(
      matches, new Map(), new Map(), [], new Map(), new Map(),
      { ...DEFAULTS, RECENCY_FLOOR_VOLATILE: 1.0 },
    );

    // A floor of 1.0 means no decay at all, so the aged task must score higher
    // than it does under the shipped 0.15 floor.
    expect(withHighFloor[0].score).toBeGreaterThan(withDefaults[0].score);
  });

  it("applies the tag boost cap from the passed config", async () => {
    const matches = [match("m", 1.0, ["work", "second-brain", "recall"], Date.now())];
    const queryTags = ["work", "second-brain", "recall"];

    const capped = rerankWithTimeDecay(
      matches, new Map(), new Map(), queryTags, new Map(), new Map(),
      { ...DEFAULTS, TAG_BOOST_MAX: 1.0 },
    );
    const uncapped = rerankWithTimeDecay(
      matches, new Map(), new Map(), queryTags, new Map(), new Map(),
      { ...DEFAULTS, TAG_BOOST_MAX: 5.0, TAG_BOOST_STEP: 0.5 },
    );

    expect(uncapped[0].score).toBeGreaterThan(capped[0].score);
  });

  it("defaults to the shipped config when none is passed", async () => {
    const matches = [match("t", 1.0, ["task"])];

    const implicit = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map());
    const explicit = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map(), DEFAULTS);

    expect(implicit[0].score).toBe(explicit[0].score);
  });

  it("is pure: same inputs give the same output, and inputs are not mutated", async () => {
    const matches = [match("a", 0.9, ["work"]), match("b", 0.8, ["task"])];
    const snapshot = JSON.parse(JSON.stringify(matches));

    const first = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map(), DEFAULTS);
    const second = rerankWithTimeDecay(matches, new Map(), new Map(), [], new Map(), new Map(), DEFAULTS);

    expect(first.map(m => [m.id, m.score])).toEqual(second.map(m => [m.id, m.score]));
    expect(JSON.parse(JSON.stringify(matches))).toEqual(snapshot);
  });
});
