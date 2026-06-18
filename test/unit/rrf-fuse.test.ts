import { describe, it, expect } from "vitest";
import { rrfFuse } from "../../src/index";

describe("rrfFuse()", () => {
  it("ranks a dense-only list by position (earlier rank = higher score)", () => {
    const scores = rrfFuse(["a", "b", "c"], []);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("b")!);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("c")!);
  });

  it("rewards an entry that appears in BOTH lists over one in a single list", () => {
    // b is rank1 in dense AND rank0 in keyword; a is only in dense, c only in keyword.
    const scores = rrfFuse(["a", "b"], [{ id: "b", weight: 1 }, { id: "c", weight: 1 }]);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("a")!);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("c")!);
  });

  it("scales a keyword contribution by its match weight", () => {
    // x matches more distinct tokens than y, so even at a worse rank it must win.
    const scores = rrfFuse([], [{ id: "x", weight: 2 }, { id: "y", weight: 1 }]);
    expect(scores.get("x")!).toBeGreaterThan(scores.get("y")!);
  });

  it("lets a high-weight keyword-only hit beat near-twins present in both lists", () => {
    // Mirrors the identifier case: twins t1/t2 are in both lists (weight 1); the exact
    // match `hit` is keyword-only but matched 2 distinct tokens.
    const scores = rrfFuse(
      ["t1", "t2"],
      [{ id: "hit", weight: 2 }, { id: "t1", weight: 1 }, { id: "t2", weight: 1 }],
    );
    expect(scores.get("hit")!).toBeGreaterThan(scores.get("t1")!);
    expect(scores.get("hit")!).toBeGreaterThan(scores.get("t2")!);
  });

  it("returns an empty map when both lists are empty", () => {
    expect(rrfFuse([], []).size).toBe(0);
  });
});
