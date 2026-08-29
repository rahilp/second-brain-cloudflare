/**
 * The memories list's author filter — "show only what one person shared".
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

type Opts = { rosterRejects?: boolean; entries?: Array<Record<string, unknown>> };

function setup(opts: Opts = {}) {
  const byId = new Map<string, any>();
  const urls: string[] = [];

  const fetchImpl = async (url: string) => {
    urls.push(url);
    if (url.includes("/team/roster")) {
      if (opts.rosterRejects) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ROSTER };
    }
    return { ok: true, status: 200, json: async () => opts.entries ?? [] };
  };

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
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag: string) => makeEl(tag),
      addEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
  return { ctx, el, urls, lists, rosters, settle };
}

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
