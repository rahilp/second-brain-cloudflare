/**
 * Memories multi-select: the selection model and its bar.
 *
 * Selection is a MODE. A checkbox on every card in a team brain permanently
 * reframes a reading surface as an editing surface, and the memories list is
 * the screen people read — so `Select` turns it on, `Done` turns it off and
 * clears the set, and outside the mode the card markup is byte-identical to
 * what it has always been. That last property is asserted here as a string
 * equality against a fixture recorded before the task, not as "the button is
 * hidden".
 *
 * Selection is over what is ON SCREEN, not over what was fetched. That is the
 * whole reason `renderedEntries` exists: `applyRecentFilters` narrows
 * `allEntries` by tag and time before handing the result to `renderRecent`, so
 * a `selectAllVisible` reading `allEntries` would silently select rows the
 * user cannot see. The filter case below fails against exactly that mistake.
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
  "public/js/api.js",
  "public/js/toast.js",
  "public/js/confirm-sheet.js",
  "public/js/coach.js",
  "public/js/recent.js",
  // makeRecentCard's last statement is applyCardAuthorLock, which lives here.
  "public/js/memory-crud.js",
  // The tag and time filters, and applyRecentFilters — the one path every
  // selection change re-renders through.
  "public/js/nav.js",
  // The review queue, for the reach case at the bottom of this file: it is the
  // second caller of the shared-badge helper, and this is the only harness
  // that builds both surfaces over one entry.
  "public/js/patterns.js",
];

/**
 * A clock the fixture below can be recorded against.
 *
 * `relativeTime` reads `Date.now()` and the card's time chip formats an
 * absolute date with `toLocaleString`, so a byte-identical assertion against a
 * literal is otherwise a function of the wall clock and the machine's
 * timezone. Both are pinned in the context rather than in the process.
 */
const FROZEN_NOW = 1_756_000_000_000;
class FixedDate extends Date {
  constructor(...args: any[]) {
    if (args.length === 0) super(FROZEN_NOW);
    // @ts-expect-error — forwarding a variadic Date constructor
    else super(...args);
  }
  static now() {
    return FROZEN_NOW;
  }
  toLocaleString() {
    return "FIXED-DATETIME";
  }
  toLocaleDateString() {
    return "FIXED-DATE";
  }
}

/**
 * A fake node that remembers what was appended to it and hands back one stable
 * stub per `querySelector`, so a test can read the very element a module
 * reached for. `innerHTML = ''` clears the recorded children, the way emptying
 * a real node does — `renderRecent` empties the list that way before it
 * appends its date groups.
 */
function makeEl(tag = "div") {
  const classes = new Set<string>();
  const children = new Map<string, any>();
  const kids: any[] = [];
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
    disabled: false,
    checked: false,
    hidden: false,
    title: "",
    onclick: null,
    attrs: {} as Record<string, string>,
    kids,
    setAttribute(k: string, v: string) {
      el.attrs[k] = v;
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    hasAttribute: (k: string) => k in el.attrs,
    addEventListener() {},
    appendChild(c: any) {
      kids.push(c);
      return c;
    },
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
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set(v: string) {
      html = String(v);
      kids.length = 0;
    },
  });
  return el;
}

type Row = Record<string, unknown>;

/** One POST /share, with the tick it began on and the tick it finished on. */
type ShareCall = { id: string; workspace: string; start: number; end: number };

/** What a stubbed POST /share should do for one id. */
type ShareBehaviour = {
  /** The parsed body `apiShare` will return. Defaults to `{ ok: true }`. */
  body?: unknown;
  /** Make `fetch` itself reject — a network failure, not a refusal. */
  reject?: boolean;
  /** Hold the response open until this settles, for the double-submit case. */
  hold?: Promise<unknown>;
};

type Opts = {
  entries?: Row[];
  team?: boolean;
  share?: (id: string) => ShareBehaviour | undefined;
};

