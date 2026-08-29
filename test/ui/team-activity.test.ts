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
  // #team-activity ships display:none in public/index.html — its own gate, not
  // the one it inherits from #team-body, which team.js reveals for a solo
  // brain's owner too ("ships hidden, because #team-body is not a gate on a
  // solo brain" below). Mirrored here as the harder starting point as well: a
  // maybeRevealActivity that only ever reveals would pass from a blank style,
  // and the flip-back test below is what actually proves the else-branch.
  // The Show-more button ships hidden until a full page proves there is more.
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

/**
 * A row in the shape GET /team/activity really sends.
 *
 * `at` is EPOCH MILLISECONDS — `at: Number(r.created_at) || 0` at
 * src/routes/admin.ts — and `kind` is 'admin' or 'entry', never 'member'.
 * These fixtures carried an ISO string and "member" until a review found that
 * `new Date(String(row.at))`, which is Invalid Date for every real row, passed
 * the whole suite. A fixture that disagrees with the endpoint it stands in for
 * is a test that cannot see the bug it exists to catch.
 */
const AT_BASE = Date.UTC(2026, 7, 20, 10, 0, 0);

function memberRow(i: number, over: Record<string, unknown> = {}) {
  return {
    at: AT_BASE + i * 60_000,
    event: "member_created",
    actor: `Ada ${i}`,
    subject: `Bob ${i}`,
    kind: "admin",
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

  it("renders the timestamp the endpoint really sends, not a string spelling of it", async () => {
    // `at` arrives as epoch milliseconds. `new Date(1760000000000)` is a date;
    // `new Date(String(1760000000000))` is Invalid Date — and the whole suite
    // used to pass with the latter because every fixture sent an ISO string,
    // which parses either way. The cell is asserted here so the number is what
    // has to work.
    const { ctx, els } = setup(async () => ok([memberRow(0)]));
    await ctx.maybeRevealActivity();
    const html = els.get("activity-list").innerHTML as string;
    expect(html).toContain(new Date(AT_BASE).toLocaleString(ctx.localeTag()));
    expect(html).not.toContain("Invalid Date");
  });

  it("leaves the when-cell empty for a row whose clock is missing or unusable", async () => {
    // The export already refuses to guess (activityIsoAt: empty, never a
    // marker word, and never `new Date(null)`'s 1970). The view renders the
    // same rows and must not answer differently — "Invalid Date" is noise in a
    // compliance record and a 1970 date is a false statement in one.
    // Read as the CELL, not as "the page does not contain 1970": epoch 0
    // renders as 1969 west of UTC, so a substring check would have called the
    // most misleading output of all a pass.
    const whenCell = (html: string) =>
      (html.match(/<div class="activity-when">([\s\S]*?)<\/div>/) as RegExpMatchArray)[1];

    for (const at of [null, undefined, "", "not a date", NaN, 0]) {
      const { ctx, els } = setup(async () => ok([memberRow(0, { at })]));
      await ctx.maybeRevealActivity();
      const html = els.get("activity-list").innerHTML as string;
      expect(whenCell(html), `at=${String(at)}`).toBe("");
      // The row itself still renders — one unusable cell is not a reason to
      // drop the sentence an auditor came for.
      expect(html).toContain("Added a member");
    }
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

  it("ships hidden, because #team-body is not a gate on a solo brain", () => {
    // The section's containing panel is NOT enough on its own. #team-body is
    // display:none in the markup, but team.js reveals it for anyone GET
    // /team/members answers 200 for — and on a SOLO brain that is the owner:
    // src/lib/tenancy.ts hashes AUTH_TOKEN into a users row with role 'admin'.
    //
    // switchTab('team') then puts that panel on screen SYNCHRONOUSLY and only
    // calls maybeRevealActivity once the roster probe has come back (js/nav.js),
    // so with no inline display:none a solo owner reads "Recent activity", its
    // intro sentence and an Export CSV button for a whole network round trip —
    // and can press the button, which pages GET /team/activity up to twenty
    // times. A probe that never settles leaves it there for good.
    //
    // This is the producing half of the gate. maybeRevealActivity's own
    // assignment is pinned by the reveal/flip-back cases above; neither pin
    // survives the other's deletion.
    const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
    const open = html.match(/<div id="team-activity"[^>]*>/)?.[0] ?? "";
    expect(open, "#team-activity must ship hidden").toContain("display: none");
  });

  it("pages on the page size, never on a count the feed does not send", async () => {
    // { ok, events, limit, offset } — there is no `total` in the response, so
    // a Show-more that read one would be reading undefined. A full page means
    // "ask again"; a short page means "that was the end".
    const withTotal = (events: any[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, limit: 50, offset: 0, total: 1, events }),
    });
    const full = setup(async () => withTotal(page(50)));
    await full.ctx.maybeRevealActivity();
    expect(full.els.get("activity-more").hidden).toBe(false);

    const short = setup(async () => withTotal(page(2)));
    await short.ctx.maybeRevealActivity();
    expect(short.els.get("activity-more").hidden).toBe(true);
  });

  it("states a failure rather than an empty team when the body is not a feed", async () => {
    // The view and the export run the SAME check, so neither can decide on its
    // own that a wrong-shaped 200 means "nothing has happened on this team".
    for (const body of [{ ok: false }, { ok: true, activity: [] }, { ok: true, events: null }]) {
      const { ctx, els } = setup(async () => ({ ok: true, status: 200, json: async () => body }));
      await ctx.maybeRevealActivity();
      const html = els.get("activity-list").innerHTML as string;
      expect(html, JSON.stringify(body)).toContain("Could not load the activity log.");
      expect(html, JSON.stringify(body)).not.toContain("Nothing has happened");
    }
  });

  it("keeps the row list an array, so the next tab switch does not throw", async () => {
    // THE GUARD'S OWN BEHAVIOUR, and not the outer catch's. Both are reachable
    // from a wrong-shaped 200, and both produce the same failure line — which
    // is why deleting `activityEventsFrom`'s throw used to pass the whole
    // suite. What only the guard does is stop `activityRows` being assigned
    // the malformed value: with it gone, `{ ok: true, events: null }` makes
    // activityRows null, and the NEXT maybeRevealActivity reads
    // `activityRows.length` OUTSIDE any try/catch, synchronously, from
    // switchTab. That is a broken Team tab, not a failed feed.
    for (const body of [{ ok: true, events: null }, { ok: true }, { ok: true, events: "nope" }]) {
      const { ctx, els } = setup(async () => ({ ok: true, status: 200, json: async () => body }));
      await ctx.maybeRevealActivity();
      expect(els.get("activity-list").innerHTML, JSON.stringify(body))
        .toContain("Could not load the activity log.");
      expect(vm.runInContext("Array.isArray(activityRows)", ctx), JSON.stringify(body)).toBe(true);
      expect(() => ctx.maybeRevealActivity(), JSON.stringify(body)).not.toThrow();
      await flush();
    }
  });

  it("does not ask for the feed at all once the roster probe has said not-an-admin", async () => {
    // GET /team/activity is requireAdmin: for a member it can only ever be a
    // 403, one per Team-tab visit. team.js's probe has already answered the
    // question by the time this runs, so the request is simply not made.
    const { ctx, els, calls } = setup(async () => {
      throw new Error("a member must not reach the network");
    });
    vm.runInContext("var teamIsAdmin = false", ctx);
    await ctx.maybeRevealActivity();
    expect(calls).toEqual([]);
    expect(els.get("team-activity").style.display).toBe("none");
  });

  it("still loads when the probe says admin, and when it has not answered yet", async () => {
    // Only a positive "no" stands the feed down. An unanswered probe behaves
    // exactly as before rather than silently showing an admin nothing.
    const yes = setup(async () => ok(page(2)));
    vm.runInContext("var teamIsAdmin = true", yes.ctx);
    await yes.ctx.maybeRevealActivity();
    expect(yes.calls).toHaveLength(1);

    const unknown = setup(async () => ok(page(2)));
    vm.runInContext("var teamIsAdmin = null", unknown.ctx);
    await unknown.ctx.maybeRevealActivity();
    expect(unknown.calls).toHaveLength(1);
  });
});

