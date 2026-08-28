/**
 * Memories: one corpus, two projections.
 *
 * Recent and Graph used to be sibling tabs, which asked the user to choose a
 * *place* when they were really choosing how to look at the same 1,800
 * memories — by time, or by connection. Folding them together is only an
 * improvement if the two views cannot both be on screen, cannot both be
 * fetched, and the controls that belong to one do not linger over the other.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const els = new Map<string, any>();
  const store = new Map<string, string>();
  const calls: string[] = [];
  const makeEl = () => ({
    hidden: false,
    innerHTML: "",
    textContent: "",
    attrs: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      toggle(c: string, on?: boolean) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c: string) { return this._s.has(c); },
    },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
  });
  const ctx: any = {
    console,
    calls,
    currentTab: "home",
    memoryView: "list",
    selectedTag: "",
    selectedTimeRange: "",
    allEntries: [],
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    loadGraph: () => calls.push("graph"),
    loadRecent: () => calls.push("list"),
    renderRecent: () => {},
    refreshIfStale: () => calls.push("refresh"),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/nav.js"), "utf8"), ctx);
  ctx.__els = els;
  ctx.__store = store;
  return ctx;
}

describe("switching projection", () => {
  it("shows one view at a time", () => {
    const ctx = load();

    ctx.setMemoryView("graph");
    expect(ctx.__els.get("recent-list").hidden).toBe(true);
    expect(ctx.__els.get("mem-graph").hidden).toBe(false);

    ctx.setMemoryView("list");
    expect(ctx.__els.get("recent-list").hidden).toBe(false);
    expect(ctx.__els.get("mem-graph").hidden).toBe(true);
  });

  it("takes the list's filters away with the list", () => {
    // The graph draws its own slice of the corpus and would silently ignore a
    // tag or a date range, so leaving those controls up would be a lie about
    // what is on screen. The legend takes their place.
    const ctx = load();
    ctx.setMemoryView("graph");
    expect(ctx.__els.get("mem-filters").hidden).toBe(true);
    expect(ctx.__els.get("mem-legend").hidden).toBe(false);

    ctx.setMemoryView("list");
    expect(ctx.__els.get("mem-filters").hidden).toBe(false);
    expect(ctx.__els.get("mem-legend").hidden).toBe(true);
  });

  it("marks the active view for a screen reader too, not only visually", () => {
    const ctx = load();
    ctx.setMemoryView("graph");
    expect(ctx.__els.get("mem-view-graph").attrs["aria-selected"]).toBe("true");
    expect(ctx.__els.get("mem-view-list").attrs["aria-selected"]).toBe("false");
    expect(ctx.__els.get("mem-view-graph").classList.contains("active")).toBe(true);
  });

  it("loads only the view being shown", () => {
    const ctx = load();
    ctx.calls.length = 0;
    ctx.setMemoryView("graph");
    expect(ctx.calls).toEqual(["graph"]);
  });

  it("fetches the list when arriving from the graph with nothing loaded", () => {
    // Someone whose stored projection is the graph never triggers a list load,
    // so switching across would land on an empty list that reads as an empty
    // brain.
    const ctx = load();
    ctx.setMemoryView("graph");
    ctx.calls.length = 0;
    ctx.setMemoryView("list");
    expect(ctx.calls).toEqual(["list"]);
  });

  it("treats anything that is not 'graph' as the list", () => {
    const ctx = load();
    ctx.setMemoryView("nonsense");
    expect(ctx.memoryView).toBe("list");
  });
});

describe("remembering the choice", () => {
  it("survives a restart", () => {
    // How someone thinks about their own brain is not a per-visit decision;
    // being dropped back into the other view every time is a small argument on
    // every visit.
    const ctx = load();
    ctx.setMemoryView("graph");
    expect(ctx.__store.get("sb_memory_view")).toBe("graph");

    const fresh = load();
    fresh.localStorage.getItem = () => "graph";
    fresh.initMemoryView();
    expect(fresh.memoryView).toBe("graph");
  });

  it("defaults to the list when nothing is stored", () => {
    const ctx = load();
    ctx.initMemoryView();
    expect(ctx.memoryView).toBe("list");
  });

  it("survives a browser that refuses localStorage", () => {
    // Private windows and the Tauri webview both throw on access rather than
    // returning null, and a settings read must not take the screen down.
    const ctx = load();
    ctx.localStorage.getItem = () => { throw new Error("denied"); };
    ctx.localStorage.setItem = () => { throw new Error("denied"); };
    expect(() => ctx.initMemoryView()).not.toThrow();
    expect(ctx.memoryView).toBe("list");
  });
});

describe("arriving at a tab", () => {
  it("fetches the projection that is actually showing", () => {
    const ctx = load();
    ctx.setMemoryView("graph");
    ctx.calls.length = 0;
    ctx.switchTab("memories");
    expect(ctx.calls).toEqual(["graph"]);

    ctx.setMemoryView("list");
    ctx.calls.length = 0;
    ctx.switchTab("memories");
    expect(ctx.calls).toEqual(["list"]);
  });

  it("re-reads home, where the numbers were fetched at startup", () => {
    const ctx = load();
    ctx.calls.length = 0;
    ctx.switchTab("home");
    expect(ctx.calls).toEqual(["refresh"]);
  });
});

/**
 * initMemoryView() runs from init() to restore the remembered projection before
 * the first paint — and that happens BEFORE init() reads WORKER_URL and
 * AUTH_TOKEN out of localStorage. So the load it triggers went out with an empty
 * bearer token on every single page load, took a 401, and left one in every
 * user's console; showApp() then re-issued the same request correctly, so the
 * screen looked fine and nothing ever surfaced it.
 */
describe("nothing is fetched before the page has credentials", () => {
  it("restores the projection without loading anything when there is no token", () => {
    const ctx = load();
    ctx.AUTH_TOKEN = "";
    ctx.__store.set("sb_memory_view", "list");

    ctx.initMemoryView();

    expect(ctx.calls).toEqual([]);
    // The restore itself still happened — that is what it is for.
    expect(ctx.memoryView).toBe("list");
    expect(ctx.__els.get("recent-list").hidden).toBe(false);
  });

  it("does not load the graph either", () => {
    const ctx = load();
    ctx.AUTH_TOKEN = "";
    ctx.__store.set("sb_memory_view", "graph");

    ctx.initMemoryView();

    expect(ctx.calls).toEqual([]);
    expect(ctx.memoryView).toBe("graph");
    expect(ctx.__els.get("mem-graph").hidden).toBe(false);
  });

  it("loads normally once a token is in hand", () => {
    // showApp() is what has credentials, and the toggle buttons run long after.
    const ctx = load();
    ctx.initMemoryView();
    expect(ctx.calls).toEqual(["list"]);

    ctx.calls.length = 0;
    ctx.setMemoryView("graph");
    expect(ctx.calls).toEqual(["graph"]);
  });
});
