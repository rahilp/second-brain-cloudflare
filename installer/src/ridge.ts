// Ridge, the pop-up helper mascot. Absent by default — mounted once outside
// `#app` (so `show()`'s `app.replaceChildren(...)` in main.ts never touches
// it), but invisible and out of layout until a screen has something for him
// to say. `ridgeSay(...)` pops him in beside whatever he's commenting on,
// holds his line, then pops back out. He never occupies a fixed dock.
//
// Pure decision logic is exported separately from the DOM-touching functions
// below it, for the same reason `rotation-state.ts` and `connection-role.ts`
// are pure: `main.ts` resolves `#app` at module scope and cannot be imported
// outside a webview, so anything worth a test has to be reachable without one.
import { h } from "./shared";
import { t } from "./i18n";
import { RIDGE_SVG } from "./ridge-svg";

export type RidgeState = "idle" | "talking" | "thinking" | "celebrating" | "concerned" | "alarmed";

export type RidgeLineKind = "tour" | "reaction";

export interface RidgeLine {
  /** Stable and never reused for a different sentence — the `ridge.seen.v1` key. */
  key: string;
  text: string;
  /** Defaults to "talking": a line is, by construction, Ridge saying something. */
  state?: RidgeState;
  /** Evaluated at render time, never cached — the element it points to may not
   *  exist yet when `ridgeSay` is called (e.g. before `show()` runs). Omitted =
   *  the screen's primary button. */
  anchor?: () => HTMLElement | null;
  /** "once" = first time ever, tracked in localStorage. Omitted or "always" =
   *  every time this call site runs. Only consulted for `kind: "tour"`. */
  persist?: "once" | "always";
  /** Auto-dismiss this many ms after the line first appears — a hard cap,
   *  measured from render, not from reveal completion. Omitted = the normal
   *  kind-based linger below. */
  dismissMs?: number;
  /** "tour" (default): part of the guided script, gated by the seen-set and
   *  the typing() focus gate, lingers ~7s once fully revealed. "reaction":
   *  triggered by something the user just did (a password going weak, a
   *  breach hit), never gated by the seen-set or focus, lingers ~5s. */
  kind?: RidgeLineKind;
  /** A standout moment (first hello, "you're all set") — a slightly larger
   *  figure, nothing else. */
  hero?: boolean;
}

const SEEN_KEY = "ridge.seen.v1";

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

// ── DOM-touching module state ────────────────────────────────────────────────

let mounted = false;
let rootEl: HTMLElement;
let figureEl: HTMLElement;
let bubbleEl: HTMLElement;
let bubbleTextEl: HTMLElement;

let phase: RidgePhase = "hidden";
let pendingLine: RidgeLine | null = null;
let currentKey: string | null = null;
let currentAnchor: (() => HTMLElement | null) | undefined;

let revealFrame: number | undefined;
let lingerTimer: number | undefined;
let capTimer: number | undefined;
let popInEndHandler: (() => void) | undefined;
let popOutEndHandler: (() => void) | undefined;

function loadSeen(): string[] {
  try {
    return parseSeenSet(localStorage.getItem(SEEN_KEY));
  } catch {
    return [];
  }
}

