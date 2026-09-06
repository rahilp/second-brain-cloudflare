/**
 * Ridge's decision logic (plan.md §4 / #hardening), the part of
 * `installer/src/ridge.ts` that does not touch the DOM.
 *
 * `main.ts` resolves `#app` at module scope and cannot be imported outside a
 * webview, and `ridge.ts` mounts into `document.body` the same way — but the
 * seen-set, the typing gate, the reveal/settle rules, the placement decision,
 * the reaction throttle, and the pop/swap/pop-out phase machine are all plain
 * functions of plain data, exported alongside the DOM-touching ones for
 * exactly this reason, the same arrangement `rotation-state.ts` and
 * `connection-role.ts` use.
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
  lingerMs,
  shouldFireReaction,
  decideRidgePlacement,
  nextRidgePhase,
  RIDGE_CHARACTER_WIDTH,
  RIDGE_ANCHOR_GAP,
  RIDGE_EDGE_MARGIN,
  type AnchorRect,
} from "../../installer/src/ridge-logic";

function rect(partial: Partial<AnchorRect>): AnchorRect {
  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...partial };
}

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

describe("the typing() gate — tour lines only", () => {
  it("treats an input or textarea as a field a tour line must not interrupt", () => {
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

describe("whether a tour line should be suppressed", () => {
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

describe("linger duration", () => {
  it("gives a tour line the full 7s — it's part of the guided script", () => {
    expect(lingerMs("tour")).toBe(7000);
    expect(lingerMs()).toBe(7000);
  });

  it("gives a reaction line only 5s — it's commentary on something already visible", () => {
    expect(lingerMs("reaction")).toBe(5000);
  });
});

describe("the reaction throttle", () => {
  it("fires on the first entry into a bucket", () => {
    expect(shouldFireReaction(null, "weak")).toBe(true);
  });

  it("never fires twice in a row for the same bucket — ten weak keystrokes, one reaction", () => {
    expect(shouldFireReaction("weak", "weak")).toBe(false);
  });

  it("fires again once the bucket actually changes", () => {
    expect(shouldFireReaction("weak", "breached")).toBe(true);
    expect(shouldFireReaction("breached", "weak")).toBe(true);
  });

  it("never fires for a null bucket — nothing to react to", () => {
    expect(shouldFireReaction("weak", null)).toBe(false);
    expect(shouldFireReaction(null, null)).toBe(false);
  });

  it("re-fires on re-entry to a bucket once it was cleared in between", () => {
    // weak -> null -> weak: the second "weak" is a fresh reaction, not a repeat,
    // because the caller resets its tracked bucket to null in between.
    expect(shouldFireReaction(null, "weak")).toBe(true);
  });
});

describe("placement — right, then left, then below", () => {
  const width = RIDGE_CHARACTER_WIDTH + RIDGE_ANCHOR_GAP + RIDGE_EDGE_MARGIN;

  it("stands to the right when there is room", () => {
    const anchor = rect({ left: 40, right: 300, top: 100, bottom: 140, width: 260, height: 40 });
    expect(decideRidgePlacement(anchor, 300 + width)).toBe("right");
  });

  it("falls back to the left when the right side is too tight but the left isn't", () => {
    const viewport = 900;
    const anchor = rect({ left: viewport - 10, right: viewport - 5, top: 100, bottom: 140, width: 5, height: 40 });
    expect(decideRidgePlacement(anchor, viewport)).toBe("left");
  });

  it("drops below when neither side has room — the installer's 760px minimum width", () => {
    // .screen caps at 520px centered in a 760px window: ~120px gutter on
    // each side, well under the ~224px a 200px-wide Ridge plus gaps needs.
    const anchor = rect({ left: 120, right: 640, top: 100, bottom: 140, width: 520, height: 40 });
    expect(decideRidgePlacement(anchor, 760)).toBe("below");
  });

  it("treats the exact clearance threshold as enough room", () => {
    const anchor = rect({ left: 0, right: 0, top: 0, bottom: 40, width: 0, height: 40 });
    expect(decideRidgePlacement(anchor, width)).toBe("right");
    expect(decideRidgePlacement(anchor, width - 1)).toBe("below");
  });
});

describe("the pop/swap/linger/pop-out phase machine", () => {
  it("pops fresh from hidden", () => {
    expect(nextRidgePhase("hidden", "pop")).toBe("popping");
  });

  it("advances popping -> revealing -> lingering -> popping-out -> hidden", () => {
    expect(nextRidgePhase("popping", "popInDone")).toBe("revealing");
    expect(nextRidgePhase("revealing", "revealDone")).toBe("lingering");
    expect(nextRidgePhase("lingering", "lingerDone")).toBe("popping-out");
    expect(nextRidgePhase("popping-out", "popOutDone")).toBe("hidden");
  });

  it("swaps a new line in place instead of re-popping when already visible", () => {
    expect(nextRidgePhase("lingering", "swap")).toBe("revealing");
    expect(nextRidgePhase("revealing", "swap")).toBe("revealing");
  });

  it("pops fresh (not swap) when a new line arrives while hidden", () => {
    expect(nextRidgePhase("hidden", "swap")).toBe("popping");
  });

  it("dismissal pops out from any visible phase, and is a no-op while hidden", () => {
    expect(nextRidgePhase("popping", "dismiss")).toBe("popping-out");
    expect(nextRidgePhase("revealing", "dismiss")).toBe("popping-out");
    expect(nextRidgePhase("lingering", "dismiss")).toBe("popping-out");
    expect(nextRidgePhase("hidden", "dismiss")).toBe("hidden");
  });

  it("ignores an event that doesn't apply to the current phase", () => {
    // revealDone only means something while revealing.
    expect(nextRidgePhase("lingering", "revealDone")).toBe("lingering");
    expect(nextRidgePhase("hidden", "popInDone")).toBe("hidden");
  });
});
