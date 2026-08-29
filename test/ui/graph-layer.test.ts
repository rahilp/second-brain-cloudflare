/**
 * Graph canvas layer toggle + shared-node ring/legend/hover. Same fake-DOM + vm
 * approach as team-panel.test.ts, plus a canvas whose getContext() returns a
 * recorder object so 2D draw calls can be asserted on directly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** utils.js, i18n.js, state.js and graph-canvas.js, in page-load order. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/graph-canvas.js",
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

/**
 * Every 2D method pushes [name, ...args] onto `calls`; measureText returns a
 * fixed width so label/legend sizing math has something deterministic to work
 * with. Property WRITES (fillStyle, strokeStyle, lineWidth, globalAlpha, ...)
 * are also recorded, as [`set:${prop}`, value], via a Proxy — a plain object
 * only sees method calls, and the ring's whole point (thinner, more
 * transparent, theme ink, smaller than the hover ring) lives in property
 * writes rather than in draw-call arguments.
 */
function makeCtx2d() {
  const calls: unknown[][] = [];
  const target: Record<string, unknown> = {
    calls,
    measureText: (s: string) => {
      calls.push(["measureText", s]);
      return { width: 40 };
    },
  };
  for (const m of [
    "setTransform",
    "clearRect",
    "beginPath",
    "arc",
    "fill",
    "stroke",
    "moveTo",
    "lineTo",
    "arcTo",
    "fillText",
    "setLineDash",
    "rect",
  ]) {
    target[m] = (...args: unknown[]) => calls.push([m, ...args]);
  }
  return new Proxy(target, {
    set(obj, prop, value) {
      calls.push([`set:${String(prop)}`, value]);
      (obj as Record<string, unknown>)[prop as string] = value;
      return true;
    },
  });
}

function makeCanvasEl(ctx2d: ReturnType<typeof makeCtx2d>) {
  return {
    style: {} as Record<string, string>,
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 600, height: 420, left: 0, top: 0 }),
    getContext: () => ctx2d,
    addEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

function setup(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const ctx2d = makeCtx2d();
  const canvasEl = makeCanvasEl(ctx2d);
  const elements = new Map<string, any>();
  const IDS = ["graph-empty", "graph-layer-wrap", "graph-layer"];
  for (const id of IDS) {
    const el = makeEl();
    el.id = id;
    elements.set(id, el);
  }
  const doc = {
    documentElement: { lang: "en", getAttribute: () => null },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    getElementById: (id?: string) => {
      if (id === "graph-canvas") return canvasEl;
      return elements.get(id ?? "") ?? makeEl();
    },
    createElement: () => makeEl(),
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild() {} },
  };
  const win: any = {};
  const ctx: any = {
    console,
    document: doc,
    window: win,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: "en-US" },
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
    devicePixelRatio: 1,
  };
  win.devicePixelRatio = 1;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
  ctx.initI18n("en");
  return { ctx, els: elements, ctx2d, canvasEl };
}

function jsonFetch(reply: unknown) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => reply };
  };
  return { fn, calls };
}

/** node() factory: default importance so radius is always 5 unless overridden. */
const node = (over: Record<string, unknown>) => ({ id: "", label: "x", tags: [], ...over });

describe("graph layer toggle", () => {
  it("fetches all layers with no filter, and the chosen layer once one is set", async () => {
    const nodes = [node({ id: "a" })];
    const { fn, calls } = jsonFetch({ ok: true, nodes, edges: [] });
    const { ctx } = setup(fn);
    await ctx.loadGraph();
    expect(calls).toEqual(["http://localhost/graph"]);
    ctx.onGraphLayerChange("company");
    // onGraphLayerChange calls loadGraph() itself; wait a tick for the async fetch.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["http://localhost/graph", "http://localhost/graph?workspace=company"]);
  });

  it("reveals the layer control on a team brain and hides it on a solo one", async () => {
    const nodes = [node({ id: "a" })];
    const { fn } = jsonFetch({ ok: true, nodes, edges: [] });
    const { ctx, els } = setup(fn);
    vm.runInContext("TEAM_MODE = true", ctx);
    await ctx.loadGraph();
    expect(els.get("graph-layer-wrap").style.display).toBe("");

    vm.runInContext("TEAM_MODE = false", ctx);
    await ctx.loadGraph();
    expect(els.get("graph-layer-wrap").style.display).toBe("none");
  });
});

