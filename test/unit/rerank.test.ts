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
    const result = rerankWithTimeDecay(matches);
    expect(result[0].id).toBe("new");
  });

  it("returns results sorted descending by score", () => {
    const matches = [
      match("a", 0.8, NOW - 30 * MS_DAY),
      match("b", 0.9, NOW - 30 * MS_DAY),
      match("c", 0.7, NOW - 30 * MS_DAY),
    ];
    const result = rerankWithTimeDecay(matches);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score);
    }
  });

  it("produces no NaN scores", () => {
    const matches = [match("x", 0.5, 0), match("y", 0.5, NOW)];
    rerankWithTimeDecay(matches).forEach(m => {
      expect(Number.isNaN(m.score)).toBe(false);
    });
  });

  it("task tag decays faster than context tag at same age", () => {
    const taskMatch = match("task-entry", 1.0, NOW - 30 * MS_DAY, ["task"]);
    const contextMatch = match("ctx-entry", 1.0, NOW - 30 * MS_DAY, ["context"]);
    const [t] = rerankWithTimeDecay([taskMatch]);
    const [c] = rerankWithTimeDecay([contextMatch]);
    expect(c.score).toBeGreaterThan(t.score);
  });
});
