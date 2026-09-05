// Ridge, the guided-experience mascot (plan.md §4). Mounted once outside
// `#app`, so `show()`'s `app.replaceChildren(...)` (main.ts) never touches it
// and a locale change or screen change never tears it down.
//
// Every screen calls `ridgeSay(...)` once, at the end of its render, the same
// way it assigns `currentScreen`. This module owns the rest: whether that line
// has already been said (the `ridge.seen.v1` localStorage set), whether it is
// safe to say right now (never interrupts a focused input — a password field
// mid-type is the one place this mascot must stay silent), and how it says it
// (a typed reveal that settles to idle, or instantly under reduced motion).
//
// Pure decision logic is exported separately from the DOM-touching functions
// below it, for the same reason `rotation-state.ts` and `connection-role.ts`
// are pure: `main.ts` resolves `#app` at module scope and cannot be imported
// outside a webview, so anything worth a test has to be reachable without one.
import { h } from "./shared";
import { t } from "./i18n";
import { RIDGE_SVG } from "./ridge-svg";

export type RidgeState =
  | "idle"
  | "talking"
  | "thinking"
  | "pointing"
  | "celebrating"
  | "concerned"
  | "waving";

export interface RidgeLine {
  /** Stable and never reused for a different sentence — the `ridge.seen.v1` key. */
  key: string;
  text: string;
  /** Defaults to "talking": a line is, by construction, Ridge saying something. */
  state?: RidgeState;
  /** Evaluated at render time, never cached — the element it points to may not
   *  exist yet when `ridgeSay` is called (e.g. before `show()` runs). */
  anchor?: () => HTMLElement | null;
  /** "once" = first time ever, tracked in localStorage. Omitted or "always" =
   *  every time this call site runs. */
  persist?: "once" | "always";
  /** Auto-dismiss after this many ms. Omitted = stays until the next line,
   *  Escape, or a click on Ridge or the dismiss button. */
  dismissMs?: number;
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

/** Whether an element with this tag name is a field Ridge must not interrupt. */
export function isFieldFocused(tagName: string | null | undefined): boolean {
  return tagName === "INPUT" || tagName === "TEXTAREA";
}

/**
 * Whether a line should be silently dropped rather than shown.
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

/**
 * Only "talking" settles to "idle" once its line is fully revealed — its mouth
 * and body-bounce keyframes are `infinite` (style.css) and would otherwise
 * animate forever after Ridge has finished speaking. Every other state
 * (concerned, celebrating, …) is a deliberate, sustained expression a screen
 * chose and holds until the next line or a dismissal.
 */
export function nextRidgeState(state: RidgeState, revealComplete: boolean): RidgeState {
  return state === "talking" && revealComplete ? "idle" : state;
}

// ── DOM-touching module state ────────────────────────────────────────────────

let mounted = false;
let dockEl: HTMLElement;
let bubbleEl: HTMLElement;
let bubbleTextEl: HTMLElement;
let spotlightEl: HTMLElement;

let pendingLine: RidgeLine | null = null;
let currentKey: string | null = null;
let currentAnchor: (() => HTMLElement | null) | undefined;
let dismissTimer: number | undefined;
let revealFrame: number | undefined;

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

function positionSpotlight(anchor: (() => HTMLElement | null) | undefined): void {
  const el = anchor?.();
  if (!el) {
    spotlightEl.hidden = true;
    return;
  }
  const rect = el.getBoundingClientRect();
  const pad = 4;
  spotlightEl.style.left = `${rect.left - pad}px`;
  spotlightEl.style.top = `${rect.top - pad}px`;
  spotlightEl.style.width = `${rect.width + pad * 2}px`;
  spotlightEl.style.height = `${rect.height + pad * 2}px`;
  spotlightEl.hidden = false;
}

function cancelReveal(): void {
  if (revealFrame !== undefined) {
    cancelAnimationFrame(revealFrame);
    revealFrame = undefined;
  }
}

function runTypedReveal(text: string, state: RidgeState): void {
  cancelReveal();
  bubbleTextEl.textContent = "";
  let shown = 0;
  const step = () => {
    shown = stepRevealCount(shown, text.length);
    bubbleTextEl.textContent = text.slice(0, shown);
    const complete = shown >= text.length;
    if (complete) {
      revealFrame = undefined;
      dockEl.dataset.ridgeState = nextRidgeState(state, true);
    } else {
      revealFrame = requestAnimationFrame(step);
    }
  };
  revealFrame = requestAnimationFrame(step);
}

function renderBubble(line: RidgeLine, instant: boolean): void {
  window.clearTimeout(dismissTimer);
  dismissTimer = undefined;

  const state: RidgeState = line.state ?? "talking";
  dockEl.dataset.ridgeState = state;
  dockEl.classList.toggle("ridge--hero", !!line.hero);

  currentAnchor = line.anchor;
  positionSpotlight(line.anchor);

  bubbleEl.hidden = false;

  if (instant || prefersReducedMotion()) {
    cancelReveal();
    bubbleTextEl.textContent = line.text;
    dockEl.dataset.ridgeState = nextRidgeState(state, true);
  } else {
    runTypedReveal(line.text, state);
  }

  if (line.dismissMs) {
    dismissTimer = window.setTimeout(() => ridgeDismiss(), line.dismissMs);
  }
}

function present(line: RidgeLine): void {
  const sameAsShown = currentKey === line.key;
  const seen = loadSeen();
  if (shouldSuppressLine({ sameAsShown, persist: line.persist, alreadySeen: hasSeen(seen, line.key) })) {
    ridgeDismiss();
    return;
  }
  if (!sameAsShown && line.persist === "once") {
    saveSeen(withSeen(seen, line.key));
  }
  currentKey = line.key;
  renderBubble(line, sameAsShown);
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

  dockEl = h("div", { class: "ridge", "data-ridge-state": "idle" });

  const avatarBtn = h("button", { class: "ridge-avatar-btn", "aria-hidden": "true", tabindex: "-1" });
  avatarBtn.innerHTML = RIDGE_SVG;
  avatarBtn.addEventListener("click", () => ridgeDismiss());

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
  bubbleEl.hidden = true;

  dockEl.append(avatarBtn, bubbleEl);
  spotlightEl = h("div", { class: "ridge-spotlight" });
  spotlightEl.hidden = true;

  document.body.append(dockEl, spotlightEl);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ridgeDismiss();
  });
  // `focusout` fires before the next element takes focus, so the check runs on
  // the next tick — otherwise moving focus from one field straight to another
  // would read as "nothing is focused" for one event and fire early.
  document.addEventListener("focusout", () => {
    window.setTimeout(flushPending, 0);
  });
  window.addEventListener("resize", () => positionSpotlight(currentAnchor));
}

/** The one entry point every screen calls, once, at the end of its render. */
export function ridgeSay(line: RidgeLine): void {
  if (!mounted) mount();
  if (isFieldActive()) {
    pendingLine = line;
    return;
  }
  present(line);
}

export function ridgeDismiss(): void {
  if (!mounted) return;
  cancelReveal();
  window.clearTimeout(dismissTimer);
  dismissTimer = undefined;
  bubbleEl.hidden = true;
  spotlightEl.hidden = true;
  dockEl.classList.remove("ridge--hero");
  dockEl.dataset.ridgeState = "idle";
  currentKey = null;
  currentAnchor = undefined;
}

/** An escape hatch to change pose without a new line — exported per plan §4.3;
 *  no v1 call site needs it, but a bubble already on screen may in v2. */
export function ridgeState(state: RidgeState): void {
  if (!mounted) return;
  dockEl.dataset.ridgeState = state;
}

/** Lets a screen sequence a first-run intro before an always-on line (the
 *  welcome screen's rows 1 and 1b) without guessing at Ridge's internal state. */
export function hasSeenLine(key: string): boolean {
  return hasSeen(loadSeen(), key);
}
