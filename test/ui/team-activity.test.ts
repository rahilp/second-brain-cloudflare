/**
 * The admin activity feed (`public/js/activity.js`).
 *
 * A compliance view's whole value is the sentence it produces, so these tests
 * read the rendered words rather than counting nodes. Same fake-DOM + vm
 * harness as team-panel.test.ts; `fetch` is stubbed outright, so nothing here
 * waits on the Worker half of GET /team/activity.
 *
 * Axes, per the brief: content (the sentence each event kind produces, in both
 * locales), ordering (server order, never re-sorted here), paging (append
 * extends, and the button's visibility follows the last page's size), error
 * propagation (cold failure states it, warm failure keeps the rows) and
 * absence (a solo brain issues no request at all).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js and activity.js, in page-load order. */
const SRC = ["public/utils.js", "public/js/i18n.js", "public/js/state.js", "public/js/activity.js"]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

function makeEl() {
  const el: any = {
    id: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {},
  };
  return el;
}

const ACTIVITY_ELEMENT_IDS = ["team-activity", "activity-list", "activity-more", "activity-export"];

function setup(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  { teamMode = true, locale = "en" }: { teamMode?: boolean; locale?: "en" | "it" } = {},
) {
  const elements = new Map<string, any>();
  for (const id of ACTIVITY_ELEMENT_IDS) {
    const el = makeEl();
    el.id = id;
    elements.set(id, el);
  }
  // Exactly what index.html ships: the whole section hidden, the Show-more
  // button hidden until a full page proves there is more.
  elements.get("team-activity").style.display = "none";
  elements.get("activity-more").hidden = true;

  const calls: string[] = [];
  const doc = {
    documentElement: { lang: "en" },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id?: string) => elements.get(id ?? "") ?? null,
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild() {} },
  };
  const ctx: any = {
    console,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: locale === "it" ? "it-IT" : "en-US" },
    fetch: (url: string, init?: any) => {
      calls.push(url);
      return fetchImpl(url, init);
    },
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // WORKER_URL/AUTH_TOKEN are top-level `let` bindings in state.js and
  // TEAM_MODE lives in api.js, which this harness does not load; both must be
  // assigned in-context rather than set as sandbox properties.
  vm.runInContext(
    `WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = ${teamMode}`,
    ctx,
  );
  ctx.initI18n(locale);
  return { ctx, els: elements, calls };
}