function setup(opts: Opts = {}) {
  const byId = new Map<string, any>();
  const bySelector = new Map<string, any>();

  /**
   * The accept button, instrumented before any module can reach it.
   *
   * The progress copy is a SEQUENCE of writes — "Moving 1 of 3…", "2 of 3…",
   * "3 of 3…" — and only the last one survives in a plain property, so a test
   * reading `textContent` at the end cannot tell a loop that reported progress
   * from one that wrote the final value once.
   */
  const acceptWrites: string[] = [];
  const accept = makeEl("button");
  accept.id = "confirm-accept-btn";
  let acceptText = "";
  Object.defineProperty(accept, "textContent", {
    get: () => acceptText,
    set(v: string) {
      acceptText = String(v);
      acceptWrites.push(acceptText);
    },
  });
  byId.set("confirm-accept-btn", accept);

  /**
   * A monotonic tick, and the record of every POST /share against it.
   *
   * Start and finish are both recorded so the ORDERING axis can be asserted as
   * "call k+1 began after call k finished" rather than as a call count. A
   * `Promise.all` implementation satisfies the count and fails the ordering,
   * which is the whole reason the timestamps are here.
   */
  let clock = 0;
  const tick = () => ++clock;
  const shareCalls: ShareCall[] = [];

  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      getElementById(id: string) {
        if (!byId.has(id)) {
          const el = makeEl();
          el.id = id;
          byId.set(id, el);
        }
        return byId.get(id);
      },
      querySelector(sel: string) {
        if (!bySelector.has(sel)) bySelector.set(sel, makeEl());
        return bySelector.get(sel);
      },
      querySelectorAll: () => [],
      createElement: (tag: string) => makeEl(tag),
      addEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // The graph projection's loader, which lives in a module this harness does
    // not load. setMemoryView calls it, and the selection has to survive — or
    // rather, not survive — that call.
    loadGraph: () => {},
    navigator: { language: "en-US" },
    fetch: async (url: string, init?: any) => {
      if (String(url).includes("/team/roster")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, you: "u1", members: [] }) };
      }
      if (String(url).includes("/share")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const call: ShareCall = { id: body.id, workspace: body.workspace, start: tick(), end: 0 };
        shareCalls.push(call);
        const how = opts.share?.(body.id) ?? {};
        if (how.hold) await how.hold;
        if (how.reject) {
          call.end = tick();
          throw new Error("offline");
        }
        return {
          ok: true,
          status: 200,
          // Recorded here rather than at the return above: `apiShare` is not
          // finished until its `res.json()` has resolved.
          json: async () => {
            call.end = tick();
            return how.body ?? { ok: true };
          },
        };
      }
      return { ok: true, status: 200, json: async () => opts.entries ?? [] };
    },
    Date: FixedDate,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of SRC) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext(
    `WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; TEAM_MODE = ${opts.team === false ? "false" : "true"}`,
    ctx,
  );
  ctx.initI18n("en");

  const el = (id: string) => ctx.document.getElementById(id);
  /** Every memory card currently on screen, in render order. */
  const cards = (): any[] => {
    const out: any[] = [];
    for (const group of el("recent-list").kids) {
      for (const wrap of group.kids) {
        if (wrap.className === "recent-cards") out.push(...wrap.kids);
      }
    }
    return out;
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const sheetOpen = () => el("confirm-dialog").classList.contains("open");
  const toast = () => el("app-toast").innerHTML;
  const generation = () => vm.runInContext("confirmGeneration", ctx);
  const selection = () => [...vm.runInContext("selectedMemoryIds", ctx)];
  return { ctx, el, cards, settle, shareCalls, acceptWrites, sheetOpen, toast, generation, selection };
}

const row = (over: Row = {}): Row => ({
  id: "a",
  content: "Renewal date is 3 March",
  tags: "[]",
  source: "web-ui",
  created_at: FROZEN_NOW - 60_000,
  vector_ids: "[]",
  workspace: "personal",
  ...over,
});

const THREE = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];

/**
 * The card a solo brain renders, recorded from `makeRecentCard` BEFORE this
 * task touched it (with the clock and the locale formatter pinned above, so
 * the literal is not a function of the wall clock or the machine timezone).
 * A solo brain must go on producing exactly this.
 */
const SOLO_CARD_CLASS = "memory-card";
const SOLO_CARD_HTML =
  "\n<div class=\"card-content\" style=\"cursor: pointer;\">\n  <div class=\"card-title\">Renewal date is 3 March and the contact is Bob</div>\n  \n</div>\n<div class=\"card-footer\">\n  <div class=\"card-meta\">\n    <span class=\"card-source\"><i class=\"ti ti-message-2\"></i>claude</span>\n    <span class=\"card-time\" title=\"FIXED-DATETIME\">1h ago</span>\n  </div>\n  <div class=\"card-tags\"><span class=\"tag-chip\">work</span><span class=\"tag-chip vec-chip vec-chip--off\" title=\"Not vectorized — won\\'t appear in recall\">Not indexed</span></div>\n  <div class=\"card-actions\">\n    <button class=\"card-action-btn append-btn\" onclick=\"openAppend('m1', 'Renewal date is 3 March and the contact is Bob')\"><i class=\"ti ti-writing\"></i> Append</button>\n    <button class=\"card-action-btn edit-btn\"><i class=\"ti ti-pencil\"></i> Edit</button>\n    <div class=\"card-overflow\">\n      <button class=\"card-action-btn overflow-btn\" aria-label=\"More actions\" aria-haspopup=\"true\" aria-expanded=\"false\"><i class=\"ti ti-dots\"></i></button>\n      <div class=\"card-overflow-menu\" hidden>\n        \n        <button class=\"card-overflow-item danger forget-btn\"><i class=\"ti ti-trash\"></i> Forget this memory</button>\n      </div>\n    </div>\n  </div>\n</div>";

