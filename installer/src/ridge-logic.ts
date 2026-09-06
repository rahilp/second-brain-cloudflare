// Ridge's pure decision logic: the seen-set, the typing gate, the reveal and
// linger rules, the placement decision, the reaction throttle and the phase
// machine. No DOM, no storage, no imports — deliberately.
//
// This lives apart from `ridge.ts` rather than merely being exported from it,
// because `ridge.ts` imports `./shared` and `./i18n` for the DOM half. Those
// pull DOM globals and `@tauri-apps/api` into anything that touches this file,
// and the repo-root `tsc` (Worker-typed: `lib: ["ES2022"]`, no DOM) follows
// imports regardless of its `include`. So a test importing this logic from
// `ridge.ts` broke the root typecheck. Same arrangement, and same reason, as
// `rotation-state.ts` and `connection-role.ts`.

export type RidgeLineKind = "tour" | "reaction";

// ── Pure decision logic (no DOM, no storage — exported for test/unit/ridge.test.ts) ──

export function parseSeenSet(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function serializeSeenSet(seen: string[]): string {
  return JSON.stringify(seen);
}

export function hasSeen(seen: string[], key: string): boolean {
  return seen.includes(key);
}

/** Adds `key` if it is not already present; returns `seen` unchanged (same
 *  reference) when it already is, so a caller can cheaply skip a write. */
export function withSeen(seen: string[], key: string): string[] {
  return hasSeen(seen, key) ? seen : [...seen, key];
}

/** Whether an element with this tag name is a field Ridge must not interrupt
 *  with a *tour* line. Reaction lines bypass this — they exist specifically to
 *  respond to what's being typed. */
export function isFieldFocused(tagName: string | null | undefined): boolean {
  return tagName === "INPUT" || tagName === "TEXTAREA";
}

/**
 * Whether a tour line should be silently dropped rather than shown.
 *
 * `sameAsShown` is the load-bearing case: a locale switch re-runs the current
 * screen, which calls `ridgeSay` again with the *same* key, now in the other
 * language. That must always update the bubble's text — never be read as "a
 * once-line firing a second time" and suppressed, or switching languages mid-
 * sentence would silently hide Ridge instead of translating him.
 */
export function shouldSuppressLine(opts: {
  sameAsShown: boolean;
  persist?: "once" | "always";
  alreadySeen: boolean;
}): boolean {
  return !opts.sameAsShown && opts.persist === "once" && opts.alreadySeen;
}

/** 2 characters per animation frame, per plan §4.3. */
export function stepRevealCount(shown: number, total: number, charsPerTick = 2): number {
  return Math.min(total, shown + charsPerTick);
}

/** How long a fully-revealed line stays up before popping out, absent an
 *  explicit `dismissMs`. Reaction lines get less room — they're commentary on
 *  something already visible (the strength meter, the field itself), not the
 *  only place the information lives. */
export function lingerMs(kind: RidgeLineKind = "tour"): number {
  return kind === "reaction" ? 5000 : 7000;
}

/**
 * The reaction throttle: fires only on an actual change of bucket, and never
 * repeats the bucket already showing — so a password that stays weak for ten
 * keystrokes gets the concerned line once, not on every keystroke, and a
 * bucket that clears (`null`, e.g. back to strong) never fires anything on its
 * own re-entry until it becomes non-null again.
 */
export function shouldFireReaction<B>(prevBucket: B | null, nextBucket: B | null): boolean {
  return nextBucket !== null && nextBucket !== prevBucket;
}

/** Available width to either side of the anchor before Ridge (a fixed
 *  `RIDGE_CHARACTER_WIDTH`, plus a gap off the anchor and a margin off the
 *  window edge) would crowd it or run off-window. */
export const RIDGE_CHARACTER_WIDTH = 200;
export const RIDGE_ANCHOR_GAP = 12;
export const RIDGE_EDGE_MARGIN = 12;

export type RidgePlacement = "right" | "left" | "below";

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Where Ridge stands relative to the control he's commenting on. Right first —
 * reading order, and it keeps him clear of a column of stacked full-width
 * controls; left as the fallback for an anchor pinned to the window's right
 * edge; below only when neither side has room, which is the common case at
 * the installer window's 760px minimum width (plan/#hardening).
 */
export function decideRidgePlacement(anchorRect: AnchorRect, viewportWidth: number): RidgePlacement {
  const required = RIDGE_CHARACTER_WIDTH + RIDGE_ANCHOR_GAP + RIDGE_EDGE_MARGIN;
  const spaceRight = viewportWidth - anchorRect.right;
  if (spaceRight >= required) return "right";
  const spaceLeft = anchorRect.left;
  if (spaceLeft >= required) return "left";
  return "below";
}

/**
 * The pop/swap/linger/pop-out state machine. A pure reduction so the timers
 * and CSS-class wiring below it can be tested by asserting on the sequence of
 * events they feed in, rather than on wall-clock animation behaviour.
 */
export type RidgePhase = "hidden" | "popping" | "revealing" | "lingering" | "popping-out";
export type RidgePhaseEvent =
  | "pop"
  | "swap"
  | "popInDone"
  | "revealDone"
  | "lingerDone"
  | "popOutDone"
  | "dismiss";

export function nextRidgePhase(phase: RidgePhase, event: RidgePhaseEvent): RidgePhase {
  switch (event) {
    case "pop":
      return "popping";
    case "swap":
      // A new line while hidden pops fresh; a new line while any part of him
      // is already on screen swaps the bubble in place instead of re-popping.
      return phase === "hidden" ? "popping" : "revealing";
    case "popInDone":
      return phase === "popping" ? "revealing" : phase;
    case "revealDone":
      return phase === "revealing" ? "lingering" : phase;
    case "lingerDone":
      return phase === "lingering" ? "popping-out" : phase;
    case "popOutDone":
      return phase === "popping-out" ? "hidden" : phase;
    case "dismiss":
      return phase === "hidden" ? "hidden" : "popping-out";
    default:
      return phase;
  }
}
