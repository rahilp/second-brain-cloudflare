import { describe, it, expect } from "vitest";
import {
  allowanceFor,
  snippetOf,
  truncationNote,
  FULL_MATCH_MAX_CHARS,
  RECALL_FULL_MATCHES,
  SNIPPET_MAX_CHARS,
  queryRelevantWindow,
} from "../../src/recall/snippet";

// The cost of the truncation note itself, mirrored from snippet.ts. A memory
// only slightly over the allowance must not be cut, because the note would
// cost more than the cut saves.
const NOTE_COST = 90;

describe("snippetOf", () => {
  it("returns a short memory whole and marks it complete", () => {
    const s = snippetOf("A short memory.", 400);
    expect(s.truncated).toBe(false);
    expect(s.text).toBe("A short memory.");
    expect(s.fullLength).toBe("A short memory.".length);
  });

  it("does not truncate a memory only slightly over the allowance (the note would cost more than the cut saves)", () => {
    const barelyOver = "x".repeat(400 + NOTE_COST - 10);
    const s = snippetOf(barelyOver, 400);
    expect(s.truncated).toBe(false);
    expect(s.text.length).toBe(barelyOver.length);
  });

  it("truncates once the saving exceeds the note's own cost", () => {
    const s = snippetOf("x".repeat(2000), 400);
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(400);
    expect(s.fullLength).toBe(2000);
  });

  it("cuts on a boundary rather than mid-word", () => {
    const prose = "Alpha bravo charlie delta echo foxtrot golf hotel india juliet. ".repeat(20);
    const s = snippetOf(prose, 300);
    expect(s.truncated).toBe(true);
    // The last character is punctuation or the text ends on a complete word.
    expect(s.text).toMatch(/[.!?]$|\w$/);
    expect(s.text.endsWith("juli")).toBe(false);
  });

  it("reports the STORED length, so the fetch note tells the truth about what get() returns", () => {
    // Condensing shrinks what is DISPLAYED; it must not shrink the reported size.
    const noisy = "Title here.\n\n" + "&zwnj; ".repeat(300) + "\n\nThe part a reader wants.";
    const s = snippetOf(noisy, 400);
    expect(s.fullLength).toBe(noisy.trim().length);
  });

  describe("entries grown by append", () => {
    const appended =
      "Original decision was option A. " + "filler sentence. ".repeat(60) +
      "\n\n[Update 7/24/2026]: Reversed to option B after the spike.";

    it("keeps the newest update, not just the head, when the query does not match", () => {
      const s = snippetOf(appended, 400);
      expect(s.truncated).toBe(true);
      expect(s.text).toContain("Original decision was option A");
      expect(s.text).toContain("Reversed to option B");
    });

    it("prefers the passage matching the query over the newest update", () => {
      const doc =
        "Feasibility review header. " + "filler. ".repeat(60) +
        "Constants: RETENTION_MS 180d and MAX_OCCURRENCES 200. " + "filler. ".repeat(60) +
        "\n\n[Update 7/24/2026]: An unrelated later note.";
      const s = snippetOf(doc, 400, { queryTokens: ["constants", "retention"] });
      expect(s.text).toContain("RETENTION_MS");
      expect(s.text).not.toContain("An unrelated later note");
    });

    it("falls back to the newest update when the query appears nowhere", () => {
      const s = snippetOf(appended, 400, { queryTokens: ["zebra", "quantum"] });
      expect(s.text).toContain("Reversed to option B");
    });
  });

  describe("condensing layout noise", () => {
    it("strips zero-width padding and collapses tracking URLs so real content fits", () => {
      const email =
        "# Trip confirmation\n" + "&zwnj; ".repeat(200) +
        "\nhttps://click.example.com/?qs=" + "A".repeat(120) +
        "\n \n  \n The Hotel at Avalon, check-in 4:00pm.";
      const s = snippetOf(email, 400);
      expect(s.text).not.toContain("&zwnj;");
      expect(s.text).toContain("[link]");
      expect(s.text).toContain("The Hotel at Avalon");
    });

    it("collapses runs of blank layout lines", () => {
      const s = snippetOf("Header\n \n  \n \nBody text here. " + "filler ".repeat(200), 400);
      expect(s.text).not.toMatch(/\n[ \t]*\n/);
    });

    it("leaves ordinary prose readable", () => {
      const prose = "First paragraph sentence. ".repeat(20) + "\n\nSecond paragraph. " + "more. ".repeat(40);
      const s = snippetOf(prose, 200);
      expect(s.text).toContain("First paragraph sentence.");
    });
  });

  it("tolerates empty content", () => {
    const s = snippetOf("", 400);
    expect(s.truncated).toBe(false);
    expect(s.text).toBe("");
  });
});

describe("allowanceFor", () => {
  it("gives the leading matches the large allowance", () => {
    expect(allowanceFor(0, 1)).toBe(FULL_MATCH_MAX_CHARS);
    expect(allowanceFor(RECALL_FULL_MATCHES - 1, 1)).toBe(FULL_MATCH_MAX_CHARS);
  });

  it("gives the tail the small allowance regardless of score", () => {
    expect(allowanceFor(RECALL_FULL_MATCHES, 1)).toBe(SNIPPET_MAX_CHARS);
  });

  it("withholds the large allowance from a leading match that is much weaker than the top hit", () => {
    // Rank alone is not relevance: a distant second should not eat the budget.
    expect(allowanceFor(1, 0.2)).toBe(SNIPPET_MAX_CHARS);
  });
});

describe("queryRelevantWindow", () => {
  it("drops a partial leading word when a nonzero window starts inside it", () => {
    const content = `${"x".repeat(100)} alpha beta ${"noise ".repeat(100)}`;
    const window = queryRelevantWindow(content, ["alpha", "beta"]);

    expect(window).toMatch(/^alpha beta /);
    expect(window.length).toBeLessThanOrEqual(400);
  });

  // ── #326 ─────────────────────────────────────────────────────────────────────

  it("selects a late full-width passage for an ASCII token and returns the stored text (criterion 5)", () => {
    const content = "x".repeat(450) + " 設定は Ｃｌｏｕｄｆｌａｒｅ で管理する。" + "y".repeat(50);
    const window = queryRelevantWindow(content, ["cloudflare"]);
    expect(window).toContain("Ｃｌｏｕｄｆｌａｒｅ");
    expect(window).not.toContain("Cloudflare");
  });

  it("lets a two-character CJK token select a window and keeps the passage in unspaced text", () => {
    const content = "前".repeat(450) + "認証方式を変更した理由はここにある。" + "後".repeat(50);
    const window = queryRelevantWindow(content, ["認証"]);
    expect(window).toContain("認証方式を変更した理由");
  });

  it("still treats two-character ASCII tokens as noise", () => {
    const content = "x".repeat(450) + " ok fine " + "y".repeat(50);
    expect(queryRelevantWindow(content, ["ok"])).not.toContain("ok fine");
  });

  it("cuts on a CJK sentence end when no query term matches", () => {
    const window = queryRelevantWindow("これは日本語の文章です。".repeat(40), ["zebra"]);
    expect(window.endsWith("。")).toBe(true);
    expect(window.length).toBeLessThanOrEqual(400);
  });
});

describe("truncationNote", () => {
  it("carries the id and the full size so the caller can fetch the rest", () => {
    const note = truncationNote("abc-123", { text: "…", truncated: true, fullLength: 12345 });
    expect(note).toContain('get("abc-123")');
    expect(note).toMatch(/12[,.]345/);
  });
});
