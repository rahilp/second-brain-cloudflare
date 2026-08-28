/**
 * Team panel: admin detection via GET /team/members, roster rendering, and the
 * one-time token reveal. Same fake-DOM + vm approach as dashboard-modules.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js, toast.js and team.js, in page-load order. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  // Real toast rather than a stub: the team panel reports success and failure
  // through it, and a stub would let a broken call through silently.
  "public/js/toast.js",
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
    // toast.js looks inside the node it just built for an optional action
    // button; a fake element without these throws before the toast is shown.
    querySelector: () => null,
    querySelectorAll: () => [],
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
  "sb-team-name",
  "topbar-team-name",
  "team-name-input",
  "team-name-btn",
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
    "sb-team-name",
    "topbar-team-name",
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
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // The page connects before anything team-related can run. These are top-level
  // `let` bindings in state.js, so they must be assigned in-context rather than
  // set as sandbox properties.
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
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


/**
 * The team's name is the one piece of team UI a MEMBER sees, so it cannot hang
 * off loadTeam() — that probes /team/members, which answers 403 for them. These
 * drive loadTeamName() directly with a member-shaped fetch.
 */
describe("team name", () => {
  const NAMED = { ok: true, admin: false, teams: [{ id: "ws-co", name: "Acme Engineering", memberCount: 3 }] };

  it("renders into the sidebar AND the mobile topbar", async () => {
    // Two renderings of one header; the sidebar is hidden at phone widths, so a
    // member on their phone would otherwise never see which team they are in.
    const { ctx, els } = setup(async () => ({ ok: true, json: async () => NAMED }));
    await ctx.loadTeamName();
    for (const id of ["sb-team-name", "topbar-team-name"]) {
      expect(els.get(id).textContent).toBe("Acme Engineering");
      expect(els.get(id).style.display).toBe("");
    }
  });

  it("shows the name to a member, who cannot load the roster at all", async () => {
    const { ctx, els } = setup(async (url: string) => {
      if (url.includes("/team/workspaces")) return { ok: true, json: async () => NAMED };
      // Exactly what a member gets from the admin probe.
      return { ok: false, status: 403, json: async () => ({ ok: false, error: "Forbidden" }) };
    });
    await ctx.loadTeamName();
    expect(els.get("sb-team-name").textContent).toBe("Acme Engineering");
    expect(els.get("sb-team-name").style.display).toBe("");
  });

  it("stays hidden on a solo brain even when a name comes back", async () => {
    const { ctx, els } = setup(async () => ({ ok: true, json: async () => NAMED }));
    vm.runInContext("TEAM_MODE = false", ctx);
    await ctx.loadTeamName();
    for (const id of ["sb-team-name", "topbar-team-name"]) {
      expect(els.get(id).style.display).toBe("none");
      expect(els.get(id).textContent).toBe("");
    }
  });

  it("re-hides the name if the brain stops being a team", async () => {
    // TEAM_MODE goes false when the last member is removed. A name left on
    // screen would name a team nobody is in.
    const { ctx, els } = setup(async () => ({ ok: true, json: async () => NAMED }));
    await ctx.loadTeamName();
    expect(els.get("sb-team-name").style.display).toBe("");
    vm.runInContext("TEAM_MODE = false", ctx);
    ctx.renderTeamName();
    expect(els.get("sb-team-name").style.display).toBe("none");
  });

  it("an unreachable or unauthorised endpoint leaves no name, not a stale one", async () => {
    const { ctx, els } = setup(async () => { throw new Error("offline"); });
    await ctx.loadTeamName();
    expect(els.get("sb-team-name").textContent).toBe("");
    expect(els.get("sb-team-name").style.display).toBe("none");
  });

  it("saving a new name updates the sidebar without a reload", async () => {
    let sent: any = null;
    const { ctx, els } = setup(async (url: string, init?: any) => {
      if (url.includes("/team/workspaces/rename")) {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, id: "ws-co", name: sent.name }) };
      }
      return { ok: true, json: async () => NAMED };
    });
    await ctx.loadTeamName();
    els.get("team-name-input").value = "  Platform Guild  ";
    await ctx.submitTeamName();
    expect(sent).toEqual({ name: "Platform Guild" });
    expect(els.get("sb-team-name").textContent).toBe("Platform Guild");
  });

  it("refuses to save an empty name", async () => {
    let called = false;
    const { ctx, els } = setup(async (url: string) => {
      if (url.includes("/rename")) { called = true; }
      return { ok: true, json: async () => NAMED };
    });
    await ctx.loadTeamName();
    els.get("team-name-input").value = "   ";
    await ctx.submitTeamName();
    expect(called).toBe(false);
  });
});