describe("memories multi-select — the mode", () => {
  it("offers Select on a team brain and keeps the bar down until it is pressed", async () => {
    const { ctx, el } = setup({ entries: THREE });
    await ctx.loadRecent();
    expect(el("mem-select-btn").style.display).toBe("");
    expect(el("mem-select-btn").textContent).toBe("Select");
    expect(el("mem-bulk-bar").style.display).toBe("none");
  });

  it("puts a checkbox on every card while the mode is on, and takes it away again", async () => {
    const { ctx, el, cards } = setup({ entries: THREE });
    await ctx.loadRecent();
    for (const card of cards()) expect(card.innerHTML).not.toContain("toggleMemorySelection(");

    ctx.toggleSelectMode();
    expect(el("mem-bulk-bar").style.display).toBe("");
    expect(el("mem-select-btn").textContent).toBe("Done");
    const on = cards();
    expect(on.length).toBe(3);
    for (const card of on) expect(card.innerHTML).toContain("toggleMemorySelection(");

    ctx.toggleSelectMode();
    expect(el("mem-bulk-bar").style.display).toBe("none");
    expect(el("mem-select-btn").textContent).toBe("Select");
    for (const card of cards()) expect(card.innerHTML).not.toContain("toggleMemorySelection(");
  });
});

describe("memories multi-select — the selection", () => {
  it("counts what is ticked and marks the ticked cards", async () => {
    const { ctx, el, cards } = setup({ entries: THREE });
    await ctx.loadRecent();
    ctx.toggleSelectMode();

    ctx.toggleMemorySelection("a", true);
    expect(el("mem-bulk-count").textContent).toBe("1 selected");

    ctx.toggleMemorySelection("b", true);
    expect(el("mem-bulk-count").textContent).toBe("2 selected");
    const marked = cards().filter((c) => c.className.includes("memory-card--selected"));
    expect(marked.map((c) => c.dataset.id)).toEqual(["a", "b"]);
    // The tick survives the re-render the selection itself triggers.
    for (const card of marked) expect(card.innerHTML).toContain("checked");

    ctx.toggleMemorySelection("a", false);
    expect(el("mem-bulk-count").textContent).toBe("1 selected");
    expect(cards().filter((c) => c.className.includes("memory-card--selected")).map((c) => c.dataset.id)).toEqual(["b"]);
  });

  it("disables both actions on an empty selection and enables them on a full one", async () => {
    const { ctx, el } = setup({ entries: THREE });
    await ctx.loadRecent();
    ctx.toggleSelectMode();
    expect(el("mem-bulk-share").disabled).toBe(true);
    expect(el("mem-bulk-private").disabled).toBe(true);

    ctx.toggleMemorySelection("a", true);
    expect(el("mem-bulk-share").disabled).toBe(false);
    expect(el("mem-bulk-private").disabled).toBe(false);

    ctx.clearSelection();
    expect(el("mem-bulk-count").textContent).toBe("0 selected");
    expect(el("mem-bulk-share").disabled).toBe(true);
  });

  it("selects the FILTERED list, not everything that was fetched", async () => {
    // The reason renderedEntries exists. Five rows are in allEntries; a tag
    // filter leaves two on screen. "Select all" must mean those two — an
    // implementation reading allEntries selects five and fails here.
    const five = [
      row({ id: "a", tags: '["work"]' }),
      row({ id: "b", tags: '["home"]' }),
      row({ id: "c", tags: '["work"]' }),
      row({ id: "d", tags: '["home"]' }),
      row({ id: "e", tags: '["home"]' }),
    ];
    const { ctx, cards } = setup({ entries: five });
    await ctx.loadRecent();
    ctx.toggleSelectMode();

    vm.runInContext(`selectedTag = 'work'`, ctx);
    ctx.applyRecentFilters();
    expect(cards().map((c) => c.dataset.id)).toEqual(["a", "c"]);

    ctx.selectAllVisible();
    expect([...vm.runInContext("selectedMemoryIds", ctx)]).toEqual(["a", "c"]);
    expect(vm.runInContext("allEntries.length", ctx)).toBe(5);
  });

  it("counts only what the current filter leaves ON SCREEN", async () => {
    // The bar and the action have to agree about what is selected, or the
    // action is a dead control: before this, filtering the ticked rows away
    // left the bar reading "2 selected" with both buttons enabled, and
    // pressing one opened no sheet, posted nothing and said nothing.
    const five = [
      row({ id: "a", tags: '[\"work\"]' }),
      row({ id: "b", tags: '[\"home\"]' }),
      row({ id: "c", tags: '[\"work\"]' }),
    ];
    const h = setup({ entries: five });
    await h.ctx.loadRecent();
    h.ctx.toggleSelectMode();
    vm.runInContext(`selectedTag = 'work'`, h.ctx);
    h.ctx.applyRecentFilters();
    h.ctx.selectAllVisible();
    expect(h.el("mem-bulk-count").textContent).toBe("2 selected");

    vm.runInContext(`selectedTag = 'home'`, h.ctx);
    h.ctx.applyRecentFilters();
    expect(h.el("mem-bulk-count").textContent, "nothing on screen is ticked").toBe("0 selected");
    expect(h.el("mem-bulk-share").disabled, "so neither action pretends it can run").toBe(true);
    expect(h.el("mem-bulk-private").disabled).toBe(true);
    const before = h.generation();
    h.ctx.confirmBulkLayerMove("company");
    expect(h.generation(), "and pressing one opens nothing at all").toBe(before);
    expect(h.shareCalls.length).toBe(0);

    // Hidden by the filter, not destroyed by it: the ticks come back with the
    // rows, so a filter is not a way to silently lose a selection.
    vm.runInContext(`selectedTag = 'work'`, h.ctx);
    h.ctx.applyRecentFilters();
    expect(h.el("mem-bulk-count").textContent).toBe("2 selected");
    expect(h.el("mem-bulk-share").disabled).toBe(false);
  });

  it("drops the selection on the way out of the mode", async () => {
    const { ctx, el } = setup({ entries: THREE });
    await ctx.loadRecent();
    ctx.toggleSelectMode();
    ctx.selectAllVisible();
    expect(el("mem-bulk-count").textContent).toBe("3 selected");

    ctx.toggleSelectMode();
    expect(vm.runInContext("selectedMemoryIds.size", ctx)).toBe(0);
    ctx.toggleSelectMode();
    expect(el("mem-bulk-count").textContent).toBe("0 selected");
  });
});