/**
 * switchTab's half of the same question.
 *
 * The gate above only helps if the answer has arrived by the time the reveal
 * runs, so this loads js/nav.js for real and drives switchTab('team') with a
 * stubbed loadTeam — the probe — resolving a tick later.
 */
describe("the Team tab's activity reveal", () => {
  const NAV_SRC = [
    "public/utils.js",
    "public/js/i18n.js",
    "public/js/state.js",
    "public/js/activity.js",
    "public/js/nav.js",
  ]
    .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
    .join("\n");

  function setupNav(admitAdmin: boolean) {
    const elements = new Map<string, any>();
    const calls: string[] = [];
    const doc: any = {
      documentElement: { lang: "en" },
      querySelector: () => null,
      querySelectorAll: () => [],
      // switchTab reaches for screen-*/tab-* too, so unknown ids are created
      // rather than returning null and throwing on .classList.
      getElementById: (id?: string) => {
        const key = id ?? "";
        if (!elements.has(key)) {
          const el = makeEl();
          el.id = key;
          elements.set(key, el);
        }
        return elements.get(key);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      removeEventListener() {},
      body: { style: {}, appendChild() {} },
    };
    const ctx: any = {
      console,
      document: doc,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: "en-US" },
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve(ok([]));
      },
      setTimeout,
      clearTimeout,
      module: undefined,
      exports: undefined,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(NAV_SRC, ctx);
    vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
    // team.js is not loaded: its two globals stand in for the probe, exactly as
    // the concatenated page would have them.
    vm.runInContext(
      `var teamIsAdmin = null;
       var refreshIfStale = () => {};
       var loadTeam = () => new Promise((r) => setTimeout(() => { teamIsAdmin = ${admitAdmin}; r() }, 0))`,
      ctx,
    );
    ctx.initI18n("en");
    return { ctx, calls };
  }

  it("asks for the feed after the probe says admin", async () => {
    const { ctx, calls } = setupNav(true);
    ctx.switchTab("team");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual(["http://localhost/team/activity?limit=50&offset=0"]);
  });

  it("never asks for it when the probe says member — not even on the first visit", async () => {
    // The whole point of waiting: fired alongside loadTeam, this request goes
    // out before the answer exists and is a 403 on every single Team-tab visit.
    const { ctx, calls } = setupNav(false);
    ctx.switchTab("team");
    await new Promise((r) => setTimeout(r, 5));
    ctx.switchTab("home");
    ctx.switchTab("team");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([]);
  });
});

