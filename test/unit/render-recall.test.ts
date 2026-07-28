import { describe, it, expect } from "vitest";
import { renderRecallText } from "../../src/recall/render";
import type { RecallMatch } from "../../src/recall/types";

function m(over: Partial<RecallMatch> = {}): RecallMatch {
  return { id: "entry-123", content: "A memory", score: 1, createdAt: 1700000000000, tags: ["work"], source: "claude", isUpdate: false, hop: 0, ...over };
}

describe("renderRecallText", () => {
  it("includes the entry ID for each result so tools/LLMs can act on it (link, append, update, forget)", () => {
    const out = renderRecallText([m({ id: "abc-123" })], "");
    expect(out).toContain("ID: abc-123");
  });

  it("numbers multiple results and surfaces every id", () => {
    const out = renderRecallText([m({ id: "first" }), m({ id: "second" })], "");
    expect(out).toMatch(/^1\./);
    expect(out).toContain("ID: first");
    expect(out).toContain("ID: second");
  });

  it("prepends the insight header when present", () => {
    const out = renderRecallText([m()], "Key takeaway");
    expect(out.startsWith("**Insight:** Key takeaway")).toBe(true);
  });

  it("still shows score and content", () => {
    const out = renderRecallText([m({ score: 1, content: "Hello world" })], "");
    expect(out).toContain("100% match");
    expect(out).toContain("Hello world");
  });

  describe("graph-expanded (hop) provenance (#225)", () => {
    it("labels an auto-inferred hop 'auto-linked' and names the memory it came from", () => {
      const seed = m({ id: "seed", content: "Pricing decision for Q3", hop: 0 });
      const hopMatch = m({ id: "hopA", content: "Related note", hop: 1, viaProvenance: "inferred", viaLinkedAt: 1700000000000, viaFrom: "seed" });
      const out = renderRecallText([seed, hopMatch], "");
      expect(out).toContain("[related · auto-linked");
      expect(out).toContain('from "Pricing decision for Q3"');
    });

    it("distinguishes a user-made link ('you linked') from a system link ('system-linked')", () => {
      expect(renderRecallText([m({ hop: 1, viaProvenance: "explicit" })], "")).toContain("you linked");
      expect(renderRecallText([m({ hop: 1, viaProvenance: "system" })], "")).toContain("system-linked");
    });

    it("omits the from-clause when the parent memory is not in the result set", () => {
      const out = renderRecallText([m({ id: "hopA", hop: 1, viaProvenance: "inferred", viaFrom: "not-present" })], "");
      expect(out).toContain("[related · auto-linked");
      expect(out).not.toContain(" · from ");
    });

    it("adds no [related] label to a direct (hop 0) match", () => {
      expect(renderRecallText([m({ hop: 0 })], "")).not.toContain("[related");
    });
  });
});
