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

  it("combined multiplier never exceeds 1.0 regardless of recall count (without importance)", () => {
    const m = match("entry", 1.0, NOW - 14 * MS_DAY, ["context"]);
    const counts = new Map([["entry", 100]]);
    const [result] = rerankWithTimeDecay([m], counts);
    expect(result.score).toBeLessThanOrEqual(1.0);
  });

  it("importance_score=5 boosts score above the 1.0 recency cap", () => {
    const m = match("entry", 1.0, NOW);
    const importance = new Map([["entry", 5]]);
    const [result] = rerankWithTimeDecay([m], new Map(), importance);
    expect(result.score).toBeGreaterThan(1.0);
  });

  it("unscored entry (importance_score=0) uses neutral multiplier", () => {
    const m = match("entry", 0.8, NOW - 5 * MS_DAY);
    const withImportance = rerankWithTimeDecay([m], new Map(), new Map([["entry", 0]]));
    const withDefault = rerankWithTimeDecay([m], new Map());
    expect(withImportance[0].score).toBeCloseTo(withDefault[0].score, 6);
  });

  it("high-importance memory (score=5) outranks low-importance memory (score=1) of similar age", () => {
    // 5-day-old entry with importance=5 should beat a 2-day-old entry with importance=1.
    // Without importance, recency alone would pick "new". With importance, "old" wins.
    const old = match("old", 0.9, NOW - 5 * MS_DAY);
    const fresh = match("new", 0.9, NOW - 2 * MS_DAY);
    const importance = new Map([["old", 5], ["new", 1]]);
    const result = rerankWithTimeDecay([old, fresh], new Map(), importance);
    expect(result[0].id).toBe("old");
  });

  it("tag-overlapping entry outranks equal-vector-score entry without matching tag", () => {
    const withTag = match("tagged", 0.9, NOW - 5 * MS_DAY, ["work"]);
    const withoutTag = match("untagged", 0.9, NOW - 5 * MS_DAY, ["personal"]);
    const result = rerankWithTimeDecay([withoutTag, withTag], new Map(), new Map(), ["work"]);
    expect(result[0].id).toBe("tagged");
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("queryTags=[] produces identical scores to no queryTags argument (backward compat)", () => {
    const m = match("entry", 0.9, NOW - 5 * MS_DAY, ["work"]);
    const [withEmpty] = rerankWithTimeDecay([m], new Map(), new Map(), []);
    const [withDefault] = rerankWithTimeDecay([m]);
    expect(withEmpty.score).toBeCloseTo(withDefault.score, 6);
  });

  it("canonical survivor (contradiction wins) ranks above an identical entry with no history", () => {
    const a = match("survivor", 0.9, NOW - 5 * MS_DAY);
    const b = match("plain", 0.9, NOW - 5 * MS_DAY);
    const imp = new Map([["survivor", 4], ["plain", 4]]);
    const wins = new Map([["survivor", 3]]);
    const result = rerankWithTimeDecay([a, b], new Map(), imp, [], wins, new Map());
    expect(result[0].id).toBe("survivor");
  });

  it("draft loser (contradiction losses) ranks below an identical entry with no history", () => {
    const a = match("loser", 0.9, NOW - 5 * MS_DAY);
    const b = match("plain", 0.9, NOW - 5 * MS_DAY);
    const imp = new Map([["loser", 3], ["plain", 3]]);
    const losses = new Map([["loser", 3]]);
    const result = rerankWithTimeDecay([a, b], new Map(), imp, [], new Map(), losses);
    expect(result[0].id).toBe("plain");
  });

  it("equal wins and losses produce no change vs no history", () => {
    const [withHistory] = rerankWithTimeDecay(
      [match("e", 0.9, NOW - 5 * MS_DAY)], new Map(), new Map([["e", 3]]), [],
      new Map([["e", 2]]), new Map([["e", 2]]),
    );
    const [without] = rerankWithTimeDecay(
      [match("e", 0.9, NOW - 5 * MS_DAY)], new Map(), new Map([["e", 3]]),
    );
    expect(withHistory.score).toBeCloseTo(without.score, 6);
  });

  it("unscored entry with contradiction wins is boosted (scored from neutral midpoint)", () => {
    const contested = match("contested", 0.9, NOW - 5 * MS_DAY);
    const unscored = match("unscored", 0.9, NOW - 5 * MS_DAY);
    const result = rerankWithTimeDecay(
      [contested, unscored], new Map(), new Map(), [], new Map([["contested", 2]]), new Map(),
    );
    expect(result[0].id).toBe("contested");
  });

  it("contradiction wins cannot push effective importance above the imp=5 ceiling", () => {
    const [r] = rerankWithTimeDecay(
      [match("max", 1.0, NOW)], new Map(), new Map([["max", 5]]), [], new Map([["max", 50]]), new Map(),
    );
    expect(r.score).toBeCloseTo(1.2, 2);
  });

  it("contradiction losses cannot push effective importance below the imp=1 floor", () => {
    const [r] = rerankWithTimeDecay(
      [match("min", 1.0, NOW)], new Map(), new Map([["min", 1]]), [], new Map(), new Map([["min", 50]]),
    );
    expect(r.score).toBeCloseTo(0.88, 2);
  });

  it("contradiction effect has diminishing returns (3 wins < 3x the boost of 1 win)", () => {
    const [neutral] = rerankWithTimeDecay([match("b", 0.9, NOW - 5 * MS_DAY)], new Map(), new Map([["b", 3]]));
    const [one] = rerankWithTimeDecay(
      [match("b", 0.9, NOW - 5 * MS_DAY)], new Map(), new Map([["b", 3]]), [], new Map([["b", 1]]), new Map(),
    );
    const [three] = rerankWithTimeDecay(
      [match("b", 0.9, NOW - 5 * MS_DAY)], new Map(), new Map([["b", 3]]), [], new Map([["b", 3]]), new Map(),
    );
    const boost1 = one.score - neutral.score;
    const boost3 = three.score - neutral.score;
    expect(boost3).toBeGreaterThan(boost1);
    expect(boost3).toBeLessThan(boost1 * 3);
  });

  it("omitting contradiction maps behaves identically to passing empty maps", () => {
    const withEmpty = rerankWithTimeDecay(
      [match("a", 0.9, NOW - 10 * MS_DAY)], new Map(), new Map([["a", 4]]), [], new Map(), new Map(),
    );
    const withDefault = rerankWithTimeDecay(
      [match("a", 0.9, NOW - 10 * MS_DAY)], new Map(), new Map([["a", 4]]),
    );
    expect(withDefault[0].score).toBeCloseTo(withEmpty[0].score, 6);
  });
});