describe("memories multi-select — the solo brain", () => {
  it("hides both controls on every path", async () => {
    const { ctx, el } = setup({ entries: THREE, team: false });
    await ctx.loadRecent();
    expect(el("mem-select-btn").style.display).toBe("none");
    expect(el("mem-bulk-bar").style.display).toBe("none");
    // And through the other caller, which is what a brain that stops being a
    // team goes through.
    ctx.maybeRevealMemoryLayerFilter({ team: false });
    expect(el("mem-select-btn").style.display).toBe("none");
    expect(el("mem-bulk-bar").style.display).toBe("none");
  });

  it("renders a card byte-identically to the markup recorded before this task", () => {
    const { ctx } = setup({ team: false });
    // Even with the mode forced on — which no solo brain can do, since the
    // only way in is a button held at display:none — the card must not change.
    vm.runInContext(`selectMode = true`, ctx);
    const card = ctx.makeRecentCard({
      id: "m1",
      content: "Renewal date is 3 March\nand the contact is Bob",
      tags: '["work"]',
      source: "claude",
      created_at: FROZEN_NOW - 3600000,
      vector_ids: "[]",
      workspace: "personal",
      actor_name: null,
    });
    expect(card.className).toBe(SOLO_CARD_CLASS);
    expect(card.innerHTML).toBe(SOLO_CARD_HTML);
  });
});

describe("memories multi-select — leaving the list", () => {
  // Selection is over what is ON SCREEN. The graph projection draws no cards,
  // so a selection that outlived the list would be a live bulk action over
  // rows nobody can see — and #mem-select-btn is a SIBLING of #mem-filters,
  // #mem-bulk-bar a sibling of the whole .mem-bar, so neither is hidden by
  // anything setMemoryView already does.
  it("takes the mode, the bar and the selection down when the graph replaces the list", async () => {
    const h = await selected({ entries: THREE }, ["a", "b"]);
    expect(h.el("mem-bulk-count").textContent).toBe("2 selected");

    h.ctx.setMemoryView("graph");

    expect(h.el("recent-list").hidden).toBe(true);
    expect(h.el("mem-select-btn").style.display, "the Select button must not outlive the list").toBe("none");
    expect(h.el("mem-bulk-bar").style.display, "nor the bulk bar").toBe("none");
    expect(h.selection(), "nor the selection itself").toEqual([]);

    const before = h.generation();
    h.ctx.confirmBulkLayerMove("company");
    expect(h.generation(), "no question over a graph with no cards on it").toBe(before);
    expect(h.sheetOpen()).toBe(false);
    expect(h.shareCalls.length, "and no POST for a row the user cannot see").toBe(0);
  });

  it("gives the Select button back on the way to the list, with the mode off", async () => {
    const h = await selected({ entries: THREE }, ["a", "b"]);
    h.ctx.setMemoryView("graph");
    h.ctx.setMemoryView("list");
    expect(h.el("mem-select-btn").style.display).toBe("");
    expect(h.el("mem-select-btn").textContent, "back to Select, not Done").toBe("Select");
    expect(h.el("mem-bulk-bar").style.display).toBe("none");
    expect(h.selection()).toEqual([]);
  });

  it("keeps both controls down if anything renders the bar over the graph", async () => {
    // renderBulkBar reads the projection itself, the same way it reads
    // TEAM_MODE: a caller that knows nothing about the graph — the layer
    // filter's reveal, say — must not put the button back over one.
    const h = await selected({ entries: THREE }, ["a"]);
    h.ctx.setMemoryView("graph");
    h.ctx.maybeRevealMemoryLayerFilter({ team: true });
    expect(h.el("mem-select-btn").style.display).toBe("none");
    expect(h.el("mem-bulk-bar").style.display).toBe("none");

    vm.runInContext(`selectMode = true`, h.ctx);
    h.ctx.renderBulkBar();
    expect(h.el("mem-select-btn").style.display).toBe("none");
    expect(h.el("mem-bulk-bar").style.display).toBe("none");
  });
});

