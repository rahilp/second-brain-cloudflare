/**
 * Ridge's decision logic (plan.md §4), the part of `installer/src/ridge.ts`
 * that does not touch the DOM.
 *
 * `main.ts` resolves `#app` at module scope and cannot be imported outside a
 * webview, and `ridge.ts` mounts into `document.body` the same way — but the
 * seen-set, the typing gate, and the reveal/settle rules are plain functions
 * of plain data, exported alongside the DOM-touching ones for exactly this
 * reason, the same arrangement `rotation-state.ts` and `connection-role.ts`
 * use.
 */
import { describe, it, expect } from "vitest";
import {
  parseSeenSet,
  serializeSeenSet,
  hasSeen,
  withSeen,
  isFieldFocused,
  shouldSuppressLine,
  stepRevealCount,
  nextRidgeState,
} from "../../installer/src/ridge";

describe("the ridge.seen.v1 set", () => {
  it("reads an empty or missing record as no lines seen", () => {
    expect(parseSeenSet(null)).toEqual([]);
    expect(parseSeenSet("")).toEqual([]);
  });

  it("survives garbage without throwing", () => {
    expect(parseSeenSet("not json")).toEqual([]);
    expect(parseSeenSet('{"not":"an array"}')).toEqual([]);
    // Only string entries: a corrupted or hand-edited record must not crash
    // `hasSeen`/`withSeen` on a non-string key.
    expect(parseSeenSet('["a", 2, null, "b"]')).toEqual(["a", "b"]);
  });

  it("round-trips through serialize/parse", () => {
    const seen = ["mascot.welcome.intro", "mascot.details.allSetSolo"];
    expect(parseSeenSet(serializeSeenSet(seen))).toEqual(seen);
  });

  it("adds a key once and is a no-op on a repeat", () => {
    const once = withSeen([], "mascot.welcome.intro");
    expect(once).toEqual(["mascot.welcome.intro"]);
    const again = withSeen(once, "mascot.welcome.intro");
    expect(again).toEqual(["mascot.welcome.intro"]);
    // Same reference back when nothing changed, so a caller can skip a write.
    expect(again).toBe(once);
  });

  it("hasSeen reports only what's actually recorded", () => {
    const seen = withSeen([], "mascot.password.intro");
    expect(hasSeen(seen, "mascot.password.intro")).toBe(true);
    expect(hasSeen(seen, "mascot.password.breached")).toBe(false);
  });
});

describe("the typing() gate", () => {
  it("treats an input or textarea as a field Ridge must not interrupt", () => {
    expect(isFieldFocused("INPUT")).toBe(true);
    expect(isFieldFocused("TEXTAREA")).toBe(true);
  });

  it("lets everything else through, including nothing focused", () => {
    expect(isFieldFocused("BUTTON")).toBe(false);
    expect(isFieldFocused("A")).toBe(false);
    expect(isFieldFocused("BODY")).toBe(false);
    expect(isFieldFocused(null)).toBe(false);
    expect(isFieldFocused(undefined)).toBe(false);
  });
});

describe("whether a line should be suppressed", () => {
  it("never suppresses an 'always' line, seen or not", () => {
    expect(
      shouldSuppressLine({ sameAsShown: false, persist: "always", alreadySeen: true }),
    ).toBe(false);
    expect(
      shouldSuppressLine({ sameAsShown: false, persist: "always", alreadySeen: false }),
    ).toBe(false);
  });

  it("never suppresses a line with no persist field", () => {
    expect(shouldSuppressLine({ sameAsShown: false, alreadySeen: true })).toBe(false);
  });

  it("lets a first-time 'once' line through", () => {
    expect(
      shouldSuppressLine({ sameAsShown: false, persist: "once", alreadySeen: false }),
    ).toBe(false);
  });

  it("suppresses a genuinely repeated 'once' line", () => {
    expect(
      shouldSuppressLine({ sameAsShown: false, persist: "once", alreadySeen: true }),
    ).toBe(true);
  });

  it("never suppresses the line already on screen — the locale-switch case", () => {
    // A locale change re-runs the current screen, which calls ridgeSay again
    // with the SAME key, now in the other language. Reading that as "a
    // once-line firing a second time" would hide Ridge instead of
    // translating him, so `sameAsShown` overrides everything else.
    expect(
      shouldSuppressLine({ sameAsShown: true, persist: "once", alreadySeen: true }),
    ).toBe(false);
  });
});

describe("the 2-chars-per-frame reveal", () => {
  it("advances by the tick size without overshooting the total", () => {
    expect(stepRevealCount(0, 10)).toBe(2);
    expect(stepRevealCount(8, 10)).toBe(10);
    expect(stepRevealCount(10, 10)).toBe(10);
  });

  it("supports a custom tick size", () => {
    expect(stepRevealCount(0, 10, 5)).toBe(5);
  });

  it("settles immediately on an empty line", () => {
    expect(stepRevealCount(0, 0)).toBe(0);
  });
});

describe("settling to idle once a line is fully said", () => {
  it("only 'talking' settles — its mouth/bounce keyframes are infinite and would otherwise run forever", () => {
    expect(nextRidgeState("talking", true)).toBe("idle");
    expect(nextRidgeState("talking", false)).toBe("talking");
  });

  it("every other state holds — it's a deliberate, sustained expression a screen chose", () => {
    for (const state of ["concerned", "celebrating", "thinking", "pointing", "waving", "idle"] as const) {
      expect(nextRidgeState(state, true)).toBe(state);
      expect(nextRidgeState(state, false)).toBe(state);
    }
  });
});