/** Lets every pending microtask in a fire-and-forget handler settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function ok(events: any[]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, events }) };
}

function memberRow(i: number, over: Record<string, unknown> = {}) {
  return {
    at: `2026-08-2${(i % 9) + 1}T10:0${i % 10}:00.000Z`,
    event: "member_created",
    actor: `Ada ${i}`,
    subject: `Bob ${i}`,
    kind: "member",
    title: null,
    entryId: null,
    detail: {},
    ...over,
  };
}

const page = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => memberRow(offset + i));

describe("the activity feed", () => {
  it("reveals the section, fetches the first page once and renders the sentence", async () => {
    const { ctx, els, calls } = setup(async () =>
      ok([memberRow(0, { actor: "Ada Lovelace", subject: "Bob Stone" })]),
    );
    await ctx.maybeRevealActivity();
    expect(calls).toEqual(["http://localhost/team/activity?limit=50&offset=0"]);
    expect(els.get("team-activity").style.display).toBe("");
    const html = els.get("activity-list").innerHTML as string;
    expect(html).toContain("Added a member");
    expect(html).toContain("Bob Stone");
    expect(html).toContain("Ada Lovelace");
  });

  it("sends the bearer token the rest of the dashboard sends", async () => {
    let seen: any = null;
    const { ctx } = setup(async (_u, init) => {
      seen = init;
      return ok([]);
    });
    await ctx.maybeRevealActivity();
    expect(seen.headers.Authorization).toBe("Bearer tok");
  });

  it("names the memory in typographic quotes, and says so when it is gone", async () => {
    const shared = { event: "shared", kind: "entry", actor: "Ada", subject: null, entryId: "e1" };
    const { ctx, els } = setup(async () => ok([memberRow(0, { ...shared, title: "Quarterly plan" })]));
    await ctx.maybeRevealActivity();
    let html = els.get("activity-list").innerHTML as string;
    expect(html).toContain("Shared a memory with the team");
    expect(html).toContain("“Quarterly plan”");

    const gone = setup(async () => ok([memberRow(0, { ...shared, title: null })]));
    await gone.ctx.maybeRevealActivity();
    html = gone.els.get("activity-list").innerHTML as string;
    expect(html).toContain("Memory no longer readable");
    expect(html).not.toContain("null");
  });

  it("names a removed account rather than printing nothing", async () => {
    const { ctx, els } = setup(async () =>
      ok([memberRow(0, { actor: null, event: "member_removed", subject: "Bob" })]),
    );
    await ctx.maybeRevealActivity();
    const html = els.get("activity-list").innerHTML as string;
    expect(html).toContain("Removed account");
    expect(html).toContain("Removed a member");
  });

  it("escapes a name that is trying to be markup", async () => {
    const { ctx, els } = setup(async () =>
      ok([memberRow(0, { actor: "<img src=x onerror=alert(1)>", subject: null })]),
    );
    await ctx.maybeRevealActivity();
    expect(els.get("activity-list").innerHTML).not.toContain("<img");
  });

  it("appends the second page in server order rather than replacing the first", async () => {
    const { ctx, els, calls } = setup(async (url) =>
      ok(url.includes("offset=50") ? page(7, 50) : page(50, 0)),
    );
    await ctx.maybeRevealActivity();
    ctx.loadMoreActivity(els.get("activity-more"));
    await flush();
    expect(calls).toEqual([
      "http://localhost/team/activity?limit=50&offset=0",
      "http://localhost/team/activity?limit=50&offset=50",
    ]);
    const lines = (els.get("activity-list").innerHTML as string).match(
      /<div class="activity-line">[^<]*<\/div>/g,
    ) as string[];
    // First and last, not a count of names: an append that replaced would
    // still be a list, and a re-sort would still be 57 rows long.
    expect(lines.length).toBe(57);
    expect(lines[0]).toContain("Bob 0");
    expect(lines[56]).toContain("Bob 56");
  });

  it("shows the Show-more button on a full page and hides it on a short one", async () => {
    const full = setup(async () => ok(page(50)));
    await full.ctx.maybeRevealActivity();
    expect(full.els.get("activity-more").hidden).toBe(false);
    expect(full.els.get("activity-more").textContent).toBe("Show more");

    const short = setup(async () => ok(page(49)));
    await short.ctx.maybeRevealActivity();
    expect(short.els.get("activity-more").hidden).toBe(true);
  });

  it("says an empty team is empty and hides the button", async () => {
    const { ctx, els } = setup(async () => ok([]));
    await ctx.maybeRevealActivity();
    expect(els.get("activity-list").innerHTML).toContain("Nothing has happened on this team yet.");
    expect(els.get("activity-more").hidden).toBe(true);
  });

  it("states a cold failure in the list", async () => {
    const { ctx, els } = setup(async () => {
      throw new Error("offline");
    });
    await ctx.maybeRevealActivity();
    expect(els.get("activity-list").innerHTML).toContain("Could not load the activity log.");
  });

  it("keeps the rows and re-enables the button when an append fails", async () => {
    let first = true;
    const { ctx, els } = setup(async () => {
      if (first) {
        first = false;
        return ok(page(50));
      }
      throw new Error("offline");
    });
    await ctx.maybeRevealActivity();
    const before = els.get("activity-list").innerHTML;
    ctx.loadMoreActivity(els.get("activity-more"));
    await flush();
    expect(els.get("activity-list").innerHTML).toBe(before);
    // A Show-more left disabled is a control that says there is more and then
    // refuses to fetch it.
    expect(els.get("activity-more").disabled).toBe(false);
    expect(els.get("activity-more").textContent).toBe("Show more");
  });

  it("a solo brain hides the section and issues no request", async () => {
    const { ctx, els, calls } = setup(
      async () => {
        throw new Error("a solo brain must not reach the network");
      },
      { teamMode: false },
    );
    await ctx.maybeRevealActivity();
    expect(els.get("team-activity").style.display).toBe("none");
    expect(calls).toEqual([]);
    expect(els.get("activity-list").innerHTML).toBe("");
  });

  it("flips back to hidden when TEAM_MODE goes false after a team render", async () => {
    const { ctx, els, calls } = setup(async () => ok(page(2)));
    await ctx.maybeRevealActivity();
    expect(els.get("team-activity").style.display).toBe("");
    vm.runInContext("TEAM_MODE = false", ctx);
    await ctx.maybeRevealActivity();
    expect(els.get("team-activity").style.display).toBe("none");
    expect(calls.length).toBe(1);
  });

  it("speaks Italian", async () => {
    const { ctx, els } = setup(
      async () => ok([memberRow(0, { event: "member_removed", actor: "Ada", subject: "Bob" })]),
      { locale: "it" },
    );
    expect(ctx.t("activity.intro")).toBe(
      "Chi ha cambiato cosa, dal più recente. Conservato come registro: nulla di ciò che vedi qui è modificabile.",
    );
    await ctx.maybeRevealActivity();
    expect(els.get("activity-list").innerHTML).toContain("Ha rimosso una persona");
  });

  it("falls back to the raw event name for a kind it has never heard of", async () => {
    const { ctx, els } = setup(async () => ok([memberRow(0, { event: "moon_landed" })]));
    await ctx.maybeRevealActivity();
    expect(els.get("activity-list").innerHTML).toContain("moon_landed");
  });

  it("is wired into index.html and the switchTab reveal", () => {
    const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
    expect(html).toContain('<script src="js/activity.js"></script>');
    expect(html).toContain('id="team-activity"');
    expect(html).toContain("loadMoreActivity(this)");
    const nav = readFileSync(resolve(ROOT, "public/js/nav.js"), "utf8");
    expect(nav).toContain("maybeRevealActivity");
  });
});
