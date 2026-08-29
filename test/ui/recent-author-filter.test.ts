/**
 * The memories list's author filter — "show only what one person shared" — and
 * the author-lock coach mark that appears once a shared memory is in view.
 *
 * It exists only on the shared layer, because "who wrote this" is a question
 * about memory other people can see; on the personal layer every row is yours
 * and the control would be a dropdown with one real option.
 *
 * The case this file exists for is the last one in the first group: an author
 * filter that survives a move off the shared layer keeps narrowing the list
 * from a control the user can no longer see.
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
  "public/js/coach.js",
  "public/js/recent.js",
]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

function makeEl(tag = "div") {
  return {
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    addEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
}

const ROSTER = {
  ok: true,
  you: "u1",
  members: [
    { userId: "u1", name: "Ada Lovelace", role: "admin" },
    { userId: "u2", name: "Grace Hopper", role: "member" },
  ],
};

type Opts = {
  rosterRejects?: boolean;
  /** A /team/roster that never answers at all — no timeout, no abort. */
  rosterHangs?: boolean;
  /** Element ids getElementById should report as absent. */
  missing?: string[];
  listRejects?: boolean;
  /** A /list body that is not an array at all — an error object, say. */
  listBody?: unknown;
  entries?: Array<Record<string, unknown>>;
};

