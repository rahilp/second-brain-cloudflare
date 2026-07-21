import { describe, it, expect } from "vitest";
import { mmrRerank } from "../../src/index";

function m(id: string, score: number, values: number[]) {
  return { id, score, metadata: { parentId: id }, values };
}

// Two clusters: several near-duplicate "recent" vectors and one distinct "older" vector.
const DUP = [1, 0, 0];
const DISTINCT = [0, 1, 0];

describe("mmrRerank", () => {
  it("surfaces a distinct item that a plain top-K by score would crowd out", () => {
    const candidates = [
      m("recent1", 0.60, DUP),
      m("recent2", 0.58, DUP),
      m("recent3", 0.57, DUP),
      m("recent4", 0.56, DUP),
      m("distinct", 0.50, DISTINCT),
    ];
    const picked = mmrRerank(candidates, 0.7, 3).map(x => x.id);
    // Plain top-3 by score would be recent1/recent2/recent3 (all duplicates).
    expect(picked[0]).toBe("recent1");        // top hit preserved
    expect(picked).toContain("distinct");     // the distinct item reclaims a slot
  });

  it("keeps the highest-scoring item first", () => {
    const picked = mmrRerank([
      m("b", 0.5, DUP),
      m("a", 0.9, DISTINCT),
    ], 0.7, 2);
    expect(picked[0].id).toBe("a");
  });

  it("candidates without vectors take no diversity penalty (kept by relevance)", () => {
    const picked = mmrRerank([
      { id: "x", score: 0.9, metadata: {} } as any,
      { id: "y", score: 0.8, metadata: {} } as any,
    ], 0.7, 2).map(x => x.id);
    expect(picked).toEqual(["x", "y"]);
  });

  it("returns at most k items and never more than provided", () => {
    const picked = mmrRerank([m("a", 0.9, DUP), m("b", 0.8, DISTINCT)], 0.7, 5);
    expect(picked.length).toBe(2);
  });
});
