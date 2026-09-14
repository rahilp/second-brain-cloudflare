/**
 * The home board: tiles rendered from the brief the Worker already returns.
 * Each tile hides itself when its data is missing or the endpoint refuses.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const src = ["public/js/i18n.js", "public/utils.js", "public/js/state.js", "public/js/api.js", "public/js/board.js", "public/js/chart.js"]
  .map((f) => readFileSync(resolve(ROOT, f), "utf8"))
  .join("\n");

function fakeDoc() {
  const made: any[] = [];
  const el = (tag = "div") => {
    const cls = new Set<string>();
    const attrs: Record<string, string> = {};
    let html = "";
    const e: any = {
      tag,
      children: [] as any[],
      dataset: {},
      style: {},
      hidden: false,
      className: "",
      textContent: "",
      setAttribute(k: string, v: string) {
        attrs[k] = String(v);
      },
      getAttribute(k: string) {
        return k in attrs ? attrs[k] : null;
      },
      appendChild(c: any) {
        this.children.push(c);
        return c;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: {
        add(c: string) { cls.add(c); },
        remove(c: string) { cls.delete(c); },
        toggle(c: string, on?: boolean) { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); },
        contains(c: string) { return cls.has(c); },
      },
      addEventListener() {},
    };
    // Real DOM: setting innerHTML (to anything, including '') discards
    // whatever children appendChild had put there. Board panels rely on this
    // to clear board-tiles/board between renders, so the mock has to match,
    // otherwise a second render's appended tiles pile up next to the first's.
    Object.defineProperty(e, "innerHTML", {
      get() { return html; },
      set(v: string) { html = v; e.children.length = 0; },
      enumerable: true,
    });
    made.push(e);
    return e;
  };
  const ids: Record<string, any> = { "board-tiles": el("section"), board: el() };
  return {
    made,
    ids,
    document: {
      getElementById: (id: string) => ids[id] ?? null,
      createElement: el,
      createElementNS: (_ns: string, tag: string) => el(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { lang: "en" },
    },
  };
}

describe("board tiles", () => {
  it("renders memories and week tiles from the brief and hides tiles without data", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 1204,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i < 7 ? 0 : 5 })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    const tiles = ids["board-tiles"].children;
    expect(ids["board-tiles"].hidden).toBe(false);
    // connections and recalls hidden: their endpoints 404 in this fixture; contradictions has no endpoint at all
    expect(tiles.map((t: any) => t.dataset.tile)).toEqual(["memories"]);
    expect(tiles[0].innerHTML).toMatch(/1,204/);
    expect(tiles[0].innerHTML).toMatch(/35/); // last 7 days summed like home.js does
  });
});

describe("render token", () => {
  // Regression: loadBrief's first-load path used to call renderBoard twice
  // (once directly, once via returnHome), and the two un-awaited runs raced:
  // every panel and three tiles rendered twice. Simulated here by calling
  // renderBoard twice without awaiting either, and letting the OLDER call's
  // /stats/graph fetch resolve only after the NEWER call has already finished.
  it("an older renderBoard call that resolves late appends nothing once a newer call has started", async () => {
    const { ids, document } = fakeDoc();
    const deferred: Record<number, () => void> = {};
    let graphFetches = 0;
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => {
        if (url.includes("/stats/graph")) {
          graphFetches += 1;
          const which = graphFetches;
          await new Promise<void>((resolve) => { deferred[which] = resolve; });
          return { ok: true, json: async () => ({ ok: true, edgeTypes: { relates_to: 2 } }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const brief = { ok: true, total: 4, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } };

    const older = ctx.renderBoard(brief);
    const newer = ctx.renderBoard(brief);
    // The newer call's fetch resolves first; the older call's resolves after:
    // the exact "finishes late" ordering the live bug hit on every reload.
    deferred[2]();
    await newer;
    deferred[1]();
    await older;

    const tiles = ids["board-tiles"].children;
    expect(tiles.filter((tl: any) => tl.dataset.tile === "memories")).toHaveLength(1);
    expect(tiles.filter((tl: any) => tl.dataset.tile === "connections")).toHaveLength(1);
    // The older call was still mid-flight when the newer one cleared and
    // re-owned `board`; it must not have appended any panels into it either.
    expect(ids.board.children.length).toBeGreaterThan(0);
  });
});

describe("actionable board", () => {
  it("routes tiles and board rows through their named actions", async () => {
    const { ids, document } = fakeDoc();
    const calls: any[] = [];
    const entry = { id: "recall-1", content: "A recalled memory", source: "cli", recall_count: 2 };
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => {
        if (url.includes("/stats/graph")) return { ok: true, json: async () => ({ ok: true, edgeTypes: { relates_to: 2 } }) };
        if (url.includes("/stats/recalled")) return { ok: true, json: async () => ({ ok: true, total_recalls: 2, total_contradictions: 1, entries: [entry] }) };
        if (url.includes("/stats/night")) return { ok: true, json: async () => ({ ok: true, ranAt: Date.now(), linksInferred: 1, insightsProposed: 1, digestsWritten: 0, claimsFlagged: 1 }) };
        return { ok: false, status: 404, json: async () => ({}) };
      },
      switchTab: (tab: string) => calls.push(["switchTab", tab]),
      setMemoryView: (view: string) => calls.push(["setMemoryView", view]),
      onTagChange: (tag: string) => calls.push(["onTagChange", tag]),
      openView: (memory: any) => calls.push(["openView", memory]),
      openPatternsSheet: () => calls.push(["openPatternsSheet"]),
      openStaleSheet: () => calls.push(["openStaleSheet"]),
      lockHomeMode: (mode: string) => calls.push(["lockHomeMode", mode]),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 4, activity: [], sources: [], topics: [{ tag: "travel", count: 2 }], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });

    const tiles = ids["board-tiles"].children;
    expect(tiles.every((tile: any) => tile.tag === "button")).toBe(true);
    expect(tiles.find((tile: any) => tile.dataset.tile === "memories").getAttribute("aria-label")).toBe("Open memories");
    tiles.find((tile: any) => tile.dataset.tile === "connections").onclick();
    tiles.find((tile: any) => tile.dataset.tile === "contradictions").onclick();

    const recalled = ids.board.children.find((panel: any) => panel.dataset.panel === "recalled");
    recalled.body.children[0].children[0].onclick();
    const night = ids.board.children.find((panel: any) => panel.dataset.panel === "night");
    night.body.children[0].children[1].onclick();
    const topics = ids.board.children.find((panel: any) => panel.dataset.panel === "topics");
    topics.body.children[0].children[0].onclick();

    expect(calls).toContainEqual(["setMemoryView", "graph"]);
    expect(calls).toContainEqual(["onTagChange", "contradiction-resolved"]);
    expect(calls).toContainEqual(["onTagChange", "travel"]);
    expect(calls).toContainEqual(["openPatternsSheet"]);
    expect(calls).toContainEqual(["openView", { id: "recall-1", content: "A recalled memory", tags: [] }]);
  });
});

describe("decisions panel", () => {
  it("renders up to two insights as stops on the thread, with a more-button past two", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: [],
      sources: [],
      topics: [],
      patterns: [
        { id: "p1", content: "x".repeat(50) },
        { id: "p2", content: "y".repeat(50) },
        { id: "p3", content: "z".repeat(50) },
      ],
      attention: { unindexed: 0, stale: 0, patterns: 3 },
    });
    const decide = ids.board.children.find((c: any) => c.dataset.panel === "decide");
    expect(decide, "decide panel should render").toBeTruthy();
    const html = decide.body.innerHTML as string;
    expect((html.match(/data-insight/g) || []).length).toBe(2);
    expect(html).toMatch(/brief-more/);
  });

  it("appends nothing when there are no insights and nothing needs attention", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "decide")).toBeUndefined();
  });
});

describe("decisions thread refit", () => {
  // fakeDoc()'s el() has a stub querySelector (always null), fine for
  // asserting panel presence, but refitThread needs a DOM that actually
  // traverses appended children, the same shape chart.test.ts's harness uses.
  function makeNode(tag = "div") {
    const node: any = {
      tag,
      className: "",
      offsetTop: 0,
      style: {} as Record<string, string>,
      children: [] as any[],
      classList: { add() {}, remove() {}, contains: () => false },
      appendChild(c: any) {
        node.children.push(c);
        return c;
      },
      querySelector(sel: string): any {
        return queryOne(node, sel);
      },
      querySelectorAll(sel: string): any[] {
        const out: any[] = [];
        collectAll(node, sel, out);
        return out;
      },
    };
    return node;
  }
  function matches(node: any, sel: string): boolean {
    return sel.startsWith(".") ? (node.className || "").split(/\s+/).includes(sel.slice(1)) : false;
  }
  function queryOne(root: any, sel: string): any {
    for (const c of root.children) {
      if (matches(c, sel)) return c;
      const found = queryOne(c, sel);
      if (found) return found;
    }
    return null;
  }
  function collectAll(root: any, sel: string, out: any[]) {
    for (const c of root.children) {
      if (matches(c, sel)) out.push(c);
      collectAll(c, sel, out);
    }
  }

  it("spans exactly the first dot to the last stop's dot, and updates when a stop settles and shrinks the layout", () => {
    const ctx: any = { console };
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/board.js"), "utf8"), ctx);

    const body = makeNode();
    const thread = makeNode();
    thread.className = "thread";
    body.appendChild(thread);
    const stop1 = makeNode();
    stop1.className = "stop";
    stop1.offsetTop = 0;
    const stop2 = makeNode();
    stop2.className = "stop";
    stop2.offsetTop = 100;
    const stop3 = makeNode();
    stop3.className = "stop";
    stop3.offsetTop = 200;
    body.appendChild(stop1);
    body.appendChild(stop2);
    body.appendChild(stop3);

    ctx.refitThread(body);
    expect(thread.style.top).toBe(`${stop1.offsetTop + 9}px`);
    expect(thread.style.height).toBe(`${stop3.offsetTop + 25 - (stop1.offsetTop + 9)}px`);

    // Confirm/Dismiss settling a stop hides its body and actions, shrinking
    // it, modeled here as the last stop moving up, the real effect of the
    // stop above it (or itself) getting shorter. A thread still sized for
    // the old, taller layout would run past this new last dot.
    stop3.offsetTop = 120;
    ctx.refitThread(body);
    expect(thread.style.top).toBe(`${stop1.offsetTop + 9}px`);
    expect(thread.style.height).toBe(`${stop3.offsetTop + 25 - (stop1.offsetTop + 9)}px`);
  });
});

describe("growth panel", () => {
  it("renders from brief.activity when there is data, and hides otherwise", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "growth")).toBeTruthy();

    const { ids: ids2, document: document2 } = fakeDoc();
    const ctx2: any = { ...ctx, document: document2 };
    vm.createContext(ctx2);
    vm.runInContext(src, ctx2);
    await ctx2.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids2.board.children.find((c: any) => c.dataset.panel === "growth")).toBeUndefined();
  });

  it("against an older Worker (no /stats/activity), shows the 14-day fallback with no range control or table toggle, and a note instead", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      // /stats/activity 404s; only /brief's 14-day activity is available.
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    const growth = ids.board.children.find((c: any) => c.dataset.panel === "growth");
    expect(growth, "growth panel should still render from the 14-day fallback").toBeTruthy();
    expect(growth.head.children.find((c: any) => c.className === "seg"), "no range control against an older Worker").toBeUndefined();
    expect(growth.body.children.some((c: any) => c.className && c.className.includes("btn-secondary")), "no table toggle either").toBe(false);
    const note = growth.body.children.find((c: any) => c.className === "chart-note");
    expect(note, "a note explains why both controls are absent").toBeTruthy();
    expect(note.textContent.length).toBeGreaterThan(0);
  });

  it("attaches the panel to the board before measuring the chart container", async () => {
    // renderActivityChart reads chartEl.clientWidth/clientHeight to size the
    // SVG viewBox. A detached element (or one whose ancestor chain is not in
    // the document yet) reports both as 0, which silently falls back to a
    // hardcoded box that then letterboxes inside the real container, this
    // regressed once already by drawing the chart before appending the panel.
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    let attachedWhenDrawn: boolean | null = null;
    ctx.renderActivityChart = () => {
      attachedWhenDrawn = ids.board.children.some((c: any) => c.dataset && c.dataset.panel === "growth");
    };
    await ctx.renderBoard({
      ok: true,
      total: 10,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: i })),
      sources: [],
      topics: [],
      patterns: [],
      attention: { unindexed: 0, stale: 0, patterns: 0 },
    });
    expect(attachedWhenDrawn).toBe(true);
  });

  it("upgrades to /stats/activity by source, with a live enabled range control", async () => {
    const { ids, document } = fakeDoc();
    const days = 90;
    const start = 19000;
    const series = [
      { source: "claude-code", counts: Array.from({ length: days }, () => 3) },
      { source: "obsidian", counts: Array.from({ length: days }, () => 2) },
      { source: "chatgpt", counts: Array.from({ length: days }, () => 1) },
      { source: "email", counts: Array.from({ length: days }, () => 1) },
      { source: "notion", counts: Array.from({ length: days }, () => 1) },
    ];
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) =>
        url.includes("/stats/activity")
          ? { ok: true, json: async () => ({ ok: true, days, start, series }) }
          : { ok: false, status: 404, json: async () => ({}) },
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    const growth = ids.board.children.find((c: any) => c.dataset.panel === "growth");
    expect(growth, "growth panel should render from /stats/activity").toBeTruthy();
    const rangeButtons = growth.head.children.find((c: any) => c.className === "seg").children;
    expect(rangeButtons.every((b: any) => b.disabled === false)).toBe(true);
    expect(rangeButtons.find((b: any) => b.dataset.range === "90").tabIndex).toBe(0);
    expect(rangeButtons.find((b: any) => b.dataset.range === "30").tabIndex).toBe(-1);
  });
});

describe("recalled panel", () => {
  function fetchFor(entries: any[], total: number) {
    return async (url: string) =>
      url.includes("/stats/recalled")
        ? { ok: true, json: async () => ({ ok: true, total_recalls: total, entries }) }
        : { ok: false, status: 404, json: async () => ({}) };
  }

  it("renders rows from /stats/recalled and fills the recalls tile from total_recalls", async () => {
    const { ids, document } = fakeDoc();
    const entries = [
      { id: "a", content: "x".repeat(40), source: "claude-code", created_at: Date.now(), recall_count: 23 },
      { id: "b", content: "y".repeat(40), source: "obsidian", created_at: Date.now(), recall_count: 12 },
    ];
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: fetchFor(entries, 2318),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "recalled");
    expect(panel, "recalled panel should render").toBeTruthy();
    expect(panel.body.children[0].children).toHaveLength(2);
    const recallsTile = ids["board-tiles"].children.find((t: any) => t.dataset.tile === "recalls");
    expect(recallsTile, "recalls tile should fill from total_recalls").toBeTruthy();
    expect(recallsTile.innerHTML).toMatch(/2,318/);
    // No total_contradictions in this fixture (an older Worker's shape): the
    // fourth tile stays out rather than showing a false zero.
    expect(ids["board-tiles"].children.map((t: any) => t.dataset.tile)).toEqual(["memories", "recalls"]);
  });

  it("adds a fourth contradictions tile from the same /stats/recalled response when total_contradictions is present", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) =>
        url.includes("/stats/recalled")
          ? { ok: true, json: async () => ({ ok: true, total_recalls: 2318, total_contradictions: 12, entries: [] }) }
          : { ok: false, status: 404, json: async () => ({}) },
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids["board-tiles"].children.map((t: any) => t.dataset.tile)).toEqual(["memories", "recalls", "contradictions"]);
    const tile = ids["board-tiles"].children.find((t: any) => t.dataset.tile === "contradictions");
    expect(tile.innerHTML).toMatch(/12/);
  });

  it("hides the panel and omits the tile when the endpoint has no entries", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "recalled")).toBeUndefined();
    expect(ids["board-tiles"].children.find((t: any) => t.dataset.tile === "recalls")).toBeUndefined();
  });
});

describe("night panel", () => {
  function fetchFor(payload: any) {
    return async (url: string) => (url.includes("/stats/night") ? { ok: true, json: async () => payload } : { ok: false, status: 404, json: async () => ({}) });
  }
  const brief = { ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } };

  it("renders four rows when insights were proposed", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: fetchFor({ ok: true, ranAt: Date.now(), linksInferred: 41, insightsProposed: 2, digestsWritten: 1, claimsFlagged: 3 }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "night");
    expect(panel, "night panel should render").toBeTruthy();
    expect(panel.body.children[0].children).toHaveLength(4);
  });

  it("hides the insights row at zero and hides the whole panel when ranAt is null", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: fetchFor({ ok: true, ranAt: Date.now(), linksInferred: 5, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0 }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "night");
    expect(panel.body.children[0].children).toHaveLength(3);

    const { ids: ids2, document: document2 } = fakeDoc();
    const ctx2: any = { ...ctx, document: document2, fetch: fetchFor({ ok: true, ranAt: null }) };
    vm.createContext(ctx2);
    vm.runInContext(src, ctx2);
    await ctx2.renderBoard(brief);
    expect(ids2.board.children.find((c: any) => c.dataset.panel === "night")).toBeUndefined();
  });
});

describe("links panel", () => {
  const brief = { ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } };

  it("renders bars for the top 3 edge types and a two-column list for the rest", async () => {
    const { ids, document } = fakeDoc();
    const edgeTypes = { relates_to: 2140, follows: 812, supersedes: 96, decided: 74, about_person: 60, part_of_project: 48, caused_by: 30 };
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/stats/graph") ? { ok: true, json: async () => ({ ok: true, edgeTypes }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "links");
    expect(panel, "links panel should render").toBeTruthy();
    expect((panel.body.innerHTML.match(/class="bar"/g) || []).length).toBe(3);
    expect((panel.body.innerHTML.match(/link-chip"/g) || []).length).toBe(4);
    const connectionsTile = ids["board-tiles"].children.find((t: any) => t.dataset.tile === "connections");
    expect(connectionsTile, "the connections tile should reuse the same /stats/graph fetch").toBeTruthy();
  });

  it("hides when /stats/graph has no edgeTypes", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard(brief);
    expect(ids.board.children.find((c: any) => c.dataset.panel === "links")).toBeUndefined();
  });
});

describe("graph preview panel", () => {
  function nodesAndEdges(n: number) {
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, tags: [i % 2 ? "alpha" : "beta"], importance: i % 5 }));
    const edges = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id, weight: 1 }));
    return { nodes, edges };
  }

  it("hides when the graph has fewer than 5 nodes", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/graph") ? { ok: true, json: async () => ({ ok: true, ...nodesAndEdges(3) }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ids.board.children.find((c: any) => c.dataset.panel === "graph")).toBeUndefined();
  });

  it("renders a panel when the graph has at least 5 nodes", async () => {
    const { ids, document } = fakeDoc();
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/graph") ? { ok: true, json: async () => ({ ok: true, ...nodesAndEdges(8) }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });
    const panel = ids.board.children.find((c: any) => c.dataset.panel === "graph");
    expect(panel).toBeTruthy();
    // The chip-row fallback for the in-SVG cluster labels, which CSS hides
    // below 700px where there is no room to set them without overlap.
    const clusterLegend = panel.body.children.find((c: any) => c.className === "graph-cluster-legend num");
    expect(clusterLegend, "graph-cluster-legend should be present").toBeTruthy();
    expect(clusterLegend.children.length).toBeGreaterThan(0);
    for (const chip of clusterLegend.children) {
      expect(chip.tag).toBe("button");
      expect(chip.getAttribute("aria-pressed")).toBe("false");
      expect(chip.textContent.length).toBeGreaterThan(0);
    }
  });

  it("clicking a cluster label highlights that cluster, toggles off on a second click, and announces the change", async () => {
    const { ids, document } = fakeDoc();
    // Two 3-node clusters plus one same-cluster edge each and one edge crossing
    // them, so the dim rule ("touching the active cluster") has a case on
    // every side: an active same-cluster edge, a dimmed same-cluster edge and
    // an active cross-cluster edge.
    const nodes = [
      { id: "a0", tags: ["travel"], importance: 1 },
      { id: "a1", tags: ["travel"], importance: 1 },
      { id: "a2", tags: ["travel"], importance: 1 },
      { id: "b0", tags: ["money"], importance: 1 },
      { id: "b1", tags: ["money"], importance: 1 },
      { id: "b2", tags: ["money"], importance: 1 },
    ];
    const edges = [
      { source: "a0", target: "a1", weight: 1 },
      { source: "b0", target: "b1", weight: 1 },
      { source: "a2", target: "b2", weight: 1 },
    ];
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => (url.includes("/graph") ? { ok: true, json: async () => ({ ok: true, nodes, edges }) } : { ok: false, status: 404, json: async () => ({}) }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({ ok: true, total: 10, activity: [], sources: [], topics: [], patterns: [], attention: { unindexed: 0, stale: 0, patterns: 0 } });

    const panel = ids.board.children.find((c: any) => c.dataset.panel === "graph");
    const wrap = panel.body.children.find((c: any) => c.className === "graph");
    const svg = wrap.children[0];
    const live = panel.body.children.find((c: any) => c.className === "vh");
    expect(live.getAttribute("aria-live")).toBe("polite");

    const byClass = (cls: string) => svg.children.filter((c: any) => c.classList.contains(cls));
    const nodeEls = byClass("graph-node");
    const ringEls = byClass("graph-ring");
    const labelEls = byClass("graph-label");
    const edgeEls = byClass("graph-edge");
    const travelLabel = labelEls.find((l: any) => l.dataset.cluster === "travel");
    const moneyLabel = labelEls.find((l: any) => l.dataset.cluster === "money");
    const travelRing = ringEls.find((r: any) => r.dataset.cluster === "travel");
    const moneyRing = ringEls.find((r: any) => r.dataset.cluster === "money");
    const aaEdge = edgeEls.find((e: any) => e.dataset.cluster === "travel");
    const bbEdge = edgeEls.find((e: any) => e.dataset.cluster === "money");
    const crossEdge = edgeEls.find((e: any) => e.dataset.a || e.dataset.b);
    expect(crossEdge.dataset.a).toBe("travel");
    expect(crossEdge.dataset.b).toBe("money");

    // Invoke the label's click handler directly, the same function the
    // mobile chip's onclick shares.
    travelLabel.onclick();

    for (const n of nodeEls) {
      const active = n.dataset.cluster === "travel";
      expect(n.classList.contains("is-active")).toBe(active);
      expect(n.classList.contains("is-dimmed")).toBe(!active);
    }
    expect(travelRing.classList.contains("is-active")).toBe(true);
    expect(moneyRing.classList.contains("is-dimmed")).toBe(true);
    expect(travelLabel.classList.contains("is-active")).toBe(true);
    expect(travelLabel.getAttribute("aria-pressed")).toBe("true");
    expect(moneyLabel.classList.contains("is-active")).toBe(false);
    expect(moneyLabel.getAttribute("aria-pressed")).toBe("false");
    expect(aaEdge.classList.contains("is-dimmed")).toBe(false); // same-cluster, active
    expect(bbEdge.classList.contains("is-dimmed")).toBe(true); // same-cluster, other
    expect(crossEdge.classList.contains("is-dimmed")).toBe(false); // touches active
    expect(live.textContent).toBe("Showing travel · 3 memories");

    const clusterLegend = panel.body.children.find((c: any) => c.className === "graph-cluster-legend num");
    const travelChip = clusterLegend.children.find((c: any) => c.dataset.cluster === "travel");
    expect(travelChip.classList.contains("is-active")).toBe(true);
    expect(travelChip.getAttribute("aria-pressed")).toBe("true");

    // Clicking the active label again clears every highlight.
    travelLabel.onclick();
    for (const n of [...nodeEls, ...ringEls, ...labelEls, ...edgeEls]) {
      expect(n.classList.contains("is-active")).toBe(false);
      expect(n.classList.contains("is-dimmed")).toBe(false);
    }
    expect(travelLabel.getAttribute("aria-pressed")).toBe("false");
    expect(live.textContent).toBe("Showing all topics");

    // The mobile chip drives the same shared handler.
    travelChip.onclick();
    expect(travelLabel.classList.contains("is-active")).toBe(true);
    expect(live.textContent).toBe("Showing travel · 3 memories");
  });
});

describe("panel registration order", () => {
  it("renders every panel in the final reading order when every endpoint answers", async () => {
    const { ids, document } = fakeDoc();
    function nodesAndEdges(n: number) {
      const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, tags: [i % 2 ? "alpha" : "beta"], importance: i % 5 }));
      const edges = nodes.slice(1).map((node, i) => ({ source: nodes[i].id, target: node.id, weight: 1 }));
      return { nodes, edges };
    }
    const responses: Record<string, any> = {
      "/stats/graph": { ok: true, edgeTypes: { relates_to: 10, follows: 5 } },
      "/stats/recalled": { ok: true, total_recalls: 40, entries: [{ id: "a", content: "x".repeat(30), source: "claude-code", created_at: Date.now(), recall_count: 4 }] },
      "/stats/night": { ok: true, ranAt: Date.now(), linksInferred: 3, insightsProposed: 1, digestsWritten: 1, claimsFlagged: 1 },
      "/graph?limit=120": { ok: true, ...nodesAndEdges(8) },
      "/stats": { ok: true, digest_candidates: [{ tag: "second-brain", count: 12 }], unvectorized: 0, unclassified: 0 },
      "/integrations": { ok: true, integrations: [{ provider: "gmail", name: "Gmail", connected: true, lastSyncedAt: Date.now() }] },
      "/prompt-capsules/core": { ok: true, populated: true, sections: [{ slot: "identity", source_entry_id: "a" }], omitted_slots: [] },
    };
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url: string) => {
        const hit = Object.keys(responses).find((path) => url.includes(path));
        return hit ? { ok: true, json: async () => responses[hit] } : { ok: false, status: 404, json: async () => ({}) };
      },
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderBoard({
      ok: true,
      total: 1204,
      activity: Array.from({ length: 14 }, (_, i) => ({ day: i, count: 5 })),
      sources: [],
      topics: [{ tag: "second-brain", count: 40 }],
      patterns: [{ id: "p1", content: "x".repeat(40) }],
      resurface: { id: "r1", content: "y".repeat(60), source: "claude-code", created_at: Date.now(), tags: [] },
      attention: { unindexed: 1, stale: 1, patterns: 1 },
    });
    expect(ids.board.children.map((c: any) => c.dataset.panel)).toEqual([
      "growth",
      "decide",
      "graph",
      "recalled",
      "night",
      "upkeep",
      "sources",
      "capsule",
      "reread",
      "links",
      "topics",
    ]);
    expect(ids["board-tiles"].children.map((c: any) => c.dataset.tile)).toEqual(["memories", "connections", "recalls"]);
  });
});

describe("rail note", () => {
  it("renders from the /health body even when the top-level ok flag is false", async () => {
    const { ids, document } = fakeDoc();
    ids["sb-version-note"] = document.createElement("p");
    ids["topbar-status"] = document.createElement("span");
    const ctx: any = {
      document,
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, version: "3.1.0", vectorize: { ok: false }, team: false }),
      }),
      console,
      Intl,
      WORKER_URL: "http://x",
      AUTH_TOKEN: "t",
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    await ctx.renderRailNote();
    expect(ids["sb-version-note"].innerHTML).toContain("3.1.0");
    expect(ids["sb-version-note"].innerHTML).toContain("Index needs attention");
    expect(ids["sb-version-note"].innerHTML).toContain("x");
  });
});
