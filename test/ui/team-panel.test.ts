/**
 * Team panel: admin detection via GET /team/members, roster rendering, and the
 * one-time token reveal. Same fake-DOM + vm approach as dashboard-modules.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js, toast.js, confirm-sheet.js and team.js, in page-load order. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  // Real toast rather than a stub: the team panel reports success and failure
  // through it, and a stub would let a broken call through silently.
  "public/js/toast.js",
  // The shared destructive-action sheet. team.js's suspend/remove/rotate
  // flows are built against this documented API rather than confirm().
  "public/js/confirm-sheet.js",
  "public/js/team.js",
]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

function makeEl() {
  const el: any = {
    id: "",
    style: {} as Record<string, string>,
    // Tracks add/remove calls so a test can tell whether the sheet was ever
    // opened, rather than only inspecting its final state.
    classList: {
      calls: [] as Array<[string, string]>,
      add(c: string) {
        el.classList.calls.push(["add", c]);
      },
      remove(c: string) {
        el.classList.calls.push(["remove", c]);
      },
      toggle() {},
    },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    checked: false,
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
  return el;
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
  "confirm-dialog",
  "confirm-title",
  "confirm-body",
  "confirm-accept-btn",
  "confirm-check-row",
  "confirm-check-label",
  "confirm-checkbox",
  "team-invite-copy-btn",
  "team-invite-mail-btn",
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
    "confirm-check-row",
    "team-invite-mail-btn",
  ]);
  for (const id of TEAM_ELEMENT_IDS) {
    const el = makeEl();
    el.id = id;
    if (SHIPS_HIDDEN.has(id)) el.style.display = "none";
    elements.set(id, el);
  }
  // Elements toast.js creates on demand (id "app-toast") are NOT pre-registered,
  // so getElementById must return null for them the first time — a fallback
  // dummy element here would silently swallow the toast's real DOM write and
  // this test group exists specifically to observe that write.
  const appended: any[] = [];
  const copied: string[] = [];
  const doc = {
    documentElement: { lang: "en" },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getElementById: (id?: string) => elements.get(id ?? "") ?? null,
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild: (el: any) => { appended.push(el); } },
  };
  const ctx: any = {
    console,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {
      language: "en-US",
      clipboard: {
        writeText: (s: string) => {
          copied.push(s);
        },
      },
    },
    fetch: fetchImpl,
    // team.js's suspend/remove/rotate flows must never reach for the
    // browser's native dialog — the sheet from confirm-sheet.js replaces it.
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {},
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  ctx.location = { href: "" };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // The page connects before anything team-related can run. These are top-level
  // `let` bindings in state.js, so they must be assigned in-context rather than
  // set as sandbox properties.
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
  ctx.initI18n("en");
  return { ctx, els: elements, appended, copied };
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

  describe("last used", () => {
    /** Renders the roster with these members and hands back the markup. */
    async function roster(members: unknown[]) {
      const { ctx, els } = setup(
        jsonFetch([{
          match: (u) => u.endsWith("/team/members"),
          reply: () => ({ ok: true, status: 200, json: async () => ({ ok: true, you: "u1", members }) }),
        }]),
      );
      await ctx.loadTeam();
      return els.get("team-list").innerHTML as string;
    }

    const member = (over: Record<string, unknown> = {}) => ({
      userId: "u2", name: "Bob", email: "bob@example.com", role: "member",
      suspended: false, privateEntries: 1, ...over,
    });

    it("reports how long ago a member's token last resolved", async () => {
      const html = await roster([member({ lastUsedAt: Date.now() - 3 * 3600_000 })]);
      expect(html).toContain("Last used 3h ago");
    });

    it("says Never used for a member who has not authenticated since the column shipped", async () => {
      expect(await roster([member({ lastUsedAt: null })])).toContain("Never used");
    });

    it("says Never used rather than a bogus date for a zero or absent timestamp", async () => {
      // 0 is what an accidental COALESCE would produce, and undefined is what an
      // older Worker sends. Neither may render as 1 January 1970.
      expect(await roster([member({ lastUsedAt: 0 })])).toContain("Never used");
      const absent = await roster([member()]);
      expect(absent).toContain("Never used");
      expect(absent).not.toMatch(/1970/);
    });

    it("keeps it beside the private-entry count rather than replacing it", async () => {
      const html = await roster([member({ lastUsedAt: Date.now() - 90_000 })]);
      expect(html).toContain("1 private entry · Last used 2m ago");
    });
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

  /** Adds Bob (email optional) and returns the harness so a test can act on the reveal. */
  function addBob(email: string) {
    const harness = setup(
      jsonFetch([
        {
          match: (u, i) => u.endsWith("/team/members") && i?.method === "POST",
          reply: () => ({
            ok: true,
            status: 201,
            json: async () => ({ ok: true, member: { userId: "u2", name: "Bob", role: "member" }, token: "one-time-secret" }),
          }),
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    harness.els.get("team-add-name").value = "Bob";
    harness.els.get("team-add-email").value = email;
    return harness;
  }

  it("copying the invite message writes Bob's name, the worker URL and the one-time token", async () => {
    const { ctx, copied } = addBob("bob@example.com");
    await ctx.submitNewMember();
    ctx.copyInviteMessage();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("Bob");
    expect(copied[0]).toContain("http://localhost");
    expect(copied[0]).toContain("one-time-secret");
    expect(copied[0]).toContain("stays personal");
  });

  it("shows the mail button only when the new member has an email", async () => {
    const withEmail = addBob("bob@example.com");
    await withEmail.ctx.submitNewMember();
    expect(withEmail.els.get("team-invite-mail-btn").style.display).toBe("");

    const withoutEmail = addBob("");
    await withoutEmail.ctx.submitNewMember();
    expect(withoutEmail.els.get("team-invite-mail-btn").style.display).toBe("none");
  });

  it("emailing the invite opens a mailto: link addressed to the new member with the invite body", async () => {
    const { ctx } = addBob("bob@example.com");
    await ctx.submitNewMember();
    ctx.emailInvite();
    expect(ctx.window.location.href).toMatch(/^mailto:bob%40example\.com\?subject=/);
    const url = new URL(ctx.window.location.href.replace(/^mailto:/, "http://x?"));
    expect(url.searchParams.get("body")).toBe(ctx.inviteMessage());
  });

  it("dismissing the token reveal drops the token, so copying afterwards writes nothing", async () => {
    const { ctx, copied } = addBob("bob@example.com");
    await ctx.submitNewMember();
    ctx.closeTeamTokenReveal();
    ctx.copyInviteMessage();
    expect(copied).toHaveLength(0);
  });

  it("the invite message is translated in Italian — impossible when the admin wrote it by hand", async () => {
    const { ctx, copied } = addBob("bob@example.com");
    ctx.initI18n("it");
    await ctx.submitNewMember();
    ctx.copyInviteMessage();
    expect(copied[0]).toContain("Second Brain condiviso");
    expect(copied[0]).toContain("Incolla questo token");
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
    await ctx.runConfirmAction();
    expect(bodies).toEqual([{ id: "u2", suspended: true }]);
  });

  it("suspending fills the sheet body with the member's name and waits for confirmation", async () => {
    const bodies: any[] = [];
    const { ctx, els } = setup(
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
    await ctx.loadTeam();
    await ctx.setTeamSuspended("u2", true);
    expect(els.get("confirm-body").textContent).toContain("Bob");
    expect(bodies).toEqual([]); // no POST until the sheet is confirmed
    await ctx.runConfirmAction();
    expect(bodies).toEqual([{ id: "u2", suspended: true }]);
  });

  it("restoring posts immediately, opens no sheet, and reports success via toast", async () => {
    const bodies: any[] = [];
    const { ctx, els, appended } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/suspend"),
          reply: (_u, i) => {
            bodies.push(JSON.parse(i.body));
            return { ok: true, status: 200, json: async () => ({ ok: true, id: "u2", suspended: false }) };
          },
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    await ctx.loadTeam();
    await ctx.setTeamSuspended("u2", false);
    expect(bodies).toEqual([{ id: "u2", suspended: false }]);
    expect(els.get("confirm-dialog").classList.calls).not.toContainEqual(["add", "open"]);
    expect(appended[appended.length - 1].innerHTML).toContain("Access restored");
  });

  it("removing a member puts the private-entry count into the sheet body", async () => {
    const { ctx, els } = setup(
      jsonFetch([{ match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) }]),
    );
    await ctx.loadTeam();
    await ctx.removeTeamMember("u2");
    expect(els.get("confirm-body").textContent).toContain("Bob");
    expect(els.get("confirm-body").textContent).toContain("1");
  });

  it("rotating a member's token in Italian shows the Italian sheet title — impossible with the native confirm()", async () => {
    const { ctx, els } = setup(
      jsonFetch([{ match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) }]),
    );
    ctx.initI18n("it");
    await ctx.loadTeam();
    await ctx.rotateTeamToken("u2");
    expect(els.get("confirm-title").textContent).toBe("Reimpostare il token di questa persona?");
  });

  it("a failing action reports through the toast, never alert", async () => {
    const { ctx, appended } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/suspend"),
          reply: () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) }),
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    ctx.alert = () => {
      throw new Error("alert() must not be used");
    };
    await ctx.loadTeam();
    await ctx.setTeamSuspended("u2", true);
    await ctx.runConfirmAction();
    expect(appended[appended.length - 1].innerHTML).toContain("boom");
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
    await ctx.runConfirmAction();
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
