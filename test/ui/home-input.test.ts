/**
 * The unified input's one real decision: is this sentence a question or a
 * memory?
 *
 * Getting it wrong is asymmetric — a question stored as a memory is junk in the
 * brain permanently, a memory searched instead of stored costs a moment — so
 * the default on a tie is "remember", and the prediction is always shown before
 * it is acted on. These tests pin the classification and the override.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const els = new Map<string, any>();
  const makeEl = () => ({
    style: {} as Record<string, string>,
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      toggle(c: string, on?: boolean) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c: string) { return this._s.has(c); },
    },
    appendChild() {},
    focus() {},
  });
  const ctx: any = {
    console,
    autoResize() {},
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  ctx.localStorage = {
    _m: new Map<string, string>(),
    getItem(k: string) {
      return this._m.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      this._m.set(k, v);
    },
  };
  ctx.navigator = { language: "en-US" };
  ctx.document.documentElement = { lang: "en" };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/i18n.js"), "utf8"), ctx);
  ctx.initI18n("en");
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/home.js"), "utf8"), ctx);
  ctx.__els = els;
  return ctx;
}

describe("what the sentence is asking for", () => {
  const { detectHomeMode } = load();

  it("reads a question mark as a question", () => {
    expect(detectHomeMode("pricing floor?")).toBe("ask");
    expect(detectHomeMode("What did I decide about pricing?")).toBe("ask");
  });

  it("reads an interrogative opener as a question, mark or not", () => {
    for (const q of [
      "what am I working on",
      "when did I ship 2.2.3",
      "why did we drop hourly",
      "how does the importer page",
      "did I ever decide on the floor",
      "show me my tasks",
      "find the pricing note",
    ]) {
      expect(detectHomeMode(q), q).toBe("ask");
    }
    const ctx = load();
    ctx.initI18n("it");
    for (const q of ["cosa ho deciso sul prezzo", "quando ho spedito 2.2.3"]) {
      expect(ctx.detectHomeMode(q), q).toBe("ask");
    }
  });

  it("reads a statement as something to remember", () => {
    for (const m of [
      "pricing floor is $6k per project",
      "buy milk",
      "Vincenzo fixed the import batching",
      "the CLI ships as a single binary",
    ]) {
      expect(detectHomeMode(m), m).toBe("remember");
    }
  });

  it("honours an explicit instruction to remember", () => {
    expect(detectHomeMode("remember that the floor is $6k")).toBe("remember");
    expect(detectHomeMode("note: renewed the domain")).toBe("remember");
    expect(detectHomeMode("todo call the accountant")).toBe("remember");
  });

  it("falls to remember on a tie, because that is the recoverable mistake", () => {
    // No question mark, no interrogative — ambiguous, and an unwanted search
    // costs a moment while an unwanted memory costs a cleanup.
    expect(detectHomeMode("pricing floor six thousand")).toBe("remember");
  });

  it("does not treat Italian statement starters as questions", () => {
    const ctx = load();
    ctx.initI18n("it");
    for (const m of [
      "Devo chiamare Marco",
      "Ho finito il report",
      "Sono in riunione",
    ]) {
      expect(ctx.detectHomeMode(m), m).toBe("remember");
    }
    expect(ctx.detectHomeMode("Come stai")).toBe("ask");
  });

  it("has no opinion about an empty field", () => {
    expect(detectHomeMode("")).toBeNull();
    expect(detectHomeMode("   ")).toBeNull();
  });
});

describe("the visible prediction", () => {
  it("says what it is about to do, and hides itself when there is nothing to say", () => {
    const ctx = load();
    const field = ctx.document.getElementById("home-field");

    field.value = "what did I decide?";
    ctx.onHomeInput(field);
    expect(ctx.document.getElementById("home-mode-label").textContent).toBe("will search");
    expect(ctx.document.getElementById("home-mode").style.visibility).toBe("visible");

    field.value = "pricing floor is $6k";
    ctx.onHomeInput(field);
    expect(ctx.document.getElementById("home-mode-label").textContent).toBe("will remember");

    field.value = "";
    ctx.onHomeInput(field);
    expect(ctx.document.getElementById("home-mode").style.visibility).toBe("hidden");
  });

  it("stops predicting once the user has overridden it", () => {
    const ctx = load();
    const field = ctx.document.getElementById("home-field");

    field.value = "pricing floor is $6k";
    ctx.onHomeInput(field);
    expect(ctx.document.getElementById("home-mode-label").textContent).toBe("will remember");

    ctx.toggleHomeMode();
    expect(ctx.document.getElementById("home-mode-label").textContent).toBe("will search");

    // Typing must not silently undo a decision the user just made.
    field.value = "pricing floor is $6k per project";
    ctx.onHomeInput(field);
    expect(ctx.document.getElementById("home-mode-label").textContent).toBe("will search");
  });
});

describe("greeting", () => {
  const { greetingFor } = load();

  it("tracks the time of day", () => {
    const at = (h: number) => greetingFor(new Date(2026, 7, 8, h, 0, 0));
    expect(at(2)).toBe("Still up");
    expect(at(9)).toBe("Good morning");
    expect(at(14)).toBe("Good afternoon");
    expect(at(19)).toBe("Good evening");
    expect(at(23)).toBe("Late one");
  });
});

describe("leaving home, and coming back", () => {
  it("gives the conversation its input bar back", () => {
    const ctx = load();
    ctx.returnHome();
    expect(ctx.document.getElementById("screen-home").classList.contains("home-visible")).toBe(true);

    ctx.leaveHome();
    // The class hides the old input bar; leaving it on would strand the user in
    // a conversation with nothing to type into.
    expect(ctx.document.getElementById("screen-home").classList.contains("home-visible")).toBe(false);
    expect(ctx.document.getElementById("home").style.display).toBe("none");
    // The board is part of home, not the conversation; it must not float above it.
    expect(ctx.document.getElementById("board-tiles").style.display).toBe("none");
    expect(ctx.document.getElementById("board").style.display).toBe("none");
  });

  it("comes back making no claim about a sentence nobody has written", () => {
    // Returning from a question left "will search" under an empty box, with the
    // lock from any earlier override still on.
    const ctx = load();
    const field = ctx.document.getElementById("home-field");
    field.value = "what did I decide?";
    ctx.onHomeInput(field);
    ctx.toggleHomeMode();
    ctx.leaveHome();

    ctx.returnHome();
    expect(ctx.document.getElementById("home-mode").style.visibility).toBe("hidden");

    // And the override is gone, so typing predicts again.
    field.value = "what did I decide?";
    ctx.onHomeInput(field);
    expect(ctx.document.getElementById("home-mode-label").textContent).toBe("will search");
  });

  it("puts home back", () => {
    // A conversation is a state home enters, not a place you travel to. Asking
    // one question used to replace home for the rest of the session, and in a
    // desktop window with no reload that was the rest of the session.
    const ctx = load();
    ctx.renderHome(null);
    ctx.leaveHome();
    ctx.returnHome();
    expect(ctx.document.getElementById("screen-home").classList.contains("home-visible")).toBe(true);
    expect(ctx.document.getElementById("home").style.display).toBe("");
    expect(ctx.document.getElementById("board-tiles").style.display).toBe("");
    expect(ctx.document.getElementById("board").style.display).toBe("");
  });

  it("keeps rendering home data separate from showing home", () => {
    const ctx = load();
    ctx.renderHome(null);
    expect(ctx.document.getElementById("screen-home").classList.contains("home-visible")).toBe(false);
  });

  it("returns home from its tab when a conversation is on top", () => {
    const ctx = load();
    ctx.currentTab = "home";
    ctx.memoryView = "list";
    ctx.refreshIfStale = () => { ctx.refreshed = true; };
    ctx.document.querySelectorAll = () => [];
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/nav.js"), "utf8"), ctx);

    ctx.leaveHome();
    ctx.switchTab("home");
    expect(ctx.document.getElementById("home").style.display).not.toBe("none");
    expect(ctx.document.getElementById("board").style.display).not.toBe("none");
    expect(ctx.document.getElementById("screen-home").classList.contains("home-visible")).toBe(true);
    expect(ctx.refreshed).toBe(true);
  });
});
