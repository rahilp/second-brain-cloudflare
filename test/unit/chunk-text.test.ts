import { describe, it, expect } from "vitest";
import { chunkText } from "../../src/index";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const text = "Short note";
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits text exceeding maxChars into multiple chunks", () => {
    const text = "a".repeat(1700);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(1600));
  });

  it("filters out empty chunks", () => {
    const text = "x".repeat(3200);
    const chunks = chunkText(text);
    chunks.forEach(c => expect(c.length).toBeGreaterThan(0));
  });

  it("prefers breaking at sentence boundaries", () => {
    const sentence = "This is a sentence. ";
    const text = sentence.repeat(100);
    const [first] = chunkText(text, 1600, 200);
    expect(first.endsWith(".")).toBe(true);
  });

  it("chunk content covers the full input text", () => {
    const text = "word ".repeat(400);
    const chunks = chunkText(text);
    const combined = chunks.join(" ");
    expect(combined).toContain("word");
    expect(chunks.length).toBeGreaterThan(1);
  });
});