function setup(opts: Opts = {}) {
  const byId = new Map<string, any>();
  const urls: string[] = [];
  const listAtRosterTime: Array<string | null> = [];
  const absent = new Set(opts.missing ?? []);
  // A real store: the coach mark below is dismissed through it, and the
  // solo-brain case asserts nothing was ever written to it.
  const store = new Map<string, string>();
  const writes: string[] = [];
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem(k: string, v: string) {
      writes.push(k);
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  };

  const fetchImpl = async (url: string) => {
    urls.push(url);
    if (url.includes("/team/roster")) {
      // What the memories list held at the moment the roster was asked for.
      // The loading state has to be painted by then, or the roster is being
      // waited on before the screen says anything at all.
      listAtRosterTime.push(byId.get("recent-list")?.innerHTML ?? null);
      if (opts.rosterHangs) return new Promise(() => {});
      if (opts.rosterRejects) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ROSTER };
    }
    if (opts.listRejects) throw new Error("offline");
    return { ok: true, status: 200, json: async () => opts.listBody ?? opts.entries ?? [] };
  };

  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      getElementById(id: string) {
        if (absent.has(id)) return null;
        if (!byId.has(id)) {
          const el = makeEl();
          el.id = id;
          byId.set(id, el);
        }
        return byId.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag: string) => makeEl(tag),
      addEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage,
    navigator: { language: "en-US" },
    fetch: fetchImpl,
    // A vm context is not a Node realm: apiList builds its query string with
    // URLSearchParams, which is not there unless it is handed over.
    URLSearchParams,
    setTimeout,
    clearTimeout,
    // nav.js owns the tag/time filters and is not part of this module's SRC.
    applyRecentFilters() {},
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; TEAM_MODE = true`, ctx);
  ctx.initI18n("en");

  const el = (id: string) => ctx.document.getElementById(id);
  const lists = () => urls.filter((u) => u.includes("/list?"));
  const rosters = () => urls.filter((u) => u.includes("/team/roster"));
  /** Drain the promise chain an onchange handler starts but does not return. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { ctx, el, urls, lists, rosters, settle, writes, listAtRosterTime };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  content: "Renewal date is 3 March",
  tags: "[]",
  source: "web-ui",
  created_at: Date.now(),
  vector_ids: "[]",
  workspace: "personal",
  ...over,
});

/** The query string of the most recent GET /list. */
const q = (url: string) => url.slice(url.indexOf("/list?") + "/list?".length);

describe("memories author filter", () => {
  it("reveals the filter on the shared layer and fetches the roster once", async () => {
    const { ctx, el, lists, rosters, settle } = setup();
    ctx.onLayerFilterChange("company");
    await settle();
    expect(el("actor-filter-wrap").style.display).toBe("");
    expect(rosters().length).toBe(1);
    expect(q(lists()[lists().length - 1])).toBe("n=50&workspace=company");
  });

  it("sends ?actor= when an author is chosen", async () => {
    const { ctx, lists, settle } = setup();
    ctx.onLayerFilterChange("company");
    await settle();
    ctx.onActorFilterChange("u2");
    await settle();
    expect(q(lists()[lists().length - 1])).toBe("n=50&workspace=company&actor=u2");
  });

  it("does not re-fetch the roster on a later load", async () => {
    const { ctx, rosters, settle } = setup();
    ctx.onLayerFilterChange("company");
    await settle();
    await ctx.loadRecent();
    await ctx.loadRecent();
    expect(rosters().length).toBe(1);
  });

  it("lists one option per member and calls the caller's own row 'You'", async () => {
    const { ctx, el, settle } = setup();
    ctx.onLayerFilterChange("company");
    await settle();
    const html = el("actor-filter-recent").innerHTML;
    expect(html).toContain("All authors");
    expect(html).toContain('value="u1"');
    expect(html).toContain('value="u2"');
    expect(html).toContain("Grace Hopper");
    // The caller is u1: their own row reads "You", not their name.
    expect(html).toContain("You");
    expect(html).not.toContain("Ada Lovelace");
  });

  it("clears the author filter when the layer moves off shared", async () => {
    // The trap this task exists to avoid: a filter the user can no longer see
    // must not go on narrowing the list.
    const { ctx, el, lists, settle } = setup();
    ctx.onLayerFilterChange("company");
    await settle();
    ctx.onActorFilterChange("u2");
    await settle();
    expect(q(lists()[lists().length - 1])).toContain("actor=u2");

    ctx.onLayerFilterChange("");
    await settle();
    expect(q(lists()[lists().length - 1])).toBe("n=50");
    expect(el("actor-filter-wrap").style.display).toBe("none");

    // And it stays cleared on a return to the shared layer, rather than
    // reappearing from a variable nothing on screen still refers to.
    ctx.onLayerFilterChange("company");
    await settle();
    expect(q(lists()[lists().length - 1])).toBe("n=50&workspace=company");
    expect(el("actor-filter-recent").value).toBe("");
  });

  it("drops the author filter with the layer filter when the brain stops being a team", async () => {
    const { ctx, el, lists, settle } = setup();
    ctx.onLayerFilterChange("company");
    await settle();
    ctx.onActorFilterChange("u2");
    await settle();

    vm.runInContext(`TEAM_MODE = false`, ctx);
    ctx.maybeRevealMemoryLayerFilter({ team: false });
    expect(el("layer-filter-wrap").style.display).toBe("none");
    expect(el("actor-filter-wrap").style.display).toBe("none");
    await ctx.loadRecent();
    expect(q(lists()[lists().length - 1])).not.toContain("actor=");
  });

  it("shows no filter, fetches no roster and sends no extra parameter on a solo brain", async () => {
    const { ctx, el, lists, rosters } = setup();
    vm.runInContext(`TEAM_MODE = false`, ctx);
    await ctx.loadRecent();
    expect(el("actor-filter-wrap").style.display).toBe("none");
    expect(rosters().length).toBe(0);
    // Byte-identical to the URL a solo brain sent before this task.
    expect(q(lists()[0])).toBe("n=50");
  });

  it("leaves just 'All authors' when the roster call fails, and does not retry it", async () => {
    const { ctx, el, rosters, settle } = setup({ rosterRejects: true });
    ctx.onLayerFilterChange("company");
    await settle();
    const html = el("actor-filter-recent").innerHTML;
    expect(html).toContain("All authors");
    expect(html).not.toContain('value="u2"');
    await ctx.loadRecent();
    expect(rosters().length, "a failed roster is remembered, not retried").toBe(1);
    // The list itself is unaffected: a missing roster hides nobody's memories.
    expect(el("actor-filter-wrap").style.display).toBe("");
  });

  it("paints the list without waiting for the roster to answer", async () => {
    // The roster is a refinement of a list the user cannot act on until it
    // exists, so it must never hold the list hostage. A /team/roster with no
    // timeout and no abort that simply hangs used to leave the memories screen
    // showing stale rows with no spinner and no error, indefinitely.
    const { ctx, el, lists, rosters, listAtRosterTime, settle } = setup({
      rosterHangs: true,
      entries: [row({ workspace: "company" })],
    });
    ctx.onLayerFilterChange("company");
    await settle();

    expect(rosters().length, "the roster is still requested").toBe(1);
    // Painted before the roster went out, not after it came back.
    expect(listAtRosterTime[0]).toContain("Loading");
    // And the list itself completed while the roster is still pending.
    expect(q(lists()[lists().length - 1])).toBe("n=50&workspace=company");
    expect(vm.runInContext("allEntries.length", ctx)).toBe(1);
    // loadRecent ran all the way to its last statement.
    expect(el("coach-memories").hidden).toBe(false);
    // The filter is revealed and honestly empty until the roster answers.
    expect(el("actor-filter-wrap").style.display).toBe("");
    expect(el("actor-filter-recent").innerHTML).toBe("");
  });

  it("does not stack up roster requests when two loads overlap", async () => {
    // Now that the list no longer awaits the roster, two loads can be in
    // flight at once — so the memoisation has to be on the request and not
    // only on its result.
    const { ctx, rosters, settle } = setup();
    ctx.onLayerFilterChange("company");
    ctx.loadRecent();
    ctx.loadRecent();
    await settle();
    expect(rosters().length).toBe(1);
  });

  it("clears the author filter even when the filter control is not on the page", async () => {
    // maybeRevealActorFilter returns before its clear when #actor-filter-wrap
    // is absent, so onLayerFilterChange's own clear is the only one that runs.
    // Without it the list would keep sending ?actor= for a control that is not
    // merely hidden but not there at all.
    const { ctx, lists, settle } = setup({ missing: ["actor-filter-wrap"] });
    ctx.onLayerFilterChange("company");
    await settle();
    ctx.onActorFilterChange("u2");
    await settle();
    expect(q(lists()[lists().length - 1])).toBe("n=50&workspace=company&actor=u2");

    ctx.onLayerFilterChange("");
    await settle();
    expect(q(lists()[lists().length - 1])).toBe("n=50");
  });

  it("translates the option list into Italian", async () => {
    const { ctx, el, settle } = setup();
    ctx.initI18n("it");
    ctx.onLayerFilterChange("company");
    await settle();
    const html = el("actor-filter-recent").innerHTML;
    expect(html).toContain("Tutti gli autori");
    expect(html).toContain("Tu");
  });
});

/**
 * The author-lock coach mark.
 *
 * Its trigger is the presence of a shared memory in the loaded list rather
 * than an event on the share itself: that covers a member's own first share
 * (their row is in the very next list) and, far more commonly, someone joining
 * a team that already has shared memories — whom a share-event trigger would
 * never reach at all.
 */
describe("memories author-lock coach mark", () => {
  it("appears once a shared memory is in the list", async () => {
    const { ctx, el } = setup({ entries: [row(), row({ id: "m2", workspace: "company" })] });
    await ctx.loadRecent();
    expect(el("coach-memories").hidden).toBe(false);
    expect(el("coach-memories").innerHTML).toContain("Only the author can change a shared memory");
  });

  it("stays away while every memory is personal", async () => {
    const { ctx, el } = setup({ entries: [row(), row({ id: "m2" })] });
    await ctx.loadRecent();
    expect(el("coach-memories").hidden).toBe(true);
    expect(el("coach-memories").innerHTML).toBe("");
  });

  it("does not come back after it has been dismissed", async () => {
    const { ctx, el } = setup({ entries: [row({ workspace: "company" })] });
    await ctx.loadRecent();
    ctx.dismissCoachMark("author-lock", "coach-memories");
    await ctx.loadRecent();
    expect(el("coach-memories").hidden).toBe(true);
    expect(el("coach-memories").innerHTML).toBe("");
  });

  it("renders nothing and writes nothing on a solo brain, shared row or not", async () => {
    // Both gates are asserted, not just the data one: a solo brain's rows are
    // never workspace 'company' in practice, so a fixture that is proves the
    // primitive's TEAM_MODE gate is what does the work here.
    const { ctx, el, writes } = setup({ entries: [row({ workspace: "company" })] });
    vm.runInContext(`TEAM_MODE = false`, ctx);
    await ctx.loadRecent();
    expect(el("coach-memories").hidden).toBe(true);
    expect(el("coach-memories").innerHTML).toBe("");
    expect(writes, "a solo brain must never write sb_coach_dismissed").not.toContain("sb_coach_dismissed");
  });

  it("leaves the mark hidden and does not throw when /list fails", async () => {
    const { ctx, el } = setup({ listRejects: true });
    await expect(ctx.loadRecent()).resolves.toBeUndefined();
    expect(el("coach-memories").hidden).toBe(true);
    expect(el("coach-memories").innerHTML).toBe("");
  });

  it("survives a /list body that is not a list at all", async () => {
    // The mark is rendered after loadRecent's try/catch, so an error object
    // where an array was expected must not throw out of the load.
    const { ctx, el } = setup({ listBody: { ok: false, error: "nope" } });
    await expect(ctx.loadRecent()).resolves.toBeUndefined();
    expect(el("coach-memories").hidden).toBe(true);
  });

  it("translates the mark into Italian", async () => {
    const { ctx, el } = setup({ entries: [row({ workspace: "company" })] });
    ctx.initI18n("it");
    await ctx.loadRecent();
    expect(el("coach-memories").innerHTML).toContain("Solo chi l’ha condiviso può modificarlo");
    expect(el("coach-memories").innerHTML).toContain("Ho capito");
  });
});
