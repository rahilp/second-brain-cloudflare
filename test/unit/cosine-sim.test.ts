import { describe, it, expect } from "vitest";
import { cosineSim } from "../../src/index";

describe("cosineSim", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 1 for parallel vectors of different magnitude (normalizes)", () => {
    // BGE embeddings aren't normalized — magnitude must not affect the score
    expect(cosineSim([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSim([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it("returns 0 when either vector is all zeros", () => {
    expect(cosineSim([0, 0], [1, 2])).toBe(0);
    expect(cosineSim([1, 2], [0, 0])).toBe(0);
  });
});
