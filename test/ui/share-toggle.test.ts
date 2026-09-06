/**
 * Sharing a memory with the team, and un-sharing it again.
 *
 * The act is reversible and already offers an undo toast, so the browser
 * confirm() in front of it was a second question about a decision that costs
 * one tap to reverse — the pattern that trains people to click through
 * dialogs without reading them. The toast is the affordance that stays.
 *
 * Every `confirm` and `alert` in these sandboxes throws, so a lingering call
 * to either shows up as a failure rather than as a silent pass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl() {
  return {
    id: "",
    value: "",
    href: "",
    download: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    appendChild() {},
    remove() {},
    click() {},
    querySelectorAll: () => [],
    // toast.js writes its markup as a string and then reaches back in for the
    // optional action button, so this parses what it just wrote. The same
    // object is handed back until the markup changes, or the onclick that
    // toast.js assigns would land on a throwaway.
    _action: null as any,
    _actionFor: null as string | null,
    querySelector(sel: string) {
      if (sel !== ".app-toast-action") return null;
      const m = /<button type="button" class="app-toast-action">([\s\S]*?)<\/button>/.exec(this.innerHTML);
      if (!m) return null;
      if (this._actionFor !== this.innerHTML) {
        this._action = { textContent: m[1], onclick: null };
        this._actionFor = this.innerHTML;
      }
      return this._action;
    },
  };
}

type Call = { url: string; init?: any };

function load(extra: string[] = [], fetchImpl?: (url: string, init?: any) => Promise<any>) {
  const els = new Map<string, any>();
  const calls: Call[] = [];
  const ctx: any = {
    console,
    calls,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) {
          const el = makeEl();
          el.id = id;
          els.set(id, el);
        }
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      body: {
        style: {},
        appendChild(el: any) {
          if (el.id) els.set(el.id, el);
        },
      },
    },
    // Nothing here may reach the browser's own dialogs.
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {
      throw new Error("alert() must not be used");
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    refreshAll: () => {},
    closeMenu: () => {},
    loadMenuStats: async () => {},
    fetch: async (url: string, init?: any) => {
      calls.push({ url, init });
      if (fetchImpl) return fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/api.js", ...extra]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  // `let` bindings in state.js — a sandbox property would not shadow them.
  vm.runInContext(`WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"; TEAM_MODE = true`, ctx);
  ctx.__els = els;
  ctx.__toast = () => els.get("app-toast");
  return ctx;
}

const shareBodies = (ctx: any) =>
  (ctx.calls as Call[]).filter((c) => c.url.endsWith("/share")).map((c) => JSON.parse(c.init.body));

describe("sharing a memory with the team", () => {
  it("moves it to the company layer on one tap, asking nothing", async () => {
    const ctx = load();
    let done = 0;
    await ctx.toggleEntryLayer("m1", "personal", () => done++);
    expect(shareBodies(ctx)).toEqual([{ id: "m1", workspace: "company" }]);
    expect(done).toBe(1);
  });

  it("says what it did and offers the undo that puts it back", async () => {
    const ctx = load();
    await ctx.toggleEntryLayer("m1", "personal", () => {});
    const toast = ctx.__toast();
    expect(toast.innerHTML).toContain("Shared with the team");
    const undo = toast.querySelector(".app-toast-action");
    expect(undo.textContent).toBe("Undo");

    await undo.onclick();
    expect(shareBodies(ctx)).toEqual([
      { id: "m1", workspace: "company" },
      { id: "m1", workspace: "personal" },
    ]);
  });

  it("un-shares back to personal, with its own wording", async () => {
    const ctx = load();
    await ctx.toggleEntryLayer("m1", "company", () => {});
    expect(shareBodies(ctx)).toEqual([{ id: "m1", workspace: "personal" }]);
    expect(ctx.__toast().innerHTML).toContain("Moved back to personal");
    // Undo from here restores the shared state, not personal again.
    await ctx.__toast().querySelector(".app-toast-action").onclick();
    expect(shareBodies(ctx)[1]).toEqual({ id: "m1", workspace: "company" });
  });

  it("reports a refusal in the toast rather than a browser alert", async () => {
    const ctx = load([], async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "nope" }) }));
    let done = 0;
    await ctx.toggleEntryLayer("m1", "personal", () => done++);
    expect(ctx.__toast().innerHTML).toContain("nope");
    expect(ctx.__toast().innerHTML).not.toContain("app-toast-action"); // nothing to undo
    expect(done).toBe(0);
  });

  it("says so when the undo itself is refused, instead of failing quietly", async () => {
    // The share succeeds and the undo does not. Undo is the one control whose
    // whole purpose is reversing a mistake; silence here leaves the memory
    // shared and the user believing they put it back.
    let n = 0;
    const ctx = load([], async () => {
      n++;
      return n === 1
        ? { ok: true, status: 200, json: async () => ({ ok: true }) }
        : { ok: true, status: 200, json: async () => ({ ok: false, error: "not yours to move" }) };
    });
    let done = 0;
    await ctx.toggleEntryLayer("m1", "personal", () => done++);
    expect(done).toBe(1);

    await ctx.__toast().querySelector(".app-toast-action").onclick();
    expect(ctx.__toast().innerHTML).toContain("not yours to move");
    // No second onDone: nothing moved back, so nothing is re-rendered as if it
    // had. And the failure notice offers no Undo of its own.
    expect(done).toBe(1);
    expect(ctx.__toast().innerHTML).not.toContain("app-toast-action");
  });

  it("says so when the undo cannot reach the Worker at all", async () => {
    let n = 0;
    const ctx = load([], async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      throw new Error("Failed to fetch");
    });
    let done = 0;
    await ctx.toggleEntryLayer("m1", "company", () => done++);
    await ctx.__toast().querySelector(".app-toast-action").onclick();
    expect(ctx.__toast().innerHTML).toContain("Failed to fetch");
    expect(done).toBe(1);
  });

  it("still reports the completed undo when it works", async () => {
    const ctx = load();
    let done = 0;
    await ctx.toggleEntryLayer("m1", "personal", () => done++);
    await ctx.__toast().querySelector(".app-toast-action").onclick();
    // The success path is unchanged: the caller is told a second time so its
    // list re-renders with the memory back where it started.
    expect(done).toBe(2);
    expect(ctx.__toast().innerHTML).toContain("Shared with the team");
  });

  it("speaks Italian, which a browser dialog could not have done", async () => {
    const ctx = load();
    ctx.initI18n("it");
    await ctx.toggleEntryLayer("m1", "personal", () => {});
    expect(ctx.__toast().innerHTML).toContain("Condiviso con il team");
    expect(ctx.__toast().querySelector(".app-toast-action").textContent).toBe("Annulla");
  });
});

describe("settings failures", () => {
  it("reports a rejected display name in the toast", async () => {
    const ctx = load(["public/js/settings.js"], async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "That name is taken" }),
    }));
    ctx.document.getElementById("profile-name").value = "Ada";
    await ctx.saveProfileName();
    expect(ctx.__toast().innerHTML).toContain("That name is taken");
  });

  it("reports a failed export in the toast", async () => {
    const ctx = load(["public/js/settings.js"], async () => {
      throw new Error("offline");
    });
    await ctx.exportMemories("json");
    expect(ctx.__toast().innerHTML).toContain("Export failed: offline");
  });
});
