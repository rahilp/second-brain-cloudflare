import { describe, it, expect } from "vitest";
import { tokenizeQuery } from "../../src/index";

describe("tokenizeQuery()", () => {
  it("preserves identifier-shaped tokens like version strings", () => {
    expect(tokenizeQuery("release v1.9")).toEqual(["release", "v1.9"]);
  });

  it("drops stopwords and 1-char tokens but keeps the meaningful ones", () => {
    expect(tokenizeQuery("What is the v1.9 release?")).toEqual(["v1.9", "release"]);
  });

  it("strips SQL LIKE wildcards so a token is always a literal substring", () => {
    expect(tokenizeQuery("foo_bar 100%")).toEqual(["foobar", "100"]);
  });

  it("deduplicates repeated tokens", () => {
    expect(tokenizeQuery("test test")).toEqual(["test"]);
  });

  it("returns an empty array when the query is all stopwords", () => {
    expect(tokenizeQuery("what is the")).toEqual([]);
  });
});
