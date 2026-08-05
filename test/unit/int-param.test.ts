/**
 * #277 — integer query parameters reached the database unvalidated.
 *
 * `parseInt` yields NaN for anything it cannot start reading, and NaN survives
 * every clamp (`Math.min(NaN, 100)` is NaN), so the bad value landed in D1:
 * `LIMIT NaN` is a SQLITE_MISMATCH, and `created_at >= NaN` matches nothing, so
 * a malformed date filter answered 200 with an empty list.
 *
 * These are the parser's own rules. The end-to-end consequences are covered in
 * test/integration/query-param-validation.test.ts.
 */
import { describe, it, expect } from "vitest";
import { intParam } from "../../src/lib/http";

function parse(query: string, name: string, opts?: any) {
  const url = new URL(`http://localhost/list?${query}`);
  return intParam(url, name, opts);
}

async function errorOf(res: Response): Promise<unknown> {
  return res.json();
}

describe("intParam", () => {
  it("reads a plain integer", () => {
    expect(parse("n=42", "n")).toBe(42);
  });

  it("returns the documented default when the parameter is absent", () => {
    expect(parse("", "n", { fallback: 20 })).toBe(20);
  });

  it("returns undefined for an absent parameter that has no default", () => {
    expect(parse("", "after")).toBeUndefined();
  });

  // Only absence gets the default. Treating `?after=` as absent would drop the
  // filter and answer with more rows than were asked for — the exact failure the
  // 400 exists to prevent — so a present-but-empty value is rejected instead.
  it("rejects a present-but-empty value rather than defaulting it", () => {
    expect(parse("n=", "n", { fallback: 20 })).toBeInstanceOf(Response);
    expect(parse("after=", "after")).toBeInstanceOf(Response);
  });

  // `?after` with no `=` parses to the same empty value.
  it("rejects a valueless parameter", () => {
    expect(parse("after", "after")).toBeInstanceOf(Response);
  });

  it("rejects a whitespace-only value", () => {
    expect(parse("n=%20%20", "n", { fallback: 20 })).toBeInstanceOf(Response);
  });

  it("clamps rather than rejects an out-of-range value", () => {
    expect(parse("n=200", "n", { fallback: 20, min: 0, max: 100 })).toBe(100);
    expect(parse("topK=999", "topK", { fallback: 5, min: 1, max: 20 })).toBe(20);
    expect(parse("hops=-4", "hops", { fallback: 0, min: 0, max: 3 })).toBe(0);
  });

  it("rejects a non-numeric value with a 400 naming the parameter", async () => {
    const res = parse("after=abc", "after");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
    expect(await errorOf(res as Response)).toEqual({ ok: false, error: "after must be an integer" });
  });

  it("rejects a fractional value", () => {
    expect(parse("n=2.5", "n", { fallback: 20 })).toBeInstanceOf(Response);
  });

  // Beyond 2^53 the arithmetic that follows is no longer exact, so the value
  // that would reach D1 is not the one the caller wrote.
  it("rejects an integer too large to represent exactly", () => {
    expect(parse("after=99999999999999999999", "after")).toBeInstanceOf(Response);
  });

  /**
   * The parameter values called out on #277, old parsing against new.
   *
   * Every value that is a well-formed integer is unchanged, including the
   * whitespace-padded and explicitly-signed forms. The four that change are the
   * four where `parseInt` returned a number the caller never wrote: it stops at
   * the first character it cannot use, so "7abc" was 7, "1e3" was 1 and "0x10"
   * was 0 — the same silent-substitution failure #277 is about, one layer up.
   */
  const CASES: { raw: string; old: number; now: number | "400" }[] = [
    { raw: "5",     old: 5,    now: 5 },
    { raw: "0",     old: 0,    now: 0 },
    { raw: "-3",    old: -3,   now: -3 },
    { raw: "100",   old: 100,  now: 100 },
    { raw: "1000",  old: 1000, now: 1000 },
    { raw: "  7  ", old: 7,    now: 7 },
    { raw: "7abc",  old: 7,    now: "400" },
    { raw: "1e3",   old: 1,    now: "400" },
    { raw: "0x10",  old: 0,    now: "400" },
    { raw: "+5",    old: 5,    now: 5 },
  ];

  it.each(CASES)("parses $raw the same way parseInt did, or rejects it ($now)", ({ raw, old, now }) => {
    // The old expression, verbatim, so the comparison is against real behaviour
    // rather than a description of it.
    expect(parseInt(raw, 10)).toBe(old);

    const result = parse(`v=${encodeURIComponent(raw)}`, "v");
    if (now === "400") {
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    } else {
      expect(result).toBe(now);
      expect(result).toBe(old); // unchanged from the old parsing
    }
  });
});
