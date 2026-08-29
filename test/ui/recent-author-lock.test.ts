/**
 * The author lock, on the list card.
 *
 * GET /list has reported `can_edit` per row since Phase 2, and for a release
 * nothing read it: the card offered Append, Edit and Forget to everyone while
 * printing "Shared · Bob" right above them, so a member's only way to learn
 * the memory was not theirs was to type an edit and be refused. The detail
 * sheet already knew; this asserts the card knows the same thing, from the
 * same helper, with the same words.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/toast.js",
  "public/js/confirm-sheet.js",
  "public/js/recent.js",
  "public/js/memory-crud.js",
];

/**
 * A fake node whose `querySelector` hands back one stable stub per selector,
 * so a test can read the very element the module reached for. Returning a
 * fresh element each call — as the older fakes do — would let a write to
 * `.edit-btn` vanish, which is precisely the write under test here.
 */
function makeEl(tag = "div") {
  const classes = new Set<string>();
  const children = new Map<string, any>();
  const el: any = {
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      toggle: (c: string, on?: boolean) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    checked: false,
    hidden: false,
    title: "",
    onclick: null,
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      el.attrs[k] = v;
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    hasAttribute: (k: string) => k in el.attrs,
    addEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    scrollIntoView() {},
    closest: () => null,
    querySelector(sel: string) {
      if (!children.has(sel)) children.set(sel, makeEl("button"));
      return children.get(sel);
    },
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
    __children: children,
  };
  return el;
}

function setup() {
  const byId = new Map<string, any>();
  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, makeEl());
        return byId.get(id);
      },
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      createElement: (tag: string) => makeEl(tag),
      addEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: "en-US" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    setTimeout,
    clearTimeout,
    refreshAll: () => {},
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of SRC) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
  ctx.initI18n("en");
  return ctx;
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  content: "Renewal date is 3 March\nand the contact is Bob",
  tags: [],
  source: "claude",
  created_at: Date.now() - 60_000,
  vector_ids: "[]",
  workspace: "company",
  actor_name: "Bob",
  ...over,
});

/** The three controls whose routes gate on the predicate `can_edit` reports. */
const AUTHORED = [".append-btn", ".edit-btn", ".forget-btn"];

describe("author lock on the list card", () => {
  it("disables Append, Edit and Forget on a colleague's shared card and says why", () => {
    const ctx = setup();
    const card = ctx.makeRecentCard(entry({ can_edit: false }));
    for (const sel of AUTHORED) {
      const btn = card.querySelector(sel);
      expect(btn.disabled, `${sel} should be disabled`).toBe(true);
      expect(btn.getAttribute("aria-disabled"), `${sel} aria-disabled`).toBe("true");
      expect(btn.classList.contains("card-action-btn--locked"), `${sel} dimming`).toBe(true);
      // The same sentence the detail sheet uses, from the same catalog key.
      expect(btn.title).toBe("Only the author can change a shared memory");
    }
  });

  it("leaves the same three alone on a card the caller may edit", () => {
    const ctx = setup();
    const card = ctx.makeRecentCard(entry({ can_edit: true }));
    for (const sel of AUTHORED) {
      const btn = card.querySelector(sel);
      expect(btn.disabled, `${sel} should be usable`).toBe(false);
      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.classList.contains("card-action-btn--locked")).toBe(false);
      expect(btn.title).toBe("");
    }
  });

  it("treats an absent can_edit as not locked, so a solo brain and an older Worker are untouched", () => {
    const ctx = setup();
    // No can_edit at all: a Worker from before the field existed, and every
    // row on a personal install. Refusing here would break both.
    const card = ctx.makeRecentCard(entry({ workspace: "personal", actor_name: null }));
    for (const sel of AUTHORED) {
      const btn = card.querySelector(sel);
      expect(btn.disabled, `${sel} must stay usable without the flag`).toBe(false);
      expect(btn.classList.contains("card-action-btn--locked")).toBe(false);
    }
  });

  it("reads can_edit through the same helper the detail sheet does", () => {
    const ctx = setup();
    // Detail sheet and card, one predicate: applyAuthorLock and
    // applyCardAuthorLock both go through lockAuthoredControls, so a change to
    // who may edit cannot land on one surface and not the other.
    expect(typeof ctx.lockAuthoredControls).toBe("function");
    const card = ctx.makeRecentCard(entry({ can_edit: false }));
    ctx.applyAuthorLock({ can_edit: false });
    const viewEdit = ctx.document.getElementById("view-btn-edit");
    expect(viewEdit.disabled).toBe(true);
    expect(viewEdit.title).toBe(card.querySelector(".edit-btn").title);
  });
});
