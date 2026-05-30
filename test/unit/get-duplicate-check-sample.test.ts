import { describe, it, expect } from "vitest";
import { getDuplicateCheckSample } from "../../src/index";

describe("getDuplicateCheckSample", () => {
  it("returns content unchanged when at or under 1500 chars", () => {
    const content = "a".repeat(1500);
    expect(getDuplicateCheckSample(content)).toBe(content);
  });

  it("returns a sample string with ellipsis separators for content over 1500 chars", () => {
    // For very long content the sample (500+500+500 + separators) is shorter than the original
    const content = "a".repeat(2500);
    const sample = getDuplicateCheckSample(content);
    expect(sample).toContain("...");
    expect(sample.length).toBeLessThan(content.length);
  });

  it("samples start, middle, and end sections of long content", () => {
    const start = "S".repeat(500);
    const middle = "M".repeat(800);
    const end = "E".repeat(500);
    const content = start + middle + end; // 1800 chars
    const sample = getDuplicateCheckSample(content);
    expect(sample.startsWith("S".repeat(500))).toBe(true);
    expect(sample.endsWith("E".repeat(500))).toBe(true);
    expect(sample).toContain("M");
  });
});