describe("shared node ring", () => {
  it("draws the ring for the company node only, and not for the personal one", async () => {
    const nodes = [
      node({ id: "shared", workspace: "company" }),
      node({ id: "mine", workspace: "personal" }),
    ];
    const { fn } = jsonFetch({ ok: true, nodes, edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    const calls = ctx2d.calls as unknown[][];
    // Both nodes have the default radius (5, no importance set), so the ring's arc
    // radius is 5 + 2.5 = 7.5. Fails before: no such call exists at all.
    const ringStrokes = calls.filter(
      (c, i) => c[0] === "arc" && c[3] === 7.5 && calls[i + 1]?.[0] === "stroke",
    );
    expect(ringStrokes.length).toBe(1);
  });

  it("is thinner, more transparent, and theme-ink coloured — distinct from the hover ring", async () => {
    const nodes = [
      node({ id: "shared", workspace: "company" }),
      node({ id: "mine", workspace: "personal" }),
    ];
    const { fn } = jsonFetch({ ok: true, nodes, edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    const calls = ctx2d.calls as unknown[][];
    const ringArcIdx = calls.findIndex(
      (c, i) => c[0] === "arc" && c[3] === 7.5 && calls[i + 1]?.[0] === "stroke",
    );
    expect(ringArcIdx).toBeGreaterThan(-1);
    // Immediately before beginPath/arc/stroke: globalAlpha, strokeStyle, lineWidth,
    // set in that order (graph-canvas.js's node loop). Property WRITES, so only
    // visible to a recorder that tracks `set`, not just method calls.
    // graphState is a top-level `let` in state.js, so it is not a property of the
    // vm context object — it has to be read from inside the context.
    const scale = vm.runInContext("graphState.cam.scale", ctx);
    expect(calls[ringArcIdx - 4]).toEqual(["set:globalAlpha", 0.55]);
    expect(calls[ringArcIdx - 3]).toEqual(["set:strokeStyle", "#161616"]); // light-theme inkHex
    expect(calls[ringArcIdx - 2]).toEqual(["set:lineWidth", 1.5 / scale]);
    expect(calls[ringArcIdx - 1]).toEqual(["beginPath"]);
    // The hover ring (no node hovered here) would be alpha 1 / lineWidth 2 / r+3 —
    // confirm this graph never hovers anything, so those values cannot leak in.
    expect(calls.some((c) => c[0] === "arc" && c[3] === 5 + 3)).toBe(false);
  });
});

describe("hover pill author", () => {
  // graphState is a top-level `let` in state.js, not a property of the vm
  // context object, so hovering has to be driven from inside the context: stash
  // the node reference as a sandbox property (an ordinary global, unlike `let`,
  // so it IS visible inside), then set graphState.hover and redraw from there.
  it("composes kind, author and text with middots into the hover pill", async () => {
    const hoverNode = node({ id: "a", kind: "fact", actor_name: "Bob", label: "hello world" });
    const { fn } = jsonFetch({ ok: true, nodes: [hoverNode], edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    ctx.__hoverNode = hoverNode;
    vm.runInContext("graphState.hover = __hoverNode; graphState.api.redraw()", ctx);
    const calls = ctx2d.calls as unknown[][];
    // Fails before: the old code produced "fact · hello world" with no author.
    expect(calls.some((c) => c[0] === "fillText" && c[1] === "fact · by Bob · hello world")).toBe(true);
  });

  it("omits the author segment when actor_name is absent", async () => {
    const hoverNode = node({ id: "a", kind: "fact", label: "hello world" });
    const { fn } = jsonFetch({ ok: true, nodes: [hoverNode], edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    ctx.__hoverNode = hoverNode;
    vm.runInContext("graphState.hover = __hoverNode; graphState.api.redraw()", ctx);
    const calls = ctx2d.calls as unknown[][];
    expect(calls.some((c) => c[0] === "fillText" && c[1] === "fact · hello world")).toBe(true);
  });

  it("translates byAuthor to Italian", () => {
    const { ctx } = setup(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, nodes: [], edges: [] }) }));
    ctx.initI18n("it");
    expect(ctx.t("graph.byAuthor", { name: "Bob" })).toBe("di Bob");
  });
});

describe("shared marker in the legend", () => {
  // Needs a real cluster (>= MIN_CLUSTER_SIZE nodes sharing a topic tag) so the
  // legend renders at all; the shared-marker row is appended to it.
  function clusteredNodes(withCompany: boolean) {
    const base = [
      node({ id: "c0", tags: ["cycling"] }),
      node({ id: "c1", tags: ["cycling"] }),
      node({ id: "c2", tags: ["cycling"] }),
    ];
    if (withCompany) base.push(node({ id: "shared", tags: ["cycling"], workspace: "company" }));
    return base;
  }

  it("appends the shared-legend row when a company node is present", async () => {
    const { fn } = jsonFetch({ ok: true, nodes: clusteredNodes(true), edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    const label = ctx.t("graph.sharedLegend");
    const calls = ctx2d.calls as unknown[][];
    expect(calls.some((c) => c[0] === "fillText" && c[1] === label)).toBe(true);
  });

  it("omits the shared-legend row when no company node exists", async () => {
    const { fn } = jsonFetch({ ok: true, nodes: clusteredNodes(false), edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    const label = ctx.t("graph.sharedLegend");
    const calls = ctx2d.calls as unknown[][];
    expect(calls.some((c) => c[0] === "fillText" && c[1] === label)).toBe(false);
  });

  it("still draws the legend for the shared-marker row alone, when every node is loose (no cluster rows)", async () => {
    // Untagged nodes never join a cluster (assignGraphClusters puts them in the
    // unlabelled __loose__ bucket), so clusterLegend is empty. The legend used to
    // be gated on clusterLegend.length alone, which meant a graph of nothing but
    // loose shared nodes drew rings with no key explaining them.
    const nodes = [node({ id: "shared", workspace: "company" }), node({ id: "mine", workspace: "personal" })];
    const { fn } = jsonFetch({ ok: true, nodes, edges: [] });
    const { ctx, ctx2d } = setup(fn);
    await ctx.loadGraph();
    const label = ctx.t("graph.sharedLegend");
    const calls = ctx2d.calls as unknown[][];
    expect(calls.some((c) => c[0] === "fillText" && c[1] === label)).toBe(true);
  });
});