describe("memories multi-select — Italian", () => {
  it("translates the button and the count", async () => {
    const { ctx, el } = setup({ entries: THREE });
    ctx.initI18n("it");
    await ctx.loadRecent();
    expect(el("mem-select-btn").textContent).toBe("Seleziona");
    ctx.toggleSelectMode();
    ctx.toggleMemorySelection("a", true);
    ctx.toggleMemorySelection("b", true);
    expect(el("mem-bulk-count").textContent).toBe("2 selezionati");
    expect(el("mem-select-btn").textContent).toBe("Fatto");
  });
});

/**
 * Bulk share / make private, through the ONE share implementation.
 *
 * There is no bulk endpoint, and that is the requirement rather than a
 * shortcut. `moveEntry` (src/capture/share.ts) is the one place that decides
 * who may move what; a `POST /share/bulk` would be a second loop over that
 * decision with its own ordering, its own partial-failure semantics and its
 * own author-lock matrix, and the first time one changed the two would
 * disagree about a permission. So the bulk action calls `apiShare` once per
 * row, sequentially, and every refusal is `moveEntry`'s own refusal.
 *
 * Four axes, because the wrapper failure the rule exists for is exactly this
 * shape: CONTENT (which ids, which target), ORDERING AND COST (one POST per
 * id, in the rendered order, strictly sequential), ERROR PROPAGATION (a
 * rejected row does not abort the rest and does not throw out of `onConfirm`),
 * and DOUBLE SUBMIT (a second accept while the batch is in flight issues no
 * second batch).
 */

/** Select the given ids, in the mode, over a freshly loaded list. */
async function selected(setupArgs: Parameters<typeof setup>[0], ids: string[]) {
  const h = setup(setupArgs);
  await h.ctx.loadRecent();
  h.ctx.toggleSelectMode();
  for (const id of ids) h.ctx.toggleMemorySelection(id, true);
  return h;
}

describe("bulk layer move — the question", () => {
  it("asks before it moves anything", async () => {
    const h = await selected({ entries: THREE }, ["a", "b", "c"]);
    h.ctx.confirmBulkLayerMove("company");
    expect(h.el("confirm-title").textContent).toBe("Share 3 memories with the team?");
    expect(h.el("confirm-body").textContent).toBe(
      "Everyone on this team will be able to find them. You can make each one personal again afterwards.",
    );
    expect(h.el("confirm-accept-btn").textContent).toBe("Share with team");
    expect(h.sheetOpen()).toBe(true);
    // The sheet asks FIRST: nothing has been posted yet.
    expect(h.shareCalls.length).toBe(0);
  });

  it("uses the singular arm for one row going personal", async () => {
    const h = await selected({ entries: THREE }, ["b"]);
    h.ctx.confirmBulkLayerMove("personal");
    expect(h.el("confirm-title").textContent).toBe("Make this memory personal again?");
    expect(h.el("confirm-accept-btn").textContent).toBe("Make private");
  });

  it("opens no sheet on an empty selection", async () => {
    const h = await selected({ entries: THREE }, []);
    const before = h.generation();
    h.ctx.confirmBulkLayerMove("company");
    expect(h.generation(), "the sheet's generation must not advance").toBe(before);
    expect(h.sheetOpen()).toBe(false);
    expect(h.shareCalls.length).toBe(0);
  });

  it("opens no sheet and posts nothing on a solo brain", async () => {
    // The solo-brain guarantee, asserted rather than argued, in both halves.
    // First: even with the mode forced on — which no solo brain can do, the
    // only way in being a button held at display:none — no card carries a
    // checkbox, so nothing can ever put an id in the set.
    const h = setup({ entries: THREE, team: false });
    await h.ctx.loadRecent();
    vm.runInContext(`selectMode = true`, h.ctx);
    h.ctx.applyRecentFilters();
    for (const card of h.cards()) expect(card.innerHTML).not.toContain("toggleMemorySelection(");
    expect(h.selection()).toEqual([]);

    // Second: with the set empty, the action returns at its first line —
    // openDangerConfirm is never reached, so its generation does not advance.
    const before = h.generation();
    h.ctx.confirmBulkLayerMove("company");
    expect(h.generation()).toBe(before);
    expect(h.sheetOpen()).toBe(false);
    expect(h.shareCalls.length).toBe(0);
  });
});

