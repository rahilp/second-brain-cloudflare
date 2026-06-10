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

describe("parseRecallResult — direct object input (non-string path)", () => {
  it("accepts a plain JS object with a .results array (skips JSON.parse)", () => {
    const results = parseRecallResult({ results: [{ score: 80, content: "direct object", tags: [], id: "o1" }] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("direct object");
    expect(results[0].score).toBe(80);
  });

  it("parses the GET /recall REST response shape — one entry per result, regardless of content", () => {
    // Contract test: the REST response shape must yield one entry per result,
    // never splitting on list items inside content (the old text-parsing bug).
    // The recall chat flow now maps data.results directly (inline in index.html,
    // not testable here); this pins the shape both depend on.
    const restResponse = {
      ok: true,
      results: [
        { id: "r1", content: "Changelog:\n- item one\n- item two\n1. numbered line", score: 87.3, tags: ["work"], source: "api", created_at: 1717000000000, updated: false },
        { id: "r2", content: "Plain note", score: 64.9, tags: [], source: "claude-desktop", created_at: 1717000001000, updated: true },
      ],
      insight: "Some synthesized insight.",
    };
    const results = parseRecallResult(restResponse);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "r1", score: 87, tags: ["work"] });
    expect(results[0].content).toContain("- item one");
    expect(results[1]).toMatchObject({ id: "r2", score: 65, content: "Plain note" });
  });
});

describe("parseRecallResult — text block with no score", () => {
  it("defaults score to 0 when no [NN%] marker is present", () => {
    const text = "- A note with no score at all";
    const results = parseRecallResult(text);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
    expect(results[0].content).toBe("A note with no score at all");
  });
});

describe("normalizeEntry (via parseRecallResult JSON path)", () => {
  it("parses tags when they are a JSON string", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: '["a","b"]', id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual(["a", "b"]);
  });

  it("coerces a plain string tag into a single-element array", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: "mytag", id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual(["mytag"]);
  });

  it("uses e.similarity as score fallback when e.score is absent", () => {
    const json = JSON.stringify([{ similarity: 0.72, content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(72);
  });

  it("uses e.text as content fallback when e.content is absent", () => {
    const json = JSON.stringify([{ score: 50, text: "fallback content", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].content).toBe("fallback content");
  });

  it("score 0.0 stays 0 (boundary: not in 0–1 range)", () => {
    const json = JSON.stringify([{ score: 0.0, content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(0);
  });

  it("score 1.0 converts to 100 (boundary: exactly 1)", () => {
    const json = JSON.stringify([{ score: 1.0, content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(100);
  });

  it("score defaults to 0 when both score and similarity are absent", () => {
    const json = JSON.stringify([{ content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(0);
  });

  it("coerces a falsy string tag ('') to an empty array", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: "", id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual([]);
  });

  it("coerces a non-array non-string tags value (number) to an empty array", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: 42, id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual([]);
  });

  it("returns empty string for content when both content and text are absent", () => {
    const json = JSON.stringify([{ score: 50, tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].content).toBe("");
  });

  it("returns null for id when id field is absent", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: [] }]);
    const results = parseRecallResult(json);
    expect(results[0].id).toBeNull();
  });
});

describe("parseRecallResult — JSON property fallbacks", () => {
  it("extracts entries from a .results wrapper object", () => {
    const json = JSON.stringify({ results: [{ score: 80, content: "from results", tags: [], id: "r1" }] });
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from results");
  });

  it("extracts entries from a .memories wrapper object", () => {
    const json = JSON.stringify({ memories: [{ score: 70, content: "from memories", tags: [], id: "m1" }] });
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from memories");
  });

  it("extracts entries from an .entries wrapper object", () => {
    const json = JSON.stringify({ entries: [{ score: 60, content: "from entries", tags: [], id: "e1" }] });
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from entries");
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

  it("returns empty string for null input", () => {
    expect(escHtml(null)).toBe("");
  });

  it("escapes single quotes to &#39;", () => {
    expect(escHtml("it's")).toBe("it&#39;s");
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

  it("removes carriage returns", () => {
    expect(escAttr("line1\rline2")).toBe("line1line2");
  });

  it("returns empty string for null input", () => {
    expect(escAttr(null)).toBe("");
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

  it("zero-pads December correctly", () => {
    const d = new Date(2026, 11, 31); // December 31 2026
    expect(toDateStr(d)).toBe("2026-12-31");
  });
});