/**
 * The event vocabulary, pinned against its source of truth.
 *
 * GET /team/activity's admin arm has NO event filter — every `admin_events`
 * row is returned — so the moment `AdminEventName` grows a name, that name is
 * in front of this UI with no route change at all. That union is therefore
 * parsed live out of src/, and a name the route can admit but the map cannot
 * label fails HERE rather than as an unlabelled row in someone's browser.
 *
 * The entry arm does filter, and that filter lives in the route handler. It is
 * read directly out of the route's own `event IN (…)` clause below, as
 * ENTRY_EVENTS_IN_FEED, so both arms of the feed are anchored to source rather
 * than to a copy of it.
 */
describe("the activity feed's event vocabulary", () => {
  /** Members of a TypeScript string-literal union, read out of src/. */
  function tsUnionMembers(file: string, name: string): string[] {
    const src = readFileSync(resolve(ROOT, file), "utf8");
    const m = src.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
    if (!m) throw new Error(`${name} not found in ${file}`);
    const members = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    if (members.length === 0) throw new Error(`${name} in ${file} parsed to nothing`);
    return members;
  }

  /** The event name → i18n key map inside activityEventLabel(), really read. */
  function uiEventKeys(): Record<string, string> {
    const src = readFileSync(resolve(ROOT, "public/js/activity.js"), "utf8");
    const body = src.match(/function activityEventLabel\([\s\S]*?const keys = \{([\s\S]*?)\n {2}\}/);
    if (!body) throw new Error("activityEventLabel's map not found in public/js/activity.js");
    const out: Record<string, string> = {};
    for (const m of body[1].matchAll(/([a-z_]+):\s*'([^']+)'/g)) out[m[1]] = m[2];
    if (Object.keys(out).length < 12) throw new Error("activityEventLabel's map parsed to nothing");
    return out;
  }

  /**
   * The entry-arm names the route's `event IN (…)` really admits, read out of
   * the handler itself.
   *
   * Both arms are now anchored to source: the admin arm to AdminEventName, this
   * one to the clause that filters it. Nothing in this chain is a copy of a
   * name, so adding an event to the route without teaching the UI to label it
   * fails here rather than rendering a blank row in front of an auditor.
   */
  function routeEntryEvents(): string[] {
    const src = readFileSync(resolve(ROOT, "src/routes/admin.ts"), "utf8");
    const m = src.match(/WHERE ev\.event IN \(([^)]*)\)/);
    if (!m) throw new Error("the entry-arm event filter was not found in src/routes/admin.ts");
    const names = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    if (names.length === 0) throw new Error("the entry-arm event filter parsed to nothing");
    return names;
  }

  const ENTRY_EVENTS_IN_FEED = routeEntryEvents();

  /**
   * Every name the endpoint can put in front of this UI: the admin arm's whole
   * union, plus the entry arm's filtered set. Both halves are parsed out of
   * src/ on every run, so there is no hand-maintained list here to go stale.
   */
  const admitted = () => [
    ...new Set([
      ...tsUnionMembers("src/lib/admin-audit.ts", "AdminEventName"),
      ...ENTRY_EVENTS_IN_FEED,
    ]),
  ];

  it("can label every event name the endpoint is able to admit", () => {
    const labelled = new Set(Object.keys(uiEventKeys()));
    const missing = admitted().filter((e) => !labelled.has(e));
    expect(missing, "event names the route can send that the UI cannot label").toEqual([]);
  });

  it("labels nothing the endpoint cannot send", () => {
    // The other direction: an orphan label is a dead i18n key in two catalogs
    // and a sentence no one will ever read.
    const admittedSet = new Set(admitted());
    const orphans = Object.keys(uiEventKeys()).filter((e) => !admittedSet.has(e));
    expect(orphans, "labels for event names the route never sends").toEqual([]);
  });

  it("holds the admitted set at the size the endpoint's two arms produce", () => {
    // Ten AdminEventName + four entry-arm names. Deliberately pinned: a name
    // arriving in src/ has to be a decision taken here, in the same commit
    // that gives it a sentence in both catalogs.
    expect(admitted()).toHaveLength(14);
  });

  it("keeps the entry-arm names it lists anchored to EntryEventName", () => {
    const declared = new Set(tsUnionMembers("src/lib/audit.ts", "EntryEventName"));
    const unanchored = ENTRY_EVENTS_IN_FEED.filter((e) => !declared.has(e));
    expect(unanchored, "entry events the feed lists that src/ no longer declares").toEqual([]);
    // The two that are anchored today really are, so a rename in src/ trips it.
    expect(declared.has("shared") && declared.has("unshared")).toBe(true);
  });

  it("has a sentence for every label, in both catalogs", () => {
    // The failure the catalog→call-site orphan check cannot see: that check
    // licenses the whole `activity.ev` prefix, so a map entry pointing at a key
    // NOBODY declared would sail through it and render its own key name.
    const keys = Object.values(uiEventKeys());
    for (const locale of ["en", "it"] as const) {
      const { ctx } = setup(async () => ok([]), { locale });
      for (const key of keys) {
        expect(ctx.t(key), `${locale} ${key}`).not.toBe(key);
        expect(String(ctx.t(key)).trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("renders an unknown name honestly rather than dropping the row", async () => {
    // Any AdminEventName added later reaches this UI with no route change, so
    // "unknown" is a permanent state, not a transitional one.
    const { ctx, els } = setup(async () => ok([memberRow(0, { event: "member_teleported" })]));
    await ctx.maybeRevealActivity();
    const html = els.get("activity-list").innerHTML as string;
    expect(html).toContain("member_teleported");
    expect((html.match(/class="activity-row"/g) ?? []).length).toBe(1);
  });
});