describe("bulk layer move — content, ordering and cost", () => {
  it("posts one /share per selected id, in the rendered order, with the target", async () => {
    const h = await selected({ entries: THREE }, ["a", "b", "c"]);
    h.ctx.confirmBulkLayerMove("company");
    await h.ctx.runConfirmAction();
    await h.settle();

    expect(h.shareCalls.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(h.shareCalls.map((c) => c.workspace)).toEqual(["company", "company", "company"]);
    expect(h.sheetOpen()).toBe(false);
    expect(h.toast()).toContain("3 moved");
    expect(h.selection()).toEqual([]);
  });

  it("issues each request only after the previous one has answered", async () => {
    // THE SEQUENCING CASE. Fifty parallel POSTs against one D1 database is a
    // self-inflicted thundering herd, and the progress copy on the accept
    // button is only honest if the moves are ordered. A Promise.all
    // implementation passes the call-count assertion above and fails this one.
    const h = await selected({ entries: THREE }, ["a", "b", "c"]);
    h.ctx.confirmBulkLayerMove("company");
    await h.ctx.runConfirmAction();
    await h.settle();

    expect(h.shareCalls.length).toBe(3);
    for (let i = 1; i < h.shareCalls.length; i++) {
      expect(
        h.shareCalls[i].start,
        `call ${i + 1} began at ${h.shareCalls[i].start}, before call ${i} finished at ${h.shareCalls[i - 1].end}`,
      ).toBeGreaterThan(h.shareCalls[i - 1].end);
    }
  });

  it("reports progress on the accept button, one write per row", async () => {
    const h = await selected({ entries: THREE }, ["a", "b", "c"]);
    h.ctx.confirmBulkLayerMove("company");
    const before = h.acceptWrites.length;
    await h.ctx.runConfirmAction();
    await h.settle();
    expect(h.acceptWrites.slice(before)).toEqual(["Moving 1 of 3…", "Moving 2 of 3…", "Moving 3 of 3…"]);
  });

  it("skips a hole in the rendered list rather than throwing on it", async () => {
    // selectAllVisible guards with `if (e && e.id)`; the action read
    // `renderedEntries.map((e) => e.id)` bare. Two readers of one array that
    // disagree about what is in it is how one of them starts throwing.
    const h = await selected({ entries: THREE }, ["a", "c"]);
    vm.runInContext(`renderedEntries = [null].concat(renderedEntries)`, h.ctx);
    expect(() => h.ctx.renderBulkBar()).not.toThrow();
    h.ctx.confirmBulkLayerMove("company");
    await h.ctx.runConfirmAction();
    await h.settle();
    expect(h.shareCalls.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("issues no second batch when the accept is tapped twice", async () => {
    let release: (v: unknown) => void = () => {};
    const held = new Promise((r) => (release = r));
    const h = await selected({ entries: THREE, share: (id) => (id === "a" ? { hold: held } : {}) }, [
      "a",
      "b",
      "c",
    ]);
    h.ctx.confirmBulkLayerMove("company");
    const first = h.ctx.runConfirmAction();
    // Row 1 is still in flight; the sheet must swallow this one.
    await h.ctx.runConfirmAction();
    release(null);
    await first;
    await h.settle();
    expect(h.shareCalls.length, "3 posts, not 6").toBe(3);
  });
});

describe("bulk layer move — a question the user walked away from", () => {
  /** A batch with row `a` held open, so the sheet can be dismissed mid-flight. */
  async function midFlight(target: string) {
    let release: (v: unknown) => void = () => {};
    const held = new Promise((r) => (release = r));
    const h = await selected({ entries: THREE, share: (id) => (id === "a" ? { hold: held } : {}) }, [
      "a",
      "b",
      "c",
    ]);
    h.ctx.confirmBulkLayerMove(target);
    const running = h.ctx.runConfirmAction();
    return { h, running, release };
  }

  it("writes no progress copy onto a question it no longer owns", async () => {
    // Escape does not stop the batch by itself, and the accept button is one
    // shared element: the loop used to go on writing "Moving 3 of 3…" onto
    // whatever question was on screen by then. The user was asked "Forget this
    // memory?" under a button labelled "Moving 3 of 3…".
    const { h, running, release } = await midFlight("company");
    h.ctx.closeConfirm();
    h.ctx.openDangerConfirm({
      title: "Forget this memory?",
      body: "This cannot be undone.",
      confirmLabel: "Forget",
      onConfirm: (_c: boolean, done: () => void) => done(),
    });
    release(null);
    await running;
    await h.settle();

    expect(h.el("confirm-accept-btn").textContent, "label of the NEW question").toBe("Forget");
    expect(h.sheetOpen(), "which is still up, because done() was inert too").toBe(true);
  });

  it("stops the loop when the question is dismissed", async () => {
    // Dismissing the sheet is the user withdrawing the request. Rows the loop
    // has not reached yet are not "already asked for" — they were asked for by
    // a question that is no longer on screen.
    const { h, running, release } = await midFlight("company");
    h.ctx.closeConfirm();
    release(null);
    await running;
    await h.settle();

    expect(h.shareCalls.map((c) => c.id), "row 1 was already in flight; rows 2 and 3 never go").toEqual(["a"]);
    // What did happen is still reported, rather than left for the user to guess.
    expect(h.toast()).toContain("1 moved");
    expect(h.selection(), "and the untouched rows are still ticked").toEqual(["b", "c"]);
  });

  it("issues no second batch, and no opposite move, after a dismissal mid-flight", async () => {
    // THE RACE. Same-target duplicates are idempotent, so the damage hides
    // there — but "Share with team", Escape, then "Make private" over the same
    // ids used to interleave two loops posting OPPOSITE workspace values
    // against the same rows, and each row's final layer was decided by
    // whichever response happened to land last. Six POSTs for three rows.
    const { h, running, release } = await midFlight("company");
    h.ctx.closeConfirm();

    // The batch is still in flight, so the actions say so rather than starting
    // a second loop behind the first.
    expect(h.el("mem-bulk-share").disabled, "held down while a batch is in flight").toBe(true);
    expect(h.el("mem-bulk-private").disabled).toBe(true);
    const before = h.generation();
    h.ctx.confirmBulkLayerMove("personal");
    expect(h.generation(), "no second question").toBe(before);
    // Not awaited before the release: a second loop would park on the same
    // held response as the first, which is the interleaving itself.
    const second = h.ctx.runConfirmAction();

    release(null);
    await running;
    await second;
    await h.settle();

    expect(h.shareCalls.length, "one POST, not six").toBe(1);
    expect(
      h.shareCalls.map((c) => c.workspace),
      "and never two workspaces racing over one id",
    ).toEqual(["company"]);
    expect(h.el("mem-bulk-share").disabled, "and the actions come back once it has settled").toBe(false);
  });
});

describe("bulk layer move — partial success", () => {
  const REFUSED = { ok: false, error: "Only the entry's author or an admin can un-share it" };

  it("leaves exactly the refused row selected and says so", async () => {
    // The case this task exists for. The refused rows stay selected because
    // that is how the user is told which ones did not move, without a second
    // list to render or a second piece of state to hold.
    const h = await selected(
      { entries: THREE, share: (id) => (id === "b" ? { body: REFUSED } : {}) },
      ["a", "b", "c"],
    );
    h.ctx.confirmBulkLayerMove("personal");
    await h.ctx.runConfirmAction();
    await h.settle();

    expect(h.shareCalls.map((c) => c.id), "all three are attempted").toEqual(["a", "b", "c"]);
    expect(h.toast()).toContain("2 moved · 1 refused — still selected");
    expect(h.selection()).toEqual(["b"]);
    expect(
      h.cards().filter((c: any) => c.className.includes("memory-card--selected")).map((c: any) => c.dataset.id),
      "and the refused row is still marked after the reload",
    ).toEqual(["b"]);
  });

  it("says nothing moved when nothing did, and keeps all three selected", async () => {
    const h = await selected({ entries: THREE, share: () => ({ body: REFUSED }) }, ["a", "b", "c"]);
    h.ctx.confirmBulkLayerMove("personal");
    await h.ctx.runConfirmAction();
    await h.settle();
    expect(h.toast()).toContain("Nothing moved");
    expect(h.selection()).toEqual(["a", "b", "c"]);
  });

  it("mixes a success, a server refusal and a network error in one batch", async () => {
    // The three outcomes are covered one at a time above. This is the
    // combination the toast arithmetic could get wrong: `moved` counts one,
    // `refused` has to collect both of the other two, and the selection has to
    // end up holding exactly those two ids.
    const h = await selected(
      {
        entries: THREE,
        share: (id) => (id === "b" ? { body: REFUSED } : id === "c" ? { reject: true } : {}),
      },
      ["a", "b", "c"],
    );
    h.ctx.confirmBulkLayerMove("personal");
    await h.ctx.runConfirmAction();
    await h.settle();

    expect(h.shareCalls.map((c) => c.id), "all three are attempted").toEqual(["a", "b", "c"]);
    expect(h.toast()).toContain("1 moved · 2 refused — still selected");
    expect(h.selection(), "the refusal and the network failure, and not the success").toEqual(["b", "c"]);
    expect(
      h.cards().filter((c: any) => c.className.includes("memory-card--selected")).map((c: any) => c.dataset.id),
    ).toEqual(["b", "c"]);
  });

  it("counts a row already in the target layer as moved", async () => {
    // POST /share answers { ok: true, status: "no_change" } for a row that is
    // already where it was asked to go. The user asked for a state and the row
    // is in it, so r.ok is the whole classification.
    const h = await selected(
      { entries: THREE, share: (id) => (id === "c" ? { body: { ok: true, status: "no_change" } } : {}) },
      ["a", "b", "c"],
    );
    h.ctx.confirmBulkLayerMove("company");
    await h.ctx.runConfirmAction();
    await h.settle();
    expect(h.toast()).toContain("3 moved");
    expect(h.selection()).toEqual([]);
  });
});

describe("bulk layer move — error propagation", () => {
  it("treats a network failure as one row's refusal and finishes the rest", async () => {
    // Aborting on row 2 would leave the user with a half-moved selection and
    // no way to tell which half. Throwing out of onConfirm would leave the
    // accept button disabled forever — the sheet's own rule 1.
    const h = await selected(
      { entries: THREE, share: (id) => (id === "b" ? { reject: true } : {}) },
      ["a", "b", "c"],
    );
    h.ctx.confirmBulkLayerMove("company");
    await expect(h.ctx.runConfirmAction()).resolves.toBeUndefined();
    await h.settle();

    expect(h.shareCalls.map((c) => c.id), "rows 1 and 3 are still attempted").toEqual(["a", "b", "c"]);
    expect(h.sheetOpen(), "done() ran").toBe(false);
    expect(h.toast()).toContain("2 moved · 1 refused — still selected");
    expect(h.selection()).toEqual(["b"]);

    // The sheet's rule 1 is "close, or re-enable, but never fall off the end
    // of an action having done neither". This action closes — so the next
    // question opens with a usable accept button rather than a dead one.
    h.ctx.confirmBulkLayerMove("personal");
    expect(h.sheetOpen()).toBe(true);
    expect(h.el("confirm-accept-btn").disabled).toBe(false);
  });
});

describe("bulk layer move — Italian", () => {
  it("asks and reports in Italian", async () => {
    const h = await selected(
      { entries: THREE, share: (id) => (id === "b" ? { body: { ok: false, error: "no" } } : {}) },
      ["a", "b", "c"],
    );
    h.ctx.initI18n("it");
    h.ctx.confirmBulkLayerMove("company");
    expect(h.el("confirm-title").textContent).toBe("Condividere 3 ricordi col team?");
    await h.ctx.runConfirmAction();
    await h.settle();
    expect(h.toast()).toContain("2 spostati · 1 rifiutato — resta selezionato");
  });

  it("reports a batch that moved nothing with a verb, like the rest of the block", async () => {
    const h = await selected({ entries: THREE, share: () => ({ body: { ok: false, error: "no" } }) }, [
      "a",
      "b",
      "c",
    ]);
    h.ctx.initI18n("it");
    h.ctx.confirmBulkLayerMove("personal");
    await h.ctx.runConfirmAction();
    await h.settle();
    expect(h.toast()).toContain("Niente spostato");
  });
});

/**
 * ONE implementation of "this row is shared", with two callers.
 *
 * The memories card built the badge inline and the review queue built nothing.
 * The requirement is not two chips that look alike — a requirement phrased as
 * sameness is satisfiable by copying — so it is one function in
 * `public/utils.js`, and this is the assertion that survives someone later
 * "fixing" one of the two surfaces without the other.
 */
describe("the shared badge reaches both surfaces from one function", () => {
  const CHIP = /<span class="tag-chip tag-chip--shared"[\s\S]*?<\/span>/;

  const fixture = {
    id: "p1",
    content: "You keep circling back to the same onboarding complaint.",
    tags: "[]",
    source: "web-ui",
    created_at: FROZEN_NOW - 60_000,
    vector_ids: "[]",
    workspace: "company",
    actor_name: "Second Brain",
  };

  it("renders the same chip on a memory card and on a pattern row", () => {
    const { ctx } = setup({ team: true });
    const fromCard = ctx.makeRecentCard(fixture).innerHTML.match(CHIP);
    const fromRow = ctx.patternRow(fixture).match(CHIP);
    expect(fromCard, "the memories card must carry the chip").not.toBeNull();
    expect(fromRow, "the review queue must carry the chip").not.toBeNull();
    expect(fromRow![0]).toBe(fromCard![0]);
    expect(fromCard![0]).toContain("shared · Second Brain");
  });

  it("reads every workspace the row projection can carry, and badges only one", () => {
    // The server emits `workspace` on EVERY row in one unconditional
    // projection: "personal", "company", and "system" for the rows nobody
    // authored — including legacy rows whose column is still ''. Only the
    // shared layer is a badge; the other three are the silence the card has
    // always kept.
    const { ctx } = setup({ team: true });
    const card = (over: Row) => ctx.makeRecentCard({ ...fixture, ...over }).innerHTML;
    // Derived from the row, not from a name this file knows: a different
    // author reads back as a different chip.
    expect(card({ workspace: "company", actor_name: "Ada L" })).toContain("shared · Ada L");
    expect(card({ workspace: "personal" })).not.toContain("tag-chip--shared");
    expect(card({ workspace: "system" }), "the brain's own rows are not a team member's").not.toContain(
      "tag-chip--shared",
    );
    expect(card({ workspace: "" }), "and neither is a legacy row").not.toContain("tag-chip--shared");
  });

  it("renders it on neither surface on a solo brain", () => {
    const { ctx } = setup({ team: false });
    expect(ctx.makeRecentCard(fixture).innerHTML).not.toContain("tag-chip--shared");
    expect(ctx.patternRow(fixture)).not.toContain("tag-chip--shared");
  });
});