function saveSeen(seen: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, serializeSeenSet(seen));
  } catch {
    /* private mode / unavailable — the line just gets said again next launch */
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function setPhase(next: RidgePhase): void {
  phase = next;
  rootEl.dataset.ridgePhase = next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Explicit anchor when given; otherwise the screen's primary button, then
 *  the screen itself, so a screen with nothing else at least gets a sane
 *  place to stand rather than the window's corner. */
function resolveAnchorEl(anchorFn?: () => HTMLElement | null): HTMLElement | null {
  const explicit = anchorFn?.();
  if (explicit) return explicit;
  return (
    document.querySelector<HTMLElement>(".screen .btn-primary") ??
    document.querySelector<HTMLElement>(".screen")
  );
}

/** Positions the (already-visible, already-sized) root against the anchor,
 *  then nudges the bubble back on-screen if it would run off an edge —
 *  the bubble can be up to 260px wide against a 200px figure, so it is
 *  measured after the fact rather than assumed to fit. */
function position(anchorFn?: () => HTMLElement | null): void {
  const anchorEl = resolveAnchorEl(anchorFn);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect: AnchorRect = anchorEl
    ? anchorEl.getBoundingClientRect()
    : { top: vh / 2, bottom: vh / 2, left: vw / 2, right: vw / 2, width: 0, height: 0 };

  const placement = decideRidgePlacement(rect, vw);
  rootEl.dataset.ridgePlacement = placement;

  const figW = figureEl.offsetWidth || RIDGE_CHARACTER_WIDTH;
  const figH = figureEl.offsetHeight || Math.round((RIDGE_CHARACTER_WIDTH * 665) / 950);

  let left: number;
  let top: number;
  if (placement === "right") {
    left = rect.right + RIDGE_ANCHOR_GAP;
    top = rect.top + rect.height / 2 - figH / 2;
  } else if (placement === "left") {
    left = rect.left - RIDGE_ANCHOR_GAP - figW;
    top = rect.top + rect.height / 2 - figH / 2;
  } else {
    left = rect.left + rect.width / 2 - figW / 2;
    top = rect.bottom + RIDGE_ANCHOR_GAP;
  }

  top = clamp(top, RIDGE_EDGE_MARGIN, vh - figH - RIDGE_EDGE_MARGIN);
  left = clamp(left, RIDGE_EDGE_MARGIN, vw - figW - RIDGE_EDGE_MARGIN);
  rootEl.style.left = `${left}px`;
  rootEl.style.top = `${top}px`;

  requestAnimationFrame(clampBubbleIntoViewport);
}

/** The figure's box is placed precisely; the bubble hangs off it by CSS and
 *  can be wider than the figure or long enough to clear the top of a short
 *  window. Nudges the whole root, so the bubble's tail stays pointed at him. */
function clampBubbleIntoViewport(): void {
  if (phase === "hidden") return;
  const rect = bubbleEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let dx = 0;
  let dy = 0;
  if (rect.left < RIDGE_EDGE_MARGIN) dx = RIDGE_EDGE_MARGIN - rect.left;
  else if (rect.right > vw - RIDGE_EDGE_MARGIN) dx = vw - RIDGE_EDGE_MARGIN - rect.right;
  if (rect.top < RIDGE_EDGE_MARGIN) dy = RIDGE_EDGE_MARGIN - rect.top;
  else if (rect.bottom > vh - RIDGE_EDGE_MARGIN) dy = vh - RIDGE_EDGE_MARGIN - rect.bottom;
  if (!dx && !dy) return;
  const left = parseFloat(rootEl.style.left || "0");
  const top = parseFloat(rootEl.style.top || "0");
  rootEl.style.left = `${left + dx}px`;
  rootEl.style.top = `${top + dy}px`;
}

function cancelReveal(): void {
  if (revealFrame !== undefined) {
    cancelAnimationFrame(revealFrame);
    revealFrame = undefined;
  }
}

function runTypedReveal(text: string, onDone: () => void): void {
  cancelReveal();
  bubbleTextEl.textContent = "";
  let shown = 0;
  const step = () => {
    shown = stepRevealCount(shown, text.length);
    bubbleTextEl.textContent = text.slice(0, shown);
    if (shown >= text.length) {
      revealFrame = undefined;
      onDone();
    } else {
      revealFrame = requestAnimationFrame(step);
    }
  };
  revealFrame = requestAnimationFrame(step);
}

/** Ends the current appearance. `event` distinguishes a natural linger
 *  timeout from an explicit dismissal only for the pure phase reduction above —
 *  both end up in the same place: fade out, then fully hidden. */
function beginPopOut(event: "dismiss" | "lingerDone"): void {
  if (phase === "hidden" || phase === "popping-out") return;
  window.clearTimeout(lingerTimer);
  window.clearTimeout(capTimer);
  cancelReveal();
  if (popInEndHandler) {
    figureEl.removeEventListener("animationend", popInEndHandler);
    popInEndHandler = undefined;
  }
  setPhase(nextRidgePhase(phase, event));

  const finish = () => {
    popOutEndHandler = undefined;
    setPhase(nextRidgePhase(phase, "popOutDone"));
    bubbleTextEl.textContent = "";
    currentKey = null;
    currentAnchor = undefined;
  };
  if (prefersReducedMotion()) {
    finish();
  } else {
    popOutEndHandler = finish;
    rootEl.addEventListener("animationend", finish, { once: true });
  }
}

function renderLine(line: RidgeLine, sameAsShown: boolean, kind: RidgeLineKind): void {
  window.clearTimeout(lingerTimer);
  window.clearTimeout(capTimer);
  if (popOutEndHandler) {
    rootEl.removeEventListener("animationend", popOutEndHandler);
    popOutEndHandler = undefined;
  }
  if (popInEndHandler) {
    figureEl.removeEventListener("animationend", popInEndHandler);
    popInEndHandler = undefined;
  }

  const state: RidgeState = line.state ?? "talking";
  rootEl.dataset.ridgeState = state;
  rootEl.classList.toggle("ridge--hero", !!line.hero);

  const wasHidden = phase === "hidden";
  const reduced = prefersReducedMotion();

  const onRevealDone = () => {
    setPhase(nextRidgePhase(phase, "revealDone"));
    if (!line.dismissMs) {
      lingerTimer = window.setTimeout(() => beginPopOut("lingerDone"), lingerMs(kind));
    }
  };

  const reveal = () => {
    if (reduced || sameAsShown) {
      cancelReveal();
      bubbleTextEl.textContent = line.text;
      onRevealDone();
    } else {
      runTypedReveal(line.text, onRevealDone);
    }
  };

  setPhase(nextRidgePhase(phase, wasHidden ? "pop" : "swap"));
  position(line.anchor);

  if (line.dismissMs) {
    capTimer = window.setTimeout(() => beginPopOut("dismiss"), line.dismissMs);
  }

  if (wasHidden && !reduced) {
    popInEndHandler = () => {
      popInEndHandler = undefined;
      setPhase(nextRidgePhase(phase, "popInDone"));
      reveal();
    };
    figureEl.addEventListener("animationend", popInEndHandler, { once: true });
  } else {
    if (phase === "popping") setPhase(nextRidgePhase(phase, "popInDone"));
    reveal();
  }
}

function present(line: RidgeLine): void {
  const kind: RidgeLineKind = line.kind ?? "tour";
  const sameAsShown = currentKey === line.key && phase !== "hidden";

  if (kind === "tour") {
    const seen = loadSeen();
    if (shouldSuppressLine({ sameAsShown, persist: line.persist, alreadySeen: hasSeen(seen, line.key) })) {
      ridgeDismiss();
      return;
    }
    if (!sameAsShown && line.persist === "once") {
      saveSeen(withSeen(seen, line.key));
    }
  }

  currentKey = line.key;
  currentAnchor = line.anchor;
  renderLine(line, sameAsShown, kind);
}

function isFieldActive(): boolean {
  return isFieldFocused(document.activeElement?.tagName ?? null);
}

function flushPending(): void {
  if (!pendingLine || isFieldActive()) return;
  const line = pendingLine;
  pendingLine = null;
  present(line);
}

/** Mounted once outside `#app`. Idempotent — safe to call from `boot()` and
 *  from `ridgeSay` itself, so no call site has to remember mount order. */
export function mount(): void {
  if (mounted) return;
  mounted = true;

  rootEl = h("div", { class: "ridge", "data-ridge-phase": "hidden", "data-ridge-state": "idle" });

  figureEl = h("button", { class: "ridge-figure", "aria-hidden": "true", tabindex: "-1" });
  figureEl.innerHTML = RIDGE_SVG;
  figureEl.addEventListener("click", () => ridgeDismiss());

  bubbleTextEl = h("p", { class: "ridge-bubble__text", "aria-live": "polite", "aria-atomic": "true" }, [
    "",
  ]);
  const dismissBtn = h("button", { class: "ridge-bubble__dismiss", "aria-label": t("mascot.dismiss") }, [
    "×",
  ]);
  dismissBtn.addEventListener("click", () => ridgeDismiss());
  bubbleEl = h("div", { class: "ridge-bubble" }, [
    bubbleTextEl,
    dismissBtn,
    h("div", { class: "ridge-bubble__tail" }),
  ]);

  rootEl.append(figureEl, bubbleEl);
  document.body.append(rootEl);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ridgeDismiss();
  });
  // `focusout` fires before the next element takes focus, so the check runs on
  // the next tick — otherwise moving focus from one field straight to another
  // would read as "nothing is focused" for one event and fire early.
  document.addEventListener("focusout", () => {
    window.setTimeout(flushPending, 0);
  });
  // Clicking the control he's standing next to is still "engaging with the
  // thing Ridge is talking about", not walking away from him.
  document.addEventListener("pointerdown", (e) => {
    if (phase === "hidden") return;
    const target = e.target as Node;
    if (rootEl.contains(target)) return;
    const anchorEl = currentAnchor?.();
    if (anchorEl?.contains(target)) return;
    ridgeDismiss();
  });
  window.addEventListener("resize", () => {
    if (phase !== "hidden") position(currentAnchor);
  });
}

