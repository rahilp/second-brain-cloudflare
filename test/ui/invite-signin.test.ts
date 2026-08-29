/**
 * Sign-in "I received a team invite" guided token entry. Ships unconditionally
 * (TEAM_MODE is unknowable pre-auth) as a single collapsed text link that
 * issues no request until pressed. Same fake-DOM + vm approach as
 * auth-signin-errors.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js and auth.js, in page-load order. */
const SRC = ["public/utils.js", "public/js/i18n.js", "public/js/state.js", "public/js/auth.js"]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

const IDS = ["auth-url", "auth-token", "auth-error", "auth-connect", "auth-invite-toggle", "auth-invite-help", "auth-overlay", "app"];

function makeEl(id: string) {
  const attrs: Record<string, string> = {};
  let focusCount = 0;
  return {
    id,
    style: { display: id === "auth-invite-help" ? "none" : "" } as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    attrs,
    setAttribute(name: string, val: string) {
      attrs[name] = val;
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: () => false,
    appendChild() {},
    remove() {},
    focus() {
      focusCount++;
    },
    get focusCount() {
      return focusCount;
    },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {},
  };
}

function setup(fetchImpl: (url: string, init?: any) => Promise<any> = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const elements = new Map<string, any>();
  for (const id of IDS) elements.set(id, makeEl(id));
  const stored = new Map<string, string>();
  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      querySelector: () => makeEl(""),
      querySelectorAll: () => [],
      getElementById: (id?: string) => elements.get(id ?? "") ?? makeEl(id ?? ""),
      createElement: () => makeEl(""),
      addEventListener() {},
      removeEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
      removeItem: (k: string) => stored.delete(k),
    },
    navigator: { language: "en-US" },
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = { location: { origin: "http://localhost" } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.initI18n("en");
  vm.runInContext(`showApp = function () { shown = true }; var shown = false`, ctx);
  return { ctx, els: elements, stored };
}

describe("sign-in invite help toggle", () => {
  it("opens and closes, updating aria-expanded and the button label", () => {
    const { ctx, els } = setup();
    ctx.toggleInviteHelp();
    expect(els.get("auth-invite-help").style.display).toBe("");
    expect(els.get("auth-invite-toggle").attrs["aria-expanded"]).toBe("true");
    expect(els.get("auth-invite-toggle").textContent).toBe("Hide");

    ctx.toggleInviteHelp();
    expect(els.get("auth-invite-help").style.display).toBe("none");
    expect(els.get("auth-invite-toggle").attrs["aria-expanded"]).toBe("false");
    expect(els.get("auth-invite-toggle").textContent).toBe("I received a team invite");
  });

  it("prefills the URL from window.location.origin when empty, and focuses the token field", () => {
    const { ctx, els } = setup();
    expect(els.get("auth-url").value).toBe("");
    ctx.toggleInviteHelp();
    expect(els.get("auth-url").value).toBe("http://localhost");
    expect(els.get("auth-token").focusCount).toBe(1);
  });

  it("leaves a typed URL untouched", () => {
    const { ctx, els } = setup();
    els.get("auth-url").value = "https://typed.example";
    ctx.toggleInviteHelp();
    expect(els.get("auth-url").value).toBe("https://typed.example");
  });

  it("translates into Italian", () => {
    const { ctx, els } = setup();
    ctx.initI18n("it");
    ctx.toggleInviteHelp();
    expect(els.get("auth-invite-toggle").textContent).toBe("Nascondi");
    expect(ctx.t("auth.inviteStep2")).toContain("token monouso");
  });

  it("does nothing dangerous if the elements are missing (defensive no-op)", () => {
    const { ctx } = setup();
    vm.runInContext(`document.getElementById = () => null`, ctx);
    expect(() => ctx.toggleInviteHelp()).not.toThrow();
  });
});

describe("regression: connect() 401 handling is untouched", () => {
  it("shows a non-empty error and never calls localStorage.setItem", async () => {
    const { ctx, els } = setup(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: "Unauthorized", code: "suspended" }),
    }));
    let setItemCalls = 0;
    ctx.localStorage.setItem = () => {
      setItemCalls++;
    };
    els.get("auth-url").value = "https://brain.example";
    els.get("auth-token").value = "a-real-looking-token";
    await ctx.connect();
    expect((els.get("auth-error").textContent as string).length).toBeGreaterThan(0);
    expect(setItemCalls).toBe(0);
  });
});
