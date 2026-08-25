/**
 * Team panel: admin detection via GET /team/members, roster rendering, and the
 * one-time token reveal. Same fake-DOM + vm approach as dashboard-modules.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js and team.js, in the order the page loads them. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/team.js",
]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

function makeEl() {
  return {
    id: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    dataset: {},
  };
}

const TEAM_ELEMENT_IDS = [
  "sb-tab-team",
  "tab-team",
  "team-admins-only",
  "team-body",
  "team-list",
  "team-token-reveal",
  "team-token-for",
  "team-token-value",
  "team-copy-btn",
  "team-add-name",
  "team-add-email",
  "team-add-role",
  "team-add-btn",
  "team-add-error",
];

function setup(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const elements = new Map<string, any>();
  // Elements that ship hidden in index.html start with display:none here too.
  const SHIPS_HIDDEN = new Set([
    "sb-tab-team",
    "tab-team",
    "team-admins-only",
    "team-body",
    "team-token-reveal",
    "team-add-error",
  ]);
  for (const id of TEAM_ELEMENT_IDS) {
    const el = makeEl();
    el.id = id;
    if (SHIPS_HIDDEN.has(id)) el.style.display = "none";
    elements.set(id, el);
  }
  const doc = {
    documentElement: { lang: "en" },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getElementById: (id?: string) => elements.get(id ?? "") ?? makeEl(),
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
    fetch: fetchImpl,
    confirm: () => true,
    alert: () => {},
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // The page connects before anything team-related can run. These are top-level
  // `let` bindings in state.js, so they must be assigned in-context rather than
  // set as sandbox properties.
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"`, ctx);
  ctx.initI18n("en");
  return { ctx, els: elements };
}

const ADMIN_OK = {
  ok: true,
  you: "u1",
  members: [
    { userId: "u1", name: "Ada", email: "ada@example.com", role: "admin", suspended: false, privateEntries: 12 },
    { userId: "u2", name: "Bob", email: "bob@example.com", role: "member", suspended: false, privateEntries: 1 },
  ],
};

function jsonFetch(routes: Array<{ match: (url: string, init?: any) => boolean; reply: (url: string, init?: any) => any }>) {
  return async (url: string, init?: any) => {
    for (const r of routes) {
      if (r.match(url, init)) return r.reply(url, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

describe("team panel", () => {
  it("exposes every inline handler the markup calls", () => {
    const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
    for (const fn of ["submitNewMember", "copyTeamToken", "closeTeamTokenReveal"]) {
      expect(html).toContain(fn);
    }
    // rotateTeamToken / setTeamSuspended are referenced only from rows the
    // module renders, so they are checked as globals on the sandbox instead.
    const { ctx } = setup(async () => ({ ok: true, status: 200, json: async () => ADMIN_OK }));
    for (const fn of ["loadTeam", "rotateTeamToken", "setTeamSuspended"]) {
      expect(typeof ctx[fn], `${fn} should be a function`).toBe("function");
    }
  });

  it("shows the nav and renders the roster for an admin, with no self-actions", async () => {
    const { ctx, els } = setup(
      jsonFetch([{ match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) }]),
    );
    await ctx.loadTeam();
    expect(els.get("sb-tab-team").style.display).toBe("");
    expect(els.get("tab-team").style.display).toBe("");
    expect(els.get("team-admins-only").style.display).toBe("none");
    const html = els.get("team-list").innerHTML as string;
    expect(html).toContain("ada@example.com");
    expect(html).toContain("bob@example.com");
    // Role badges and the private-entry count, pluralized.
    expect(html).toContain("Admin");
    expect(html).toContain("12 private entries");
    expect(html).toContain("1 private entry");
    // Only Bob is actionable — no Rotate/Suspend on your own row.
    expect(html.match(/rotateTeamToken\('u/g)?.length).toBe(1);
    expect(html).not.toContain("rotateTeamToken('u1')");
  });

  it("hides the nav and shows the quiet notice on 403", async () => {
    const { ctx, els } = setup(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: "Forbidden" }) }));
    await ctx.loadTeam();
    expect(els.get("sb-tab-team").style.display).toBe("none");
    expect(els.get("tab-team").style.display).toBe("none");
    expect(els.get("team-admins-only").style.display).toBe("");
    expect(els.get("team-body").style.display).toBe("none");
  });

  it("hides the nav on 401 too", async () => {
    const { ctx, els } = setup(async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: "Unauthorized" }) }));
    await ctx.loadTeam();
    expect(els.get("tab-team").style.display).toBe("none");
    expect(els.get("team-admins-only").style.display).toBe("");
  });

  it("adding a member reveals the one-time token and refetches the roster", async () => {
    let membersCalls = 0;
    const { ctx, els } = setup(
      jsonFetch([
        {
          match: (u, i) => u.endsWith("/team/members") && i?.method === "POST",
          reply: () => ({
            ok: true,
            status: 201,
            json: async () => ({ ok: true, member: { userId: "u2", name: "Bob", role: "member" }, token: "one-time-secret" }),
          }),
        },
        {
          match: (u) => u.endsWith("/team/members"),
          reply: () => {
            membersCalls++;
            return { ok: true, status: 200, json: async () => ADMIN_OK };
          },
        },
      ]),
    );
    els.get("team-add-name").value = "Bob";
    els.get("team-add-email").value = "";
    await ctx.submitNewMember();
    expect(membersCalls).toBe(1); // roster refreshed after creation
    expect(els.get("team-token-reveal").style.display).toBe("");
    expect(els.get("team-token-value").textContent).toBe("one-time-secret");
    expect(els.get("team-token-for").textContent).toContain("Bob");
    // Form reset after success.
    expect(els.get("team-add-name").value).toBe("");
  });

  it("surfaces a duplicate email instead of a token", async () => {
    const { ctx, els } = setup(
      jsonFetch([
        {
          match: (u, i) => u.endsWith("/team/members") && i?.method === "POST",
          reply: () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: "duplicate" }) }),
        },
      ]),
    );
    els.get("team-add-name").value = "Bob";
    await ctx.submitNewMember();
    expect(els.get("team-token-reveal").style.display).toBe("none");
    expect(els.get("team-add-error").style.display).toBe("");
    expect((els.get("team-add-error").textContent as string).length).toBeGreaterThan(0);
  });

  it("suspend posts to the suspend endpoint and refreshes", async () => {
    const bodies: any[] = [];
    const { ctx } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/suspend"),
          reply: (_u, i) => {
            bodies.push(JSON.parse(i.body));
            return { ok: true, status: 200, json: async () => ({ ok: true, id: "u2", suspended: true }) };
          },
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    await ctx.loadTeam(); // populate teamMembers so the action can find the row
    await ctx.setTeamSuspended("u2", true);
    expect(bodies).toEqual([{ id: "u2", suspended: true }]);
  });

  it("dismissed token reveal clears the plaintext token", async () => {
    const { ctx, els } = setup(
      jsonFetch([
        {
          match: (u, i) => u.endsWith("/team/members/token"),
          reply: () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: "u2", token: "rotated-secret" }) }),
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    await ctx.loadTeam(); // populate teamMembers so the action can find the row
    await ctx.rotateTeamToken("u2");
    expect(els.get("team-token-reveal").style.display).toBe("");
    ctx.closeTeamTokenReveal();
    expect(els.get("team-token-reveal").style.display).toBe("none");
    expect(els.get("team-token-value").textContent).toBe("");
  });

  it("translates the panel in Italian", async () => {
    const { ctx } = setup(async () => ({ ok: true, status: 200, json: async () => ADMIN_OK }));
    ctx.initI18n("it");
    await ctx.loadTeam();
    expect(ctx.t("team.title")).toBe("Team");
    expect(ctx.t("team.adminsOnly")).toMatch(/amministratori/);
    expect(ctx.tPlural("team.privateEntries", 2)).toBe("2 voci private");
    const html = (ctx.document.getElementById("team-list") as any).innerHTML as string;
    expect(html).toContain("Amministratore");
  });
});
