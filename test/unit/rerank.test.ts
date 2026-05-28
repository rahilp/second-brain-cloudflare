import { describe, it, expect } from "vitest";
import { rerankWithTimeDecay } from "../../src/index";

const NOW = Date.now();
const MS_DAY = 86400000;

function match(id: string, score: number, created_at: number, tags: string[] = []) {
  return { id, score, metadata: { parentId: id, created_at, tags } };
}

describe("rerankWithTimeDecay", () => {
  it("newer entry ranks higher given equal vector scores", () => {
    const matches = [
      match("old", 0.9, NOW - 60 * MS_DAY),
      match("new", 0.9, NOW - 1 * MS_DAY),
    ];
    const result = rerankWithTimeDecay(matches, new Map());
    expect(result[0].id).toBe("new");
  });

  it("returns results sorted descending by score", () => {
    const matches = [
      match("a", 0.8, NOW - 30 * MS_DAY),
      match("b", 0.9, NOW - 30 * MS_DAY),
      match("c", 0.7, NOW - 30 * MS_DAY),
    ];
    const result = rerankWithTimeDecay(matches, new Map());
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score);
    }
  });

  it("produces no NaN scores", () => {
    const matches = [match("x", 0.5, 0), match("y", 0.5, NOW)];
    rerankWithTimeDecay(matches, new Map()).forEach(m => {
      expect(Number.isNaN(m.score)).toBe(false);
    });
  });

  it("task tag decays faster than context tag at same age", () => {
    const taskMatch = match("task-entry", 1.0, NOW - 30 * MS_DAY, ["task"]);
    const contextMatch = match("ctx-entry", 1.0, NOW - 30 * MS_DAY, ["context"]);
    const [t] = rerankWithTimeDecay([taskMatch], new Map());
    const [c] = rerankWithTimeDecay([contextMatch], new Map());
    expect(c.score).toBeGreaterThan(t.score);
  });

  it("entry with higher recall_count ranks above equal-scored entry with zero recalls", () => {
    const fresh = match("fresh", 0.9, NOW - 1 * MS_DAY);
    const recalled = match("recalled", 0.9, NOW - 1 * MS_DAY);
    const counts = new Map([["recalled", 10]]);
    const result = rerankWithTimeDecay([fresh, recalled], counts);
    expect(result[0].id).toBe("recalled");
  });

  it("entry with recall_count=0 still produces a positive score (baseline multiplier = 1.0)", () => {
    const m = match("entry", 0.8, NOW - 5 * MS_DAY);
    const [result] = rerankWithTimeDecay([m], new Map());
    expect(result.score).toBeGreaterThan(0);
  });

  it("omitting recallCounts parameter behaves identically to passing an empty Map", () => {
    const matches = [match("a", 0.9, NOW - 10 * MS_DAY)];
    const withEmpty = rerankWithTimeDecay(matches, new Map());
    const withDefault = rerankWithTimeDecay(matches);
    expect(withDefault[0].score).toBeCloseTo(withEmpty[0].score, 6);
  });

  it("frequently-recalled old memory does not outrank a new memory with similar vector score", () => {
    // Regression: unbounded frequencyMultiplier buried memories stored today behind
    // context-tagged entries recalled 20+ times.
    const oldHighRecall = match("old", 0.88, NOW - 11 * MS_DAY, ["context"]);
    const newFresh = match("new", 0.90, NOW);
    const counts = new Map([["old", 24]]);
    const result = rerankWithTimeDecay([oldHighRecall, newFresh], counts);
    expect(result[0].id).toBe("new");
  });

  it("combined multiplier never exceeds 1.0 regardless of recall count", () => {
    const m = match("entry", 1.0, NOW - 14 * MS_DAY, ["context"]);
    const counts = new Map([["entry", 100]]);
    const [result] = rerankWithTimeDecay([m], counts);
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});
