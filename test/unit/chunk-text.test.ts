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

  it("returns a single chunk for text exactly at the default maxChars boundary", () => {
    const text = "a".repeat(1600);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits into multiple chunks for text one char over the boundary", () => {
    const text = "a".repeat(1601);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(1600));
  });

  it("respects a custom maxChars parameter", () => {
    const text = "x".repeat(300);
    const chunks = chunkText(text, 100, 10);
    chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(100));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("produces non-overlapping chunks when overlapChars is 0", () => {
    const text = "ab".repeat(100); // 200 chars, no sentence breaks
    const chunks = chunkText(text, 80, 0);
    // With zero overlap each chunk should start exactly where the previous ended
    let pos = 0;
    for (const chunk of chunks) {
      expect(text.indexOf(chunk, pos)).toBe(pos);
      pos += chunk.length;
    }
  });
});
