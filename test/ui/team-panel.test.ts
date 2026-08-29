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
    // opened, rather than only inspecting its final state — and the live set
    // too, because the sheet reads `contains('open')` to decide whether it is
    // taking focus from the page or from a question it is replacing.
    classList: {
      calls: [] as Array<[string, string]>,
      names: new Set<string>(),
      add(c: string) {
        el.classList.calls.push(["add", c]);
        el.classList.names.add(c);
      },
      remove(c: string) {
        el.classList.calls.push(["remove", c]);
        el.classList.names.delete(c);
      },
      toggle(c: string, on?: boolean) {
        if (on ?? !el.classList.names.has(c)) el.classList.add(c);
        else el.classList.remove(c);
      },
      contains: (c: string) => el.classList.names.has(c),
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
  "team-member-view",
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
  "team-org-default",
];

function setup(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const elements = new Map<string, any>();
  // Elements that ship hidden in index.html start with display:none here too.
  const SHIPS_HIDDEN = new Set([
    "sb-tab-team",
    "tab-team",
    "team-admins-only",
    "team-body",
    "team-member-view",
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

  /**
   * A native confirm() is modal — it structurally cannot be double-submitted.
   * The sheet is not, so a double-click (or two calls landing back to back)
   * can fire two POSTs whose responses race. The guard lives in
   * runConfirmAction (confirm-sheet.js), not in team.js, but this asserts the
   * OUTCOME the member actually cares about: only one request ever goes out,
   * regardless of which layer enforces that.
   */
  it("a second confirm while a token rotation is in flight issues no second POST", async () => {
    let tokenCalls = 0;
    let resolveToken: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveToken = resolve;
    });
    const { ctx, els } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/token"),
          reply: () => {
            tokenCalls++;
            return pending;
          },
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    await ctx.loadTeam();
    await ctx.rotateTeamToken("u2");
    const first = ctx.runConfirmAction();
    const second = ctx.runConfirmAction(); // fired before the first POST resolves
    // The caller's own progress copy, shown for the duration of the request.
    expect(els.get("confirm-accept-btn").textContent).toBe("Resetting…");
    resolveToken({ ok: true, status: 200, json: async () => ({ ok: true, id: "u2", token: "rotated-secret" }) });
    await Promise.all([first, second]);
    expect(tokenCalls).toBe(1);
  });

  it("a second confirm while a removal is in flight issues no second POST", async () => {
    let removeCalls = 0;
    let resolveRemove: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveRemove = resolve;
    });
    const { ctx } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/remove"),
          reply: () => {
            removeCalls++;
            return pending;
          },
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    await ctx.loadTeam();
    await ctx.removeTeamMember("u2");
    const first = ctx.runConfirmAction();
    const second = ctx.runConfirmAction();
    resolveRemove({ ok: true, status: 200, json: async () => ({ ok: true, id: "u2" }) });
    await Promise.all([first, second]);
    expect(removeCalls).toBe(1);
  });

  it("a failing remove reports through the toast, never alert", async () => {
    const { ctx, appended } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/remove"),
          reply: () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "remove-boom" }) }),
        },
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
      ]),
    );
    ctx.alert = () => {
      throw new Error("alert() must not be used");
    };
    await ctx.loadTeam();
    await ctx.removeTeamMember("u2");
    await ctx.runConfirmAction();
    expect(appended[appended.length - 1].innerHTML).toContain("remove-boom");
  });

  it("a failing capture-default change reports through the toast (never alert) and reloads the roster", async () => {
    let membersCalls = 0;
    const { ctx, appended } = setup(
      jsonFetch([
        {
          match: (u) => u.endsWith("/team/members/default-share"),
          reply: () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "share-boom" }) }),
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
    ctx.alert = () => {
      throw new Error("alert() must not be used");
    };
    await ctx.loadTeam(); // membersCalls === 1
    await ctx.setMemberDefaultShare("u2", "company");
    expect(appended[appended.length - 1].innerHTML).toContain("share-boom");
    expect(membersCalls).toBe(2); // reloaded after the failure
  });

  it("loads the org-wide capture default alongside the roster", async () => {
    const { ctx, els } = setup(
      jsonFetch([
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
        {
          match: (u) => u.endsWith("/config"),
          reply: () => ({ ok: true, status: 200, json: async () => ({ config: { TEAM_DEFAULT_WORKSPACE: "company" } }) }),
        },
      ]),
    );
    await ctx.loadTeam();
    // renderTeam() kicks this off without awaiting it (it is a secondary
    // fetch, not part of the roster response) — await it directly rather
    // than racing loadTeam()'s own promise.
    await ctx.loadTeamOrgDefault();
    expect(els.get("team-org-default").value).toBe("company");
  });

  it("a failing org-default change reports through the toast (never alert) and reloads the previous value", async () => {
    const { ctx, els, appended } = setup(
      jsonFetch([
        { match: (u) => u.endsWith("/team/members"), reply: () => ({ ok: true, status: 200, json: async () => ADMIN_OK }) },
        {
          match: (u, i) => u.endsWith("/config") && i?.method === "PATCH",
          reply: () => ({ ok: false, status: 500, json: async () => ({}) }),
        },
        {
          match: (u) => u.endsWith("/config"),
          reply: () => ({ ok: true, status: 200, json: async () => ({ config: { TEAM_DEFAULT_WORKSPACE: "personal" } }) }),
        },
      ]),
    );
    ctx.alert = () => {
      throw new Error("alert() must not be used");
    };
    await ctx.loadTeam();
    await ctx.setTeamOrgDefault("company");
    expect(els.get("team-org-default").value).toBe("personal"); // reloaded after failure
    expect(appended[appended.length - 1].innerHTML).toContain("did not work");
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


/**
 * The member half of the Team screen.
 *
 * A member is not an admin, but they ARE on a team, and until now the screen
 * told them only that they were not allowed to look at it. These drive
 * loadTeam() with the fetch shape a member actually gets: 403 from
 * /team/members, 200 from the identity-scoped /team/roster.
 *
 * The negative assertions are the point of this group. /team/roster returns
 * exactly userId, name and role — test/integration/team-roster.test.ts pins
 * `Object.keys(row).sort()` so the endpoint cannot widen by accident — and this
 * is the other half of that guarantee: the UI must not render an equivalent of
 * anything the endpoint withholds, even if the endpoint one day starts sending
 * it.
 */
describe("team member view", () => {
  const ROSTER_OK = {
    ok: true,
    admin: false,
    you: "u2",
    teams: [{ id: "ws-co", name: "Acme Engineering", memberCount: 3 }],
    members: [
      { userId: "u1", name: "Ada", role: "admin" },
      { userId: "u2", name: "Bob", role: "member" },
      { userId: "u3", name: "Cara", role: "member" },
    ],
  };

  /**
   * What a WIDENED /team/roster would send. Every extra field carries a
   * sentinel value found nowhere else in the markup, so if the view ever
   * starts echoing whatever the endpoint happens to return, these fail.
   */
  const ROSTER_WIDENED = {
    ...ROSTER_OK,
    members: ROSTER_OK.members.map((m) => ({
      ...m,
      email: `leak-${m.userId}@example.invalid`,
      privateEntries: 4242,
      lastUsedAt: Date.now() - 3 * 3600_000,
      suspended: true,
      createdAt: 1234567890123,
      personalWorkspaceId: `ws-leak-${m.userId}`,
      defaultShare: "company",
    })),
  };

  /** GET /team/me as Task 9 extended it. `email` is the caller's own and the
   *  server hands it over freely — the Team screen still has no reason to print
   *  it, and the negative test uses it as one more sentinel. */
  const ME = (over: Record<string, unknown> = {}) => ({
    ok: true,
    profile: {
      userId: "u2",
      name: "Bob",
      email: "bob@example.com",
      role: "member",
      defaultShare: "personal",
      orgDefault: "company",
      effectiveDefault: "personal",
      ...over,
    },
  });

  /** A signed-in member: the admin probe refuses, the roster answers. */
  function memberSetup(opts: { roster?: unknown; me?: unknown; rosterStatus?: number } = {}) {
    const seen: string[] = [];
    const status = opts.rosterStatus ?? 200;
    const harness = setup(async (url: string) => {
      seen.push(url);
      if (url.endsWith("/team/members")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "Forbidden" }) };
      }
      if (url.endsWith("/team/roster")) {
        return { ok: status < 400, status, json: async () => opts.roster ?? ROSTER_OK };
      }
      if (url.endsWith("/team/me")) return { ok: true, status: 200, json: async () => opts.me ?? ME() };
      throw new Error(`unexpected fetch ${url}`);
    });
    return { ...harness, seen };
  }

  /** An admin (or a solo brain's owner, who is the bootstrap admin). */
  function adminSetup() {
    const seen: string[] = [];
    const harness = setup(async (url: string) => {
      seen.push(url);
      if (url.endsWith("/team/members")) return { ok: true, status: 200, json: async () => ADMIN_OK };
      if (url.endsWith("/config")) return { ok: true, status: 200, json: async () => ({ config: {} }) };
      throw new Error(`unexpected fetch ${url}`);
    });
    return { ...harness, seen };
  }

  it("renders the team name and everyone on it, with the caller's own row marked", async () => {
    const { ctx, els } = memberSetup();
    await ctx.loadTeam();
    expect(els.get("team-member-view").style.display).toBe("");
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain("Acme Engineering");
    for (const name of ["Ada", "Bob", "Cara"]) expect(html, `${name} should be listed`).toContain(name);
    expect(html).toContain("Admin");
    expect(html).toContain("Member");
    // "you" marks exactly one row, and it is the caller's (you === "u2" === Bob).
    const rows = html.split('class="team-row"');
    expect(rows.filter((r) => r.includes(">you<"))).toHaveLength(1);
    expect(rows.find((r) => r.includes("Bob"))).toContain(">you<");
    expect(rows.find((r) => r.includes("Ada"))).not.toContain(">you<");
    // t() returns the KEY PATH for a key that is missing from the catalog, so a
    // typo would ship as literal "team.somethingWrong" rather than failing.
    expect(html).not.toMatch(/(team|home|common)\.[a-zA-Z]/);
  });

  it("shows a member nothing /team/roster withholds, even if /team/roster starts sending it", async () => {
    const { ctx, els } = memberSetup({ roster: ROSTER_WIDENED });
    await ctx.loadTeam();
    const html = els.get("team-member-view").innerHTML as string;
    // Positive anchor first. Without it every negative below would also hold
    // on a blank screen, which is exactly the state this task started from.
    expect(html).toContain("Acme Engineering");
    for (const name of ["Ada", "Bob", "Cara"]) expect(html).toContain(name);
    // Every field the endpoint deliberately omits, asserted by sentinel.
    expect(html).not.toContain("@example.invalid"); // email
    expect(html).not.toContain("bob@example.com"); // the caller's own, from /team/me
    expect(html).not.toContain("4242"); // privateEntries
    expect(html).not.toContain("private entr"); // …and its rendered form
    expect(html).not.toContain("Last used"); // lastUsedAt
    expect(html).not.toContain("Never used");
    expect(html).not.toMatch(/1970/);
    expect(html).not.toContain("suspended"); // suspension state
    expect(html).not.toContain("1234567890123"); // createdAt
    expect(html).not.toContain("ws-leak"); // personalWorkspaceId
    // No control the server would refuse: adding, removing, suspending,
    // rotating a token, renaming the team and changing anyone's capture
    // default are all behind requireAdmin.
    for (const fn of [
      "rotateTeamToken",
      "setTeamSuspended",
      "removeTeamMember",
      "setMemberDefaultShare",
      "submitNewMember",
      "submitTeamName",
      "setTeamOrgDefault",
    ]) {
      expect(html, `${fn} must not be reachable from the member view`).not.toContain(fn);
    }
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("onclick");
    // The one interactive element the member view carries: their own
    // capture-default control. Both id and handler are pinned so this stays a
    // positive anchor for that one exception rather than a blank check that
    // would also quietly permit an admin control landing here later.
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html.match(/onchange="/g)).toHaveLength(1);
    expect(html).toContain('<select class="team-select" id="team-my-default" onchange="setMyDefaultShare(this.value)">');
    // And the admin panel itself stays shut.
    expect(els.get("team-body").style.display).toBe("none");
  });

  it("reads the capture default from effectiveDefault, not from the org default", async () => {
    // The member's own override DISAGREES with the org default — precisely the
    // case a client-side reimplementation of the precedence rule gets wrong.
    const { ctx, els } = memberSetup({
      me: ME({ defaultShare: "personal", orgDefault: "company", effectiveDefault: "personal" }),
    });
    await ctx.loadTeam();
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain("Auto → Personal (your setting)");
    expect(html).not.toContain("Shared");
    // Same key the composer would read for this profile: POST
    // /team/me/default-share (below) makes the member its owner, so there is
    // no separate Team-screen phrasing left to disagree with the composer.
    expect(html).toContain(ctx.t("home.autoPersonalYours"));
  });

  it("says Shared when the member overrides a personal org default the other way", async () => {
    const { ctx, els } = memberSetup({
      me: ME({ defaultShare: "company", orgDefault: "personal", effectiveDefault: "company" }),
    });
    await ctx.loadTeam();
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain(ctx.t("home.autoSharedYours"));
    // The resolved sentence says Shared, not Personal — "Personal (private)"
    // legitimately appears as one of the control's three options below it.
    expect(html).not.toContain("Auto → Personal");
  });

  it("attributes the default to the org when the member has no override of their own", async () => {
    const { ctx, els } = memberSetup({
      me: ME({ defaultShare: "", orgDefault: "company", effectiveDefault: "company" }),
    });
    await ctx.loadTeam();
    expect(els.get("team-member-view").innerHTML).toContain(ctx.t("home.autoSharedOrg"));
  });

  it("gives a member the Team nav entry, which used to be admins-only", async () => {
    const { ctx, els } = memberSetup();
    await ctx.loadTeam();
    expect(els.get("sb-tab-team").style.display).toBe("");
    expect(els.get("tab-team").style.display).toBe("");
    expect(els.get("team-admins-only").style.display).toBe("none");
  });

  it("an admin still gets the full panel and never fetches the member roster", async () => {
    const { ctx, els, seen } = adminSetup();
    await ctx.loadTeam();
    expect(seen.some((u) => u.includes("/team/roster"))).toBe(false);
    expect(seen.some((u) => u.endsWith("/team/me"))).toBe(false);
    expect(els.get("team-body").style.display).toBe("");
    expect(els.get("team-member-view").style.display).toBe("none");
  });

  it("keeps the quiet notice for a caller neither endpoint will answer", async () => {
    // 401 (signed out) and 404 (a Worker older than /team/roster) both land
    // here. The nav stays hidden, so this is a terminal state rather than a
    // destination — nobody navigates to it.
    for (const rosterStatus of [401, 404]) {
      const { ctx, els } = memberSetup({ rosterStatus });
      await ctx.loadTeam();
      expect(els.get("team-member-view").style.display, `roster ${rosterStatus}`).toBe("none");
      expect(els.get("team-member-view").innerHTML).toBe("");
      expect(els.get("team-admins-only").style.display).toBe("");
      expect(els.get("tab-team").style.display).toBe("none");
    }
  });

  it("changes nothing on a solo brain, in either branch", async () => {
    // A solo install's owner IS the bootstrap admin, so /team/members answers
    // 200 and the admin branch runs exactly as it always did: no roster fetch,
    // no member view, nav revealed as before.
    const admin = adminSetup();
    vm.runInContext("TEAM_MODE = false", admin.ctx);
    await admin.ctx.loadTeam();
    expect(admin.seen.some((u) => u.includes("/team/roster"))).toBe(false);
    expect(admin.els.get("team-body").style.display).toBe("");
    expect(admin.els.get("team-member-view").style.display).toBe("none");
    expect(admin.els.get("tab-team").style.display).toBe("");

    // The other branch: a brain that is not a team and refuses both probes
    // keeps the notice, with no roster and no nav entry.
    const denied = memberSetup({ rosterStatus: 403 });
    vm.runInContext("TEAM_MODE = false", denied.ctx);
    await denied.ctx.loadTeam();
    expect(denied.els.get("team-member-view").innerHTML).toBe("");
    expect(denied.els.get("team-member-view").style.display).toBe("none");
    expect(denied.els.get("team-admins-only").style.display).toBe("");
    expect(denied.els.get("tab-team").style.display).toBe("none");
  });

  it("translates the member view into Italian", async () => {
    const { ctx, els } = memberSetup();
    ctx.initI18n("it");
    await ctx.loadTeam();
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain("Amministratore");
    expect(html).toContain(ctx.t("home.autoPersonalYours"));
    // Both catalogs, not just English: a key present in en and missing from it
    // renders as its own key path here rather than failing loudly.
    expect(html).not.toMatch(/(team|home|common)\.[a-zA-Z]/);
  });

  it("renders the member's own capture-default control, seeded from GET /team/me", async () => {
    const { ctx, els } = memberSetup({
      me: ME({ defaultShare: "company", orgDefault: "personal", effectiveDefault: "company" }),
    });
    await ctx.loadTeam();
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain('id="team-my-default"');
    const companyOption = html.match(/<option value="company"[^>]*>/)?.[0] ?? "";
    expect(companyOption).toContain(" selected");
  });

  /** The option values inside the FIRST <select> in a chunk of markup — a
   *  member's view has exactly one; an admin's roster has one per row, and
   *  every row's is identical, so the first stands for all of them. */
  function firstSelectOptionValues(html: string): string[] {
    const select = html.match(/<select[^>]*>([\s\S]*?)<\/select>/);
    if (!select) return [];
    return [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  }

  it("derives both capture-default selects' options from one shared list, not two copies that merely agree today", async () => {
    // Both call sites (teamMemberRow for the admin, renderTeamMember for the
    // member) build their <option>s from team.js's TEAM_SHARE_VALUES via the
    // shared teamShareSelect() helper. Reading the source directly is what
    // makes this a test of ONE list rather than a coincidence between two —
    // if a future edit forked the helper again and gave only one call site a
    // fourth option, this comparison would catch it because the two selects
    // would stop agreeing with the same source list.
    const admin = adminSetup();
    await admin.ctx.loadTeam();
    const adminValues = firstSelectOptionValues(admin.els.get("team-list").innerHTML as string);

    const member = memberSetup();
    await member.ctx.loadTeam();
    const memberValues = firstSelectOptionValues(member.els.get("team-member-view").innerHTML as string);

    const sourceValues = vm.runInContext("TEAM_SHARE_VALUES", admin.ctx);
    expect(sourceValues.length).toBeGreaterThan(0);
    expect(adminValues).toEqual(sourceValues);
    expect(memberValues).toEqual(sourceValues);
  });

  /** The <label class="team-capture-label" title="..."> that wraps a capture-default
   *  <select>: its title attribute and its own text (before the nested <span> of the
   *  select itself) are what a user actually sees/reads on hover. */
  function firstCaptureLabel(html: string): { title: string; label: string } {
    const m = html.match(/<label class="team-capture-label" title="([^"]*)">\s*([^<]*)/);
    return { title: m?.[1] ?? "", label: (m?.[2] ?? "").trim() };
  }

  it("labels each capture-default control with its own text, not a shared or swapped one", async () => {
    // teamShareSelect() is one implementation shared by two call sites (Phase 3's whole
    // point), but "one implementation" is not "one label": teamMemberRow (admin) and
    // renderTeamMember (member) each pass their OWN title/label strings into it, and
    // those two strings are legitimately different — the member reads "New captures:"
    // (team.myDefaultLabel) about their own row, the admin reads "Captures:"
    // (team.defaultShareLabel) about someone else's. The options-values test above
    // only proves the two controls share one source list; it forks cleanly if either
    // caller's label/title is pointed at the wrong key, because nothing else in the
    // suite reads this attribute or this text. This test pins each caller's label and
    // title to its own expected string, deliberately not asserting the two match.
    const admin = adminSetup();
    await admin.ctx.loadTeam();
    const adminLabel = firstCaptureLabel(admin.els.get("team-list").innerHTML as string);
    expect(adminLabel.label).toBe(admin.ctx.t("team.defaultShareLabel"));
    expect(adminLabel.title).toBe(admin.ctx.t("team.defaultShareTitle"));

    const member = memberSetup();
    await member.ctx.loadTeam();
    const memberLabel = firstCaptureLabel(member.els.get("team-member-view").innerHTML as string);
    expect(memberLabel.label).toBe(member.ctx.t("team.myDefaultLabel"));
    expect(memberLabel.title).toBe(member.ctx.t("team.myDefaultLabel"));
  });

  /** A member view wired for POST /team/me/default-share, exercising setMyDefaultShare. */
  function memberSetupWithDefaultShare(
    opts: { me?: unknown; defaultShareReply?: () => any } = {},
  ) {
    const bodies: any[] = [];
    const harness = setup(async (url: string, init?: any) => {
      if (url.endsWith("/team/members")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "Forbidden" }) };
      }
      if (url.endsWith("/team/roster")) {
        return { ok: true, status: 200, json: async () => ROSTER_OK };
      }
      if (url.endsWith("/team/me/default-share")) {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return (
          opts.defaultShareReply?.() ?? { ok: true, status: 200, json: async () => ({ ok: true }) }
        );
      }
      if (url.endsWith("/team/me")) return { ok: true, status: 200, json: async () => opts.me ?? ME() };
      throw new Error(`unexpected fetch ${url}`);
    });
    return { ...harness, bodies };
  }

  it("posts the member's own default-share change with no id, unlike the admin's", async () => {
    const { ctx, bodies } = memberSetupWithDefaultShare();
    await ctx.loadTeam();
    await ctx.setMyDefaultShare("personal");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ default: "personal" });
    expect(bodies[0]).not.toHaveProperty("id");
  });

  it("re-renders with the server's resolved default and toasts success", async () => {
    const { ctx, els, appended } = memberSetupWithDefaultShare({
      defaultShareReply: () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          default: "personal",
          defaultShare: "personal",
          orgDefault: "company",
          effectiveDefault: "personal",
        }),
      }),
    });
    await ctx.loadTeam();
    await ctx.setMyDefaultShare("personal");
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain(ctx.t("home.autoPersonalYours"));
    expect(appended[appended.length - 1].innerHTML).toContain("Capture default updated");
  });

  it("reports a failed change through the toast and re-renders with the original value selected", async () => {
    const { ctx, els, appended } = memberSetupWithDefaultShare({
      me: ME({ defaultShare: "personal", orgDefault: "company", effectiveDefault: "personal" }),
      defaultShareReply: () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "nope" }) }),
    });
    await ctx.loadTeam();
    await ctx.setMyDefaultShare("company");
    expect(appended[appended.length - 1].innerHTML).toContain("nope");
    const html = els.get("team-member-view").innerHTML as string;
    const personalOption = html.match(/<option value="personal"[^>]*>/)?.[0] ?? "";
    expect(personalOption).toContain(" selected");
  });

  it("translates the capture-default hint into Italian", async () => {
    const { ctx, els } = memberSetup();
    ctx.initI18n("it");
    await ctx.loadTeam();
    const html = els.get("team-member-view").innerHTML as string;
    expect(html).toContain(
      "Dove finiscono le tue acquisizioni quando non scegli un livello. Puoi comunque decidere per ogni singolo ricordo.",
    );
  });
});