/** The one entry point every screen calls, once, at the end of its render, plus
 *  ad hoc reaction call sites (a password going weak, a breach hit). */
export function ridgeSay(line: RidgeLine): void {
  if (!mounted) mount();
  const kind = line.kind ?? "tour";
  if (kind === "tour" && isFieldActive()) {
    pendingLine = line;
    return;
  }
  present(line);
}

export function ridgeDismiss(): void {
  if (!mounted) return;
  pendingLine = null;
  beginPopOut("dismiss");
}

/** A screen change never has a line of its own to say yet — the incoming
 *  screen's own `ridgeSay` call (if any) runs synchronously right after this,
 *  in the same tick, so this is a hard reset rather than a graceful pop-out:
 *  a screen with no line of its own (the two provisioning guards) must not be
 *  left with the previous screen's bubble pointing at an anchor that no
 *  longer exists. */
export function ridgeOnScreenChange(): void {
  if (!mounted) return;
  cancelReveal();
  window.clearTimeout(lingerTimer);
  window.clearTimeout(capTimer);
  if (popOutEndHandler) {
    rootEl.removeEventListener("animationend", popOutEndHandler);
    popOutEndHandler = undefined;
  }
  if (popInEndHandler) {
    figureEl.removeEventListener("animationend", popInEndHandler);
    popInEndHandler = undefined;
  }
  pendingLine = null;
  currentKey = null;
  currentAnchor = undefined;
  phase = "hidden";
  rootEl.dataset.ridgePhase = "hidden";
  rootEl.classList.remove("ridge--hero");
  bubbleTextEl.textContent = "";
}

/** Lets a screen sequence a first-run intro before an always-on line (the
 *  welcome screen's rows 1 and 1b) without guessing at Ridge's internal state. */
export function hasSeenLine(key: string): boolean {
  return hasSeen(loadSeen(), key);
}
