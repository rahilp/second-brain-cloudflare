/**
 * The coach-mark primitive.
 *
 * An inline, dismissible callout rendered directly under the control it
 * explains — not an anchored popover, because test/ui runs public/ in a Node
 * vm against a hand-rolled fake DOM with no layout and no
 * getBoundingClientRect, and a positioned popover would be the one piece of
 * this work with no test that can fail before and pass after.
 *
 * The primitive owns three guarantees, and they are asserted here rather than
 * in its callers so every future caller inherits them: the TEAM_MODE gate, the
 * localStorage dismissal record, and the fact that a missing or unreadable
 * record fails OPEN (an onboarding tip that cannot be suppressed is a much
 * smaller problem than one that silently never appears).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** api.js is loaded for the TEAM_MODE binding the primitive reads. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/api.js",
  "public/js/coach.js",
]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

const KEY = "sb_coach_dismissed";

/** The two containers Tasks 10 and 11 add to index.html. */
const IDS = ["coach-home", "coach-memories"];

function makeEl(id: string) {
  return {
    id,
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {},
  };
}

type Opts = { seed?: string; getThrows?: boolean; setThrows?: boolean };

function setup(opts: Opts = {}) {
  const elements = new Map<string, any>();
  for (const id of IDS) elements.set(id, makeEl(id));

  const store = new Map<string, string>();
  if (opts.seed !== undefined) store.set(KEY, opts.seed);
  /** Every write, so a test can prove the solo branch wrote nothing at all. */
  const writes: Array<[string, string]> = [];
  const localStorage = {
    getItem(k: string) {
      // Only the coach key misbehaves: i18n.js reads sb-locale through the
      // same object and a blanket throw would be testing initI18n instead.
      if (opts.getThrows && k === KEY) throw new Error("localStorage read denied");
      return store.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      writes.push([k, v]);
      if (opts.setThrows && k === KEY) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
    removeItem(k: string) {
      store.delete(k);
    },
  };

  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      // null, not a fresh stub: "the container is absent" is a real branch.
      getElementById: (id?: string) => elements.get(id ?? "") ?? null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag: string) => makeEl(tag),
      addEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage,
    navigator: { language: "en-US" },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`TEAM_MODE = true`, ctx);
  ctx.initI18n("en");
  const coachWrites = () => writes.filter(([k]) => k === KEY);
  return { ctx, els: elements, store, writes, coachWrites };
}

const SHARED = { title: "Shared means the whole team", body: "A shared memory can be found by everyone." };
const LOCK = { title: "Only the author can change a shared memory", body: "Only the person who shared it can edit it." };

describe("coach-mark primitive", () => {
  it("renders a titled callout with a dismiss button that names both its id and its container", () => {
    const { ctx, els } = setup();
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    const el = els.get("coach-home");
    expect(el.hidden).toBe(false);
    expect(el.innerHTML).toContain(SHARED.title);
    expect(el.innerHTML).toContain(SHARED.body);
    expect(el.innerHTML).toContain("coach-mark-dismiss");
    expect(el.innerHTML).toContain("Got it");
    expect(el.innerHTML).toContain("Dismiss this tip");
    // Both arguments: the handler is a pure function of what rendered it, so
    // dismissal never has to scan the DOM for its own container — which in this
    // harness (querySelectorAll returns []) could not be tested at all.
    expect(el.innerHTML).toContain(`dismissCoachMark('shared', 'coach-home')`);
  });

  it("hides the mark, empties it, records the dismissal, and does not render it again", () => {
    const { ctx, els, store } = setup();
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    ctx.dismissCoachMark("shared", "coach-home");
    const el = els.get("coach-home");
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe("");
    expect(store.get(KEY)).toBe("shared");

    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe("");
  });

  it("keeps a different mark visible after the first is dismissed, and remembers both", () => {
    const { ctx, els, store } = setup();
    ctx.dismissCoachMark("shared", "coach-home");
    ctx.renderCoachMark("coach-memories", "author-lock", LOCK);
    expect(els.get("coach-memories").hidden).toBe(false);
    expect(els.get("coach-memories").innerHTML).toContain(LOCK.title);

    ctx.dismissCoachMark("author-lock", "coach-memories");
    const stored = String(store.get(KEY)).split(",");
    expect(stored).toContain("shared");
    expect(stored).toContain("author-lock");
  });

  it("hides on a falsy copy, which is how a caller says 'not yet' without a second code path", () => {
    const { ctx, els, coachWrites } = setup();
    ctx.renderCoachMark("coach-memories", "author-lock", null);
    expect(els.get("coach-memories").hidden).toBe(true);
    expect(els.get("coach-memories").innerHTML).toBe("");
    expect(coachWrites()).toEqual([]);
  });

  it("renders nothing and writes nothing on a solo brain, on every call", () => {
    const { ctx, els, coachWrites } = setup();
    vm.runInContext(`TEAM_MODE = false`, ctx);
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(els.get("coach-home").hidden).toBe(true);
    expect(els.get("coach-home").innerHTML).toBe("");
    expect(coachWrites(), "a solo brain must never write sb_coach_dismissed").toEqual([]);
  });

  it("re-hides a mark that was already on screen when the brain stops being a team", () => {
    // Both branches, every call — the same convention maybeRevealHomeLayer
    // follows, so a stale reveal is always correctable by a re-render.
    const { ctx, els } = setup();
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(els.get("coach-home").hidden).toBe(false);
    vm.runInContext(`TEAM_MODE = false`, ctx);
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(els.get("coach-home").hidden).toBe(true);
    expect(els.get("coach-home").innerHTML).toBe("");
  });

  it("fails open when the dismissal record cannot be read", () => {
    // Safari private mode and a locked-down profile both throw here. An
    // unreadable record must not silently suppress onboarding forever.
    const { ctx, els } = setup({ getThrows: true });
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(els.get("coach-home").hidden).toBe(false);
    expect(els.get("coach-home").innerHTML).toContain(SHARED.title);
  });

  it("still hides for this session when the dismissal cannot be persisted", () => {
    const { ctx, els } = setup({ setThrows: true });
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    ctx.dismissCoachMark("shared", "coach-home");
    expect(els.get("coach-home").hidden).toBe(true);
    expect(els.get("coach-home").innerHTML).toBe("");
  });

  it("honours a dismissal recorded in a previous session", () => {
    const { ctx, els } = setup({ seed: "author-lock,shared" });
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(els.get("coach-home").hidden).toBe(true);
    ctx.renderCoachMark("coach-memories", "auto", SHARED);
    expect(els.get("coach-memories").hidden).toBe(false);
  });

  it("is a no-op for a container that is not on the page", () => {
    const { ctx, coachWrites } = setup();
    expect(() => ctx.renderCoachMark("coach-nowhere", "shared", SHARED)).not.toThrow();
    expect(() => ctx.dismissCoachMark("shared", "coach-nowhere")).not.toThrow();
    // The dismissal is still recorded: the record is about the tip, not about
    // whichever container happened to be mounted when it was dismissed.
    expect(coachWrites().length).toBe(1);
  });

  it("translates the dismiss button into Italian", () => {
    const { ctx, els } = setup();
    ctx.initI18n("it");
    ctx.renderCoachMark("coach-home", "shared", SHARED);
    expect(els.get("coach-home").innerHTML).toContain("Ho capito");
    expect(els.get("coach-home").innerHTML).toContain("Chiudi questo suggerimento");
  });
});
