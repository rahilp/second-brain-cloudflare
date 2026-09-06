/**
 * The sign-in overlay's 401 message.
 *
 * Every 401 used to read "Invalid token", which for a suspended or removed
 * member is both wrong and a dead end: their token is fine, and no amount of
 * re-copying it will help. The Worker now says which of the three it is
 * (src/lib/identity.ts), and the overlay has to tell them who can fix it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** i18n.js, state.js and auth.js, in page-load order. */
const SRC = ["public/js/i18n.js", "public/js/state.js", "public/js/auth.js"]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

const IDS = ["auth-url", "auth-token", "auth-error", "auth-connect", "auth-overlay", "app"];

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
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {},
  };
}

/** Boots the overlay with a /list that answers `status` and `body`. */
function setup(status: number, body: unknown, locale: "en" | "it" = "en") {
  const elements = new Map<string, any>();
  for (const id of IDS) {
    const el = makeEl();
    el.id = id;
    elements.set(id, el);
  }
  elements.get("auth-url").value = "https://brain.example";
  elements.get("auth-token").value = "a-real-looking-token";

  const stored = new Map<string, string>();
  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      getElementById: (id?: string) => elements.get(id ?? "") ?? makeEl(),
      createElement: () => makeEl(),
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
    fetch: async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
    setTimeout,
    clearTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.initI18n(locale);
  // showApp() reaches into the rest of the dashboard, which is not loaded here.
  vm.runInContext(`showApp = function () { shown = true }; var shown = false`, ctx);
  return { ctx, els: elements, stored };
}

const errorText = (els: Map<string, any>) => els.get("auth-error").textContent;

describe("sign-in 401 messages", () => {
  it("tells a suspended member to ask an admin, not to check their token", async () => {
    const { ctx, els } = setup(401, {
      ok: false,
      error: "Your account is suspended. Ask a team admin to restore it.",
      code: "suspended",
    });
    await ctx.connect();
    expect(errorText(els)).toBe("Your account is suspended. Ask a team admin to restore it.");
    expect(errorText(els)).not.toBe("Invalid token");
    expect(errorText(els)).toMatch(/admin/i);
  });

  it("tells a removed member they were removed from the team", async () => {
    const { ctx, els } = setup(401, { ok: false, error: "…", code: "removed" });
    await ctx.connect();
    expect(errorText(els)).toBe("Your account has been removed from this team.");
  });

  it("still says Invalid token for a token that is simply wrong", async () => {
    const { ctx, els } = setup(401, { ok: false, error: "Unauthorized", code: "invalid_token" });
    await ctx.connect();
    expect(errorText(els)).toBe("Invalid token");
  });

  it("says Invalid token against a Worker too old to send a code", async () => {
    const { ctx, els } = setup(401, { ok: false, error: "Unauthorized" });
    await ctx.connect();
    expect(errorText(els)).toBe("Invalid token");
  });

  it("survives a 401 whose body is not JSON at all", async () => {
    const { ctx, els } = setup(401, undefined);
    // The stub above resolves its json(); make it reject the way a proxy's HTML
    // error page would.
    ctx.fetch = async () => ({ ok: false, status: 401, json: async () => { throw new SyntaxError("not json"); } });
    await ctx.connect();
    expect(errorText(els)).toBe("Invalid token");
  });

  it("localises the suspended message", async () => {
    const { ctx, els } = setup(401, { ok: false, code: "suspended" }, "it");
    await ctx.connect();
    expect(errorText(els)).toBe(
      "Il tuo account è sospeso. Chiedi a un amministratore del team di ripristinarlo.",
    );
  });

  it("does not store the token when the account is suspended", async () => {
    const { ctx, stored } = setup(401, { ok: false, code: "suspended" });
    await ctx.connect();
    expect(stored.get("sb_token")).toBeUndefined();
  });
});
