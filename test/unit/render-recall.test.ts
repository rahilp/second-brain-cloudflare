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
});
