/**
 * Turning the team-mode switch on reveals the team features immediately —
 * no reload.
 *
 * This one loads the WHOLE dashboard, in index.html's own script order, rather
 * than team.js alone. The claim under test spans four modules: team.js writes
 * the setting, nav.js re-probes GET /health, and home.js / recent.js /
 * recall.js are what actually put the composer's layer target, the memories
 * layer filter and the recall layer filter on screen. A team.js-only harness
 * could only assert that some function was called, which is the shape of test
 * this project has shipped before and which passes whether or not anything
 * appeared.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** Every module the page loads, in the page's order — scraped, never listed. */
const SRC = [
  ...readFileSync(resolve(ROOT, "public/index.html"), "utf8").matchAll(/<script\s+src="([^"]+)"/g),
]
  .map((m) => readFileSync(resolve(ROOT, `public/${m[1].replace(/^\//, "")}`), "utf8"))
  .join("\n")
  .replace(/\ninit\(\)\s*$/, "");

/** The controls whose appearance IS the reveal. All three ship hidden. */
const LAYER_CONTROLS = ["home-layer-wrap", "layer-filter-wrap", "recall-layer-wrap"];

function makeEl(id: string) {
  const el: any = {
    id,
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    checked: false,
    disabled: false,
    onclick: null,
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
    offsetHeight: 0,
    scrollHeight: 0,
  };
  return el;
}

function setup() {
  const elements = new Map<string, any>();
  for (const id of LAYER_CONTROLS) {
    const el = makeEl(id);
    el.style.display = "none"; // exactly as index.html ships them
    elements.set(id, el);
  }
  // Everything else is created on demand and kept, so a module that renders
  // into an element this test does not care about still finds one.
  const get = (id?: string) => {
    if (id == null) return null;
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  /** Flipped by PATCH /config, read by GET /health — the server's own state. */
  let team = false;
  const patched: Record<string, unknown>[] = [];

  const fetchImpl = async (url: string, init?: any) => {
    const reply = (body: unknown, ok = true, status = 200) => ({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => "application/json" },
    });
    if (url.endsWith("/config") && init?.method === "PATCH") {
      const body = JSON.parse(init.body);
      patched.push(body);
      // The Worker's own rule: TEAM_MODE "on" makes /health answer team:true.
      if (body.TEAM_MODE === "on") team = true;
      if (body.TEAM_MODE === "off") team = false;
      return reply({ ok: true });
    }
    if (url.endsWith("/config")) return reply({ config: {}, overrides: {}, defaults: {} });
    if (url.includes("/health")) return reply({ ok: true, version: "1.0.0", vectorize: { ok: true }, team });
    if (url.includes("/team/members")) {
      return reply({
        ok: true,
        you: "u1",
        members: [{ userId: "u1", name: "Ada", email: "ada@example.com", role: "admin", suspended: false, privateEntries: 2 }],
      });
    }
    if (url.includes("/team/roster")) return reply({ ok: true, you: "u1", members: [], teams: [] });
    if (url.includes("/team/workspaces")) return reply({ ok: true, teams: [{ id: "w1", name: "Company", memberCount: 1 }] });
    if (url.includes("/team/me")) return reply({ ok: true, defaultShare: "", orgDefault: "personal", effectiveDefault: "personal" });
    return reply({ ok: true });
  };

  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en", setAttribute() {}, getAttribute: () => null },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: get,
      createElement: (tag: string) => makeEl(tag),
      addEventListener() {},
      removeEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: "en-US", clipboard: { writeText() {} } },
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    alert: () => {},
    confirm: () => { throw new Error("confirm() must not be used"); },
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  ctx.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  ctx.location = { href: "", origin: "http://localhost" };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"`, ctx);
  ctx.initI18n("en");
  return { ctx, elements, patched, teamNow: () => team };
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("turning team mode on reveals the layer controls without a reload", () => {
  it("takes the composer target, the memories filter and the recall filter from hidden to shown", async () => {
    const { ctx, elements, patched } = setup();

    // The solo brain as it loads: /health says team:false, so every layer
    // control is hidden and the switch is off and free.
    await ctx.checkVectorize();
    await drain();
    expect(vm.runInContext("TEAM_MODE", ctx)).toBe(false);
    for (const id of LAYER_CONTROLS) {
      expect(elements.get(id).style.display, `${id} before`).toBe("none");
    }

    await ctx.loadTeam();
    await drain();
    expect(elements.get("team-mode-toggle").checked).toBe(false);
    expect(elements.get("team-mode-toggle").disabled).toBe(false);

    // The one action under test. Nothing else runs: no reload, no second
    // switchTab, no manual reveal call.
    await ctx.setTeamMode(true);
    await drain();

    expect(patched).toEqual([{ TEAM_MODE: "on" }]);
    expect(vm.runInContext("TEAM_MODE", ctx)).toBe(true);
    for (const id of LAYER_CONTROLS) {
      expect(elements.get(id).style.display, `${id} after`).toBe("");
    }
    // And the switch itself now reads on.
    expect(elements.get("team-mode-toggle").checked).toBe(true);
  });
});
