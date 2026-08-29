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

/** utils.js, i18n.js, state.js, api.js, coach.js and home.js, in page-load order. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/api.js",
  "public/js/coach.js",
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
    hidden: false,
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

const IDS = ["home-layer-wrap", "home-layer-hint", "coach-home", "home-mode", "home-mode-label", "home-field"];

function setup(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const elements = new Map<string, any>();
  // A real store, not a no-op: the coach marks below are dismissed through it,
  // and the solo-brain case asserts that nothing was ever written to it.
  const store = new Map<string, string>();
  const writes: string[] = [];
  const reads: string[] = [];
  const localStorage = {
    getItem(k: string) {
      reads.push(k);
      return store.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      writes.push(k);
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  };
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
    localStorage,
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
  return { ctx, els: elements, writes, reads };
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

  it("shows the org-default sentence for personal when the org itself defaults to personal", async () => {
    // The remaining table row: effectiveDefault personal, defaultShare '' — the
    // org's fallback, not a member override. Distinct from the previous case,
    // which is the member's own personal setting.
    const { fn } = teamMeFetch({ defaultShare: "", orgDefault: "personal", effectiveDefault: "personal" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("home-layer-hint").textContent).toBe("Auto → Personal (org default)");
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

  it("pins to personal when personal is chosen explicitly", async () => {
    // The table's other pinned row: pinnedPersonal is independent of
    // effectiveDefault/defaultShare, so this starts from a shared org default.
    const { fn } = teamMeFetch({ defaultShare: "", orgDefault: "company", effectiveDefault: "company" });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    ctx.onHomeLayerChange("personal");
    expect(els.get("home-layer-hint").textContent).toBe("This one stays personal");
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

  it("leaves the hint hidden with empty text when /team/me answers non-ok", async () => {
    // The other failure shape: a reachable server that answers e.g. 500, as
    // opposed to the throw-before-a-response case above.
    const { fn } = teamMeFetch(null, { fail: true });
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

/**
 * The composer's coach marks, which ride on the same reveal path as the hint
 * above — renderCaptureHint() is already the single place the composer reacts
 * to TEAM_MODE and to /team/me, and a second hook could disagree with it.
 */
describe("composer coach marks", () => {
  const teamProfile = { defaultShare: "", orgDefault: "company", effectiveDefault: "company" };

  it("teaches what 'shared' means first, and says nothing about Default yet", async () => {
    const { fn } = teamMeFetch(teamProfile);
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    const mark = els.get("coach-home");
    expect(mark.hidden).toBe(false);
    expect(mark.innerHTML).toContain("Shared means the whole team");
    expect(mark.innerHTML).not.toContain("What “Default” does");
  });

  it("moves on to what Default does only once the first mark is dismissed", async () => {
    // The ordering is this feature's whole design: "shared means the whole
    // team" is the fact the second sentence presupposes, and a new member
    // shown both at once reads neither.
    const { fn } = teamMeFetch(teamProfile);
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    ctx.dismissCoachMark("shared", "coach-home");
    ctx.renderCaptureHint();
    const mark = els.get("coach-home");
    expect(mark.hidden).toBe(false);
    expect(mark.innerHTML).toContain("What “Default” does");
    expect(mark.innerHTML).not.toContain("Shared means the whole team");
  });

  it("shows nothing once both are dismissed", async () => {
    const { fn } = teamMeFetch(teamProfile);
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    ctx.dismissCoachMark("shared", "coach-home");
    ctx.dismissCoachMark("auto", "coach-home");
    ctx.renderCaptureHint();
    expect(els.get("coach-home").hidden).toBe(true);
    expect(els.get("coach-home").innerHTML).toBe("");
  });

  it("follows the hint onto the pinned sentence without changing which mark is up", async () => {
    // Picking a layer re-renders the hint; the coach mark is not a function of
    // the layer, so it must survive that render unchanged.
    const { fn } = teamMeFetch(teamProfile);
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    ctx.onHomeLayerChange("personal");
    expect(els.get("home-layer-hint").textContent).toBe("This one stays personal");
    expect(els.get("coach-home").innerHTML).toContain("Shared means the whole team");
  });

  it("renders no mark and never touches the dismissal record on a solo brain", async () => {
    // Not written, and not READ either. Deciding WHICH of the two marks is due
    // means consulting the record, so the TEAM_MODE gate has to come first
    // here as well as inside the primitive — otherwise coach.js's claim that a
    // solo brain does not so much as read the key would be false.
    const { fn } = teamMeFetch(teamProfile);
    const { ctx, els, writes, reads } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: false });
    expect(els.get("coach-home").hidden).toBe(true);
    expect(els.get("coach-home").innerHTML).toBe("");
    expect(writes, "a solo brain must never write sb_coach_dismissed").not.toContain("sb_coach_dismissed");
    expect(reads, "a solo brain must never read sb_coach_dismissed").not.toContain("sb_coach_dismissed");
  });

  it("still teaches what shared means when /team/me has not answered", async () => {
    // The first mark is about the layer, not about the policy, so a failed
    // profile fetch has no bearing on it.
    const { fn } = teamMeFetch(null, { reject: true });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("coach-home").hidden).toBe(false);
    expect(els.get("coach-home").innerHTML).toContain("Shared means the whole team");
  });

  it("withholds the Default mark when there is no hint line for it to point at", async () => {
    // Its body reads "the line above says where it lands today". With /team/me
    // unanswered the hint is empty and hidden, so the sentence would be
    // pointing at nothing.
    const { fn } = teamMeFetch(null, { reject: true });
    const { ctx, els } = setup(fn);
    await ctx.maybeRevealHomeLayer({ team: true });
    ctx.dismissCoachMark("shared", "coach-home");
    ctx.renderCaptureHint();
    expect(els.get("home-layer-hint").textContent).toBe("");
    expect(els.get("coach-home").hidden).toBe(true);
    expect(els.get("coach-home").innerHTML).toBe("");
  });

  it("translates the first mark into Italian", async () => {
    const { fn } = teamMeFetch(teamProfile);
    const { ctx, els } = setup(fn);
    ctx.initI18n("it");
    await ctx.maybeRevealHomeLayer({ team: true });
    expect(els.get("coach-home").innerHTML).toContain("Condiviso vuol dire tutto il team");
    expect(els.get("coach-home").innerHTML).toContain("Ho capito");
  });
});
