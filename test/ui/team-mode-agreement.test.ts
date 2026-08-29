/**
 * The team-mode switch and the rest of the dashboard cannot disagree.
 *
 * They could, and did. renderTeamMode() derives the switch from
 * `teamMembers.length > 1` — real membership, deliberately, so the control
 * never renders free-and-pressable in a state where the server would refuse the
 * write. Everything ELSE on the page derives from the `TEAM_MODE` global, which
 * is GET /health's `team`. Before the floor, a brain storing "off" with three
 * colleagues on it made those two answer differently: the switch rendered
 * checked and locked — "team mode is on and you cannot turn it off" — while the
 * composer target, the memories layer filter and the recall layer filter stayed
 * hidden because the page believed it was solo.
 *
 * The floor in isTeamBrain() removes that gap: `members > 1` now IMPLIES
 * `team === true` at every value of the key. This test pins the two to the same
 * source so a later change cannot separate them again — the fake server here
 * does not re-implement the rule, it imports resolveTeamFlag() and calls it, so
 * loosening the floor in src/ loosens this fake in exactly the same way and
 * these assertions are what still fail.
 *
 * The whole dashboard is loaded, in index.html's own script order, for the
 * reason team-mode-reveal.test.ts states: the claim spans team.js (the switch),
 * nav.js (the /health probe that assigns TEAM_MODE) and home.js / recent.js /
 * recall.js (the controls that actually appear).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { resolveTeamFlag } from "../../src/lib/team-admin";

const ROOT = resolve(import.meta.dirname, "../..");

/** Every module the page loads, in the page's order — scraped, never listed. */
const SRC = [
  ...readFileSync(resolve(ROOT, "public/index.html"), "utf8").matchAll(/<script\s+src="([^"]+)"/g),
]
  .map((m) => readFileSync(resolve(ROOT, `public/${m[1].replace(/^\//, "")}`), "utf8"))
  .join("\n")
  .replace(/\ninit\(\)\s*$/, "");

/** The controls whose visibility IS "the page thinks this is a team". */
const LAYER_CONTROLS = ["home-layer-wrap", "layer-filter-wrap", "recall-layer-wrap"];

function makeEl(id: string) {
  return {
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
  } as any;
}

/**
 * A brain in a given state, with a server that answers the way the Worker does.
 *
 * `mode` is the STORED TEAM_MODE, `people` the number of active users — the two
 * inputs the floor is a function of. /health's `team` is resolveTeamFlag()
 * itself, imported rather than restated.
 */
function setup({ mode, people }: { mode: string; people: number }) {
  const server = { mode, people };
  const elements = new Map<string, any>();
  for (const id of LAYER_CONTROLS) {
    const el = makeEl(id);
    el.style.display = "none"; // exactly as index.html ships them
    elements.set(id, el);
  }
  const get = (id?: string) => {
    if (id == null) return null;
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const roster = () =>
    Array.from({ length: server.people }, (_, i) => ({
      userId: `u${i + 1}`,
      name: i === 0 ? "Ada" : `Colleague ${i}`,
      email: `u${i + 1}@example.com`,
      role: i === 0 ? "admin" : "member",
      suspended: false,
      privateEntries: 0,
      defaultShare: "",
    }));

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
      if (body.TEAM_MODE === "off" && server.people > 1) {
        // The Worker's own guardrail — the mechanism that EXPLAINS.
        return reply({ ok: false, error: `Team mode cannot be turned off while ${server.people} people are still on the team.` }, false, 400);
      }
      if (typeof body.TEAM_MODE === "string") server.mode = body.TEAM_MODE;
      return reply({ ok: true });
    }
    if (url.endsWith("/config")) return reply({ config: {}, overrides: {}, defaults: {} });
    if (url.includes("/health")) {
      // The mechanism that ENFORCES, imported from src rather than restated.
      return reply({ ok: true, version: "1.0.0", vectorize: { ok: true }, team: resolveTeamFlag(server.mode, server.people) });
    }
    if (url.includes("/team/members")) return reply({ ok: true, you: "u1", members: roster() });
    if (url.includes("/team/roster")) return reply({ ok: true, you: "u1", members: [], teams: [] });
    if (url.includes("/team/workspaces")) return reply({ ok: true, teams: [{ id: "w1", name: "Company", memberCount: server.people }] });
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

  const drain = () => new Promise((r) => setTimeout(r, 0));
  /** Load the page the way it loads: probe /health, then render the panel. */
  const render = async () => {
    await ctx.checkVectorize();
    await drain();
    await ctx.loadTeam();
    await drain();
  };
  return {
    ctx,
    server,
    render,
    drain,
    toggle: () => elements.get("team-mode-toggle"),
    pageThinksTeam: () => vm.runInContext("TEAM_MODE", ctx),
    layerControlsShown: () => LAYER_CONTROLS.map((id) => elements.get(id).style.display !== "none"),
  };
}

describe("the switch and the page read the same truth at every state", () => {
  // Nine states: three recorded intents × alone, one colleague, two colleagues.
  for (const mode of ["auto", "on", "off"]) {
    for (const people of [1, 2, 3]) {
      it(`agrees at TEAM_MODE="${mode}" with ${people} active ${people === 1 ? "person" : "people"}`, async () => {
        const h = setup({ mode, people });
        await h.render();

        const input = h.toggle();
        const team = h.pageThinksTeam();

        // The claim. The switch's own state and the global every other module
        // branches on are one answer, not two.
        expect(input.checked, "switch vs page").toBe(team);

        // And the locked branch specifically: renderTeamMode() locks on real
        // membership, so a lock can only ever mean "this really is a team".
        // This is the assertion the broken state failed — locked-and-checked
        // while the page believed it was solo.
        if (input.disabled) expect(team, "locked switch on a page that thinks it is solo").toBe(true);

        // The rest of the dashboard follows the same answer, so nothing on
        // screen contradicts the switch either.
        expect(h.layerControlsShown()).toEqual([team, team, team]);
      });
    }
  }

  it("survives the exact sequence that broke it: off while alone, then two colleagues arrive", async () => {
    const h = setup({ mode: "auto", people: 1 });
    await h.render();

    // 1. Alone. The owner turns the switch off through the real handler; the
    //    server permits it, and the page goes solo.
    await h.ctx.setTeamMode(false);
    await h.drain();
    expect(h.server.mode).toBe("off");
    expect(h.pageThinksTeam()).toBe(false);
    expect(h.toggle().checked).toBe(false);
    expect(h.toggle().disabled).toBe(false);
    expect(h.layerControlsShown()).toEqual([false, false, false]);

    // 2. Two colleagues are invited. Nothing about inviting is gated on the
    //    flag, and the stored key is untouched — the state a direct D1 insert
    //    or a hand-edited blob leaves behind.
    h.server.people = 3;
    await h.render();

    // 3. The switch locks, and the page agrees with it rather than staying
    //    solo underneath it.
    expect(h.toggle().checked).toBe(true);
    expect(h.toggle().disabled).toBe(true);
    expect(h.pageThinksTeam()).toBe(true);
    expect(h.layerControlsShown()).toEqual([true, true, true]);
  });

  it("shows the locked hint naming the headcount rather than the free one", async () => {
    const h = setup({ mode: "off", people: 3 });
    await h.render();
    // The copy the admin reads in that state has to explain the lock. Both
    // branches already exist; this pins which one a floored "off" gets.
    expect(h.ctx.document.getElementById("team-mode-hint").textContent).toContain("3");
  });
});
