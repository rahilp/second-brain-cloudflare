import { describe, it, expect } from "vitest";
import { isInsightEligible, topicTagsOf, isAssistantAuthored, ASSISTANT_TAGS, AXIS_TAGS } from "../../src/insight/eligibility";
import { MIRRORED_SOURCES, TRANSCRIPT_SOURCES } from "../../src/constants";

const entry = (over: Partial<{ content: string; tags: string[]; source: string }> = {}) => ({
  content: "A decision about the pricing model, written out at some length so it clears the floor.",
  tags: ["work", "pricing"],
  source: "claude-desktop",
  ...over,
});

describe("isInsightEligible()", () => {
  it("accepts an ordinary human-authored entry", () => {
    expect(isInsightEligible(entry())).toBe(true);
  });

  it("rejects machine-authored entries", () => {
    for (const tag of ["synthesized", "auto-pattern", "auto-insight"]) {
      expect(isInsightEligible(entry({ tags: ["work", tag] }))).toBe(false);
    }
  });

  it("rejects deprecated entries", () => {
    expect(isInsightEligible(entry({ tags: ["work", "status:deprecated"] }))).toBe(false);
  });

  it("rejects entries carrying only system tags", () => {
    expect(isInsightEligible(entry({ tags: ["kind:episodic", "status:canonical"] }))).toBe(false);
  });

  // Derived, not listed. The hand-written version of this test named three
  // sources and passed for months while every calendar provider was missing from
  // the predicate — so calendar records were reasoned over as though a person
  // had written them. A test that repeats the production list cannot catch the
  // production list being wrong.
  it("rejects every mirrored source", () => {
    for (const source of MIRRORED_SOURCES) {
      expect(isInsightEligible(entry({ source })), `${source} should be ineligible`).toBe(false);
    }
  });

  it("rejects entries too short to carry an idea", () => {
    expect(isInsightEligible(entry({ content: "Shipped v2." }))).toBe(false);
  });

  it("rejects every transcript source", () => {
    for (const source of TRANSCRIPT_SOURCES) {
      expect(isInsightEligible(entry({ source })), `${source} should be ineligible`).toBe(false);
    }
  });
});

describe("isAssistantAuthored()", () => {
  it("recognises an assistant-written memory", () => {
    expect(isAssistantAuthored(["work", "claude-response"])).toBe(true);
    expect(isAssistantAuthored(["work", "codex-response"])).toBe(true);
  });

  it("does not claim a user-written memory", () => {
    expect(isAssistantAuthored(["work", "pricing"])).toBe(false);
    expect(isAssistantAuthored([])).toBe(false);
  });

  it("ignores case, because tags arrive from three different clients", () => {
    expect(isAssistantAuthored(["Claude-Response"])).toBe(true);
  });

  // Derived, not copied. A second hand-written list is how INTEGRATION_SOURCES
  // fell three providers behind its registry.
  it("draws every assistant tag from the axis-tag list", () => {
    for (const tag of ASSISTANT_TAGS) {
      expect(AXIS_TAGS.has(tag), `${tag} must also be an axis tag`).toBe(true);
    }
    expect(ASSISTANT_TAGS.size).toBeGreaterThan(0);
    expect(ASSISTANT_TAGS.size).toBe([...AXIS_TAGS].filter(t => t.endsWith("-response")).length);
  });
});

describe("topicTagsOf()", () => {
  it("strips system, bookkeeping and axis tags", () => {
    const topics = topicTagsOf([
      "work", "task", "context", "claude-response",   // axis
      "kind:semantic", "status:canonical",            // system
      "rolled-up", "duplicate-candidate",             // bookkeeping
      "pricing",                                      // the only real topic
    ]);
    expect([...topics]).toEqual(["pricing"]);
  });

  it("is case-insensitive about axis tags", () => {
    expect([...topicTagsOf(["Work", "pricing"])]).toEqual(["pricing"]);
  });
});
