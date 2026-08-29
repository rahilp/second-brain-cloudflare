/**
 * Composer capture-policy hint: what Auto resolves to (and whose setting that
 * is), or which layer is pinned for this capture. Same fake-DOM + vm approach
 * as team-panel.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js, api.js and home.js, in page-load order. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/api.js",
  "public/js/home.js",
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

const IDS = ["home-layer-wrap", "home-layer-hint", "home-mode", "home-mode-label", "home-field"];

function setup(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const elements = new Map<string, any>();
  for (const id of IDS) {
    const el = makeEl();
    el.id = id;
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
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"`, ctx);
  ctx.initI18n("en");
  return { ctx, els: elements };
}

function teamMeFetch(profile: Record<string, unknown> | null, opts: { fail?: boolean; reject?: boolean } = {}) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (opts.reject) throw new Error("offline");
    if (opts.fail || !profile) return { ok: false, status: 500, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, profile }) };
  };
  return { fn, calls };
}

describe("composer capture-policy hint", () => {
  it("shows the org-default sentence when the member has no override", async () => {
    const { fn } = teamMeFetch({ defaultShare: "", orgDefault: "company", effectiveDefault: "company" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("home-layer-hint").textContent).toBe("Auto → Shared (org default)");
    expect(els.get("home-layer-hint").style.display).toBe("");
  });

  it("distinguishes the member's own shared setting from the org's", async () => {
    const { fn } = teamMeFetch({ defaultShare: "company", orgDefault: "company", effectiveDefault: "company" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("home-layer-hint").textContent).toBe("Auto → Shared (your setting)");
  });

  it("shows the member's own personal setting", async () => {
    const { fn } = teamMeFetch({ defaultShare: "personal", orgDefault: "company", effectiveDefault: "personal" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("home-layer-hint").textContent).toBe("Auto → Personal (your setting)");
  });

  it("switches to the pinned sentence when a layer is chosen, and back to Auto when cleared", async () => {
    const { fn } = teamMeFetch({ defaultShare: "", orgDefault: "company", effectiveDefault: "company" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    ctx.onHomeLayerChange("company");
    expect(els.get("home-layer-hint").textContent).toBe("This one goes to the whole team");
    ctx.onHomeLayerChange("");
    expect(els.get("home-layer-hint").textContent).toBe("Auto → Shared (org default)");
  });

  it("hides both the layer wrap and the hint on a solo brain, with no /team/me fetch", async () => {
    const { fn, calls } = teamMeFetch({ defaultShare: "", orgDefault: "company", effectiveDefault: "company" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: false });
    expect(els.get("home-layer-wrap").style.display).toBe("none");
    expect(els.get("home-layer-hint").style.display).toBe("none");
    expect(calls.length).toBe(0);
  });

  it("leaves the hint hidden with empty text when /team/me rejects", async () => {
    const { fn } = teamMeFetch(null, { reject: true });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("home-layer-hint").style.display).toBe("none");
    expect(els.get("home-layer-hint").textContent).toBe("");
  });

  it("translates the org-default sentence into Italian", async () => {
    const { fn } = teamMeFetch({ defaultShare: "", orgDefault: "company", effectiveDefault: "company" });
    const { ctx, els } = setup(fn);
    ctx.initI18n("it");
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("home-layer-hint").textContent).toBe("Auto → Condiviso (predefinito dell’organizzazione)");
  });
});
