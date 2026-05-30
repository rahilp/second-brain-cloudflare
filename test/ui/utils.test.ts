import { describe, it, expect } from "vitest";

const { parseRecallResult, escHtml, escAttr, toDateStr } = require("../../public/utils.js");

describe("parseRecallResult", () => {
  it("parses a JSON array of entries", () => {
    const json = JSON.stringify([
      { score: 87, content: "My note content", tags: ["api"], id: "abc-123" },
    ]);
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(87);
    expect(results[0].id).toBe("abc-123");
    expect(results[0].content).toBe("My note content");
    expect(results[0].tags).toEqual(["api"]);
  });

  it("normalises 0–1 similarity scores to percent", () => {
    const json = JSON.stringify([{ score: 0.87, content: "note", tags: [], id: "x" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(87);
  });

  it("parses multiple text list blocks", () => {
    const text = [
      "1. [90%] First note (id: id-1)",
      "2. [75%] Second note (id: id-2)",
    ].join("\n");
    const results = parseRecallResult(text);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(90);
    expect(results[1].score).toBe(75);
  });

  it("returns empty array for empty string", () => {
    expect(parseRecallResult("")).toEqual([]);
  });

  it("returns empty array for null / undefined", () => {
    expect(parseRecallResult(null)).toEqual([]);
    expect(parseRecallResult(undefined)).toEqual([]);
  });

  it("parses hashtags out of body text", () => {
    const text = `1. [80%] Tagged note #react #typescript (id: t1)`;
    const results = parseRecallResult(text);
    expect(results[0].tags).toEqual(["react", "typescript"]);
    expect(results[0].content).toBe("Tagged note");
  });

  it("returns null id when no (id: …) marker is present", () => {
    const text = `1. [70%] Content without ID`;
    const results = parseRecallResult(text);
    expect(results[0].id).toBeNull();
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

  it("escapes double quotes", () => {
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

  it("escapes backslashes", () => {
    expect(escAttr("C:\\path")).toBe("C:\\\\path");
  });
});

describe("toDateStr", () => {
  it("returns zero-padded yyyy-mm-dd", () => {
    const d = new Date(2026, 4, 20); // May 20 2026
    expect(toDateStr(d)).toBe("2026-05-20");
  });

  it("zero-pads single-digit month and day", () => {
    const d = new Date(2026, 0, 1); // January 1 2026
    expect(toDateStr(d)).toBe("2026-01-01");
  });
});
