import { describe, it, expect } from "vitest";

const { parseRecallResult, escHtml, escAttr, toDateStr } = require("../../public/utils.js");

describe("parseRecallResult", () => {
  it("parses a single well-formed block", () => {
    const text = `1. [5/20/2026 · api] (87% match)\nID: abc-123\nMy note content`;
    const results = parseRecallResult(text);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(87);
    expect(results[0].id).toBe("abc-123");
    expect(results[0].content).toBe("My note content");
    expect(results[0].date).toBe("5/20/2026");
    expect(results[0].source).toBe("api");
    expect(results[0].tags).toEqual([]);
  });

  it("parses multiple blocks", () => {
    const text = [
      "1. [5/20/2026 · api] (90% match)\nID: id-1\nFirst note",
      "2. [5/19/2026 · claude] (75% match)\nID: id-2\nSecond note",
    ].join("\n\n");
    const results = parseRecallResult(text);
    expect(results).toHaveLength(2);
  });

  it("returns empty array for empty string", () => {
    expect(parseRecallResult("")).toEqual([]);
  });

  it("returns empty array for malformed input", () => {
    expect(parseRecallResult("no blocks here at all")).toEqual([]);
  });

  it("parses tags from header", () => {
    const text = `1. [5/20/2026 · api · [react, typescript]] (80% match)\nID: t1\nTagged note`;
    const results = parseRecallResult(text);
    expect(results[0].tags).toEqual(["react", "typescript"]);
  });

  it("handles block with no ID line", () => {
    const text = `1. [5/20/2026 · api] (70% match)\nContent without ID`;
    const results = parseRecallResult(text);
    expect(results[0].id).toBe("");
    expect(results[0].content).toBe("Content without ID");
  });
});

describe("escHtml", () => {
  it("escapes < and >", () => {
    expect(escHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes &", () => {
    expect(escHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes quotes", () => {
    expect(escHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("leaves safe strings unchanged", () => {
    expect(escHtml("hello world")).toBe("hello world");
  });
});

describe("escAttr", () => {
  it("escapes single quotes", () => {
    expect(escAttr("it's")).toBe("it\\'s");
  });

  it("replaces newlines with spaces", () => {
    expect(escAttr("line1\nline2")).toBe("line1 line2");
  });

  it("truncates to 100 chars", () => {
    const long = "a".repeat(150);
    expect(escAttr(long)).toHaveLength(100);
  });
});

describe("toDateStr", () => {
  it("returns year-month-day format", () => {
    const d = new Date(2026, 4, 20); // May 20, 2026 (month is 0-indexed)
    expect(toDateStr(d)).toBe("2026-4-20");
  });

  it("uses zero-based month (matches existing behaviour)", () => {
    const d = new Date(2026, 0, 1); // January 1, 2026
    expect(toDateStr(d)).toBe("2026-0-1");
  });
});
