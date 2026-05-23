import { describe, it, expect } from "vitest";
import { extractHashtags } from "../../src/index";

describe("extractHashtags", () => {
  it("returns empty hashtags and unchanged content when no hashtags present", () => {
    const { cleanContent, hashtags } = extractHashtags("plain text");
    expect(cleanContent).toBe("plain text");
    expect(hashtags).toEqual([]);
  });

  it("extracts a single hashtag and strips it from content", () => {
    const { cleanContent, hashtags } = extractHashtags("note #health");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["health"]);
  });

  it("extracts multiple hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("note #health #fitness");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["health", "fitness"]);
  });

  it("extracts a hashtag mid-sentence and collapses whitespace", () => {
    const { cleanContent, hashtags } = extractHashtags("went #health for a run");
    expect(cleanContent).toBe("went for a run");
    expect(hashtags).toEqual(["health"]);
  });

  it("lowercases hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("note #Health #FITNESS");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["health", "fitness"]);
  });

  it("returns empty cleanContent when content is only hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("#task");
    expect(cleanContent).toBe("");
    expect(hashtags).toEqual(["task"]);
  });

  it("collapses extra whitespace left by removed hashtags", () => {
    const { cleanContent, hashtags } = extractHashtags("a #b c");
    expect(cleanContent).toBe("a c");
    expect(hashtags).toEqual(["b"]);
  });

  it("handles hashtags with underscores and digits", () => {
    const { cleanContent, hashtags } = extractHashtags("note #tag_1 #item2");
    expect(cleanContent).toBe("note");
    expect(hashtags).toEqual(["tag_1", "item2"]);
  });
});
