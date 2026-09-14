/**
 * loadGraph's author filter, end to end: resolving the selected id to the
 * name /graph nodes actually carry, and pruning the canvas to that author.
 *
 * The pure narrowing logic (filterGraphByActor) is unit-tested directly in
 * graph-clusters.test.ts; this file is about the wiring around it: the id
 * from #actor-filter-recent has to become the same "You" / real-name string
 * the server puts on actor_name before that function can match anything.
 * initGraphSim itself (packing/drawing) is exercised in graph-layer.test.ts;
 * here it is stubbed to a spy so these tests only assert what loadGraph
 * decided to hand it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

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

function setup(nodes: unknown[], edges: unknown[] = []) {
  const elements = new Map<string, any>();
  for (const id of ["graph-empty", "graph-layer-wrap", "graph-layer", "graph-canvas"]) {
    const el = makeEl();
    el.id = id;
    elements.set(id, el);
  }
  const doc = {
    documentElement: { lang: "en", getAttribute: () => null },
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
    window: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: "en-US" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, nodes, edges }) }),
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
    devicePixelRatio: 1,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // recent.js owns memoryActorFilter/memoryAuthors and is not part of this
  // file's SRC bundle; declared with `var` (not `let`) so the host can set
  // them directly, the same way recent.js's own onActorFilterChange and
  // loadMemoryAuthors populate them.
  vm.runInContext("var memoryActorFilter = null; var memoryAuthors = null; var TEAM_MODE = true;", ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok";`, ctx);
  ctx.initI18n("en");

  // initGraphSim's packing/drawing is exercised elsewhere (graph-layer.test.ts);
  // here it is replaced with a spy so loadGraph's own decision (which nodes
  // and edges survive the actor filter) can be asserted directly. A function
  // *declaration* becomes a property of the vm's global object, and loadGraph
  // looks that identifier up fresh on every call, so reassigning it from the
  // host after runInContext is enough to intercept it.
  let lastCall: { nodes: any[]; edges: any[] } | null = null;
  ctx.initGraphSim = (_canvas: unknown, gotNodes: any[], gotEdges: any[]) => {
    lastCall = { nodes: gotNodes, edges: gotEdges };
  };
  return { ctx, els: elements, lastCall: () => lastCall };
}

const node = (over: Record<string, unknown>) => ({ id: "", label: "x", tags: [], ...over });

describe("graph author filter: resolving the selected id to a node's actor_name", () => {
  const nodes = [
    node({ id: "mine", actor_name: "You" }),
    node({ id: "graces", actor_name: "Grace Hopper" }),
  ];
  const edges = [{ source: "mine", target: "graces" }];

  it("shows only the selected teammate's nodes, resolved by id through the loaded roster", async () => {
    const { ctx, els, lastCall } = setup(nodes, edges);
    ctx.memoryAuthors = { you: "u1", members: [{ userId: "u1", name: "You (unused)" }, { userId: "u2", name: "Grace Hopper" }] };
    ctx.memoryActorFilter = "u2";
    await ctx.loadGraph();
    expect(lastCall()!.nodes.map((n) => n.id)).toEqual(["graces"]);
    expect(lastCall()!.edges).toEqual([]);
    expect(els.get("graph-empty").style.display).toBe("none");
  });

  it("shows the caller's own nodes as the literal server string 'You', not their real name", async () => {
    const { ctx, lastCall } = setup(nodes, edges);
    ctx.memoryAuthors = { you: "u1", members: [{ userId: "u1", name: "Rahil Pirani" }, { userId: "u2", name: "Grace Hopper" }] };
    ctx.memoryActorFilter = "u1";
    await ctx.loadGraph();
    expect(lastCall()!.nodes.map((n) => n.id)).toEqual(["mine"]);
  });

  it("shows the whole graph, not an empty canvas, when the roster has not loaded yet", async () => {
    // Defensive fallback: an id with nothing to resolve against must not be
    // treated as "match nothing" the way the actor_id-based filter used to.
    const { ctx, lastCall } = setup(nodes, edges);
    ctx.memoryActorFilter = "u2";
    await ctx.loadGraph();
    expect(lastCall()!.nodes.map((n) => n.id).sort()).toEqual(["graces", "mine"]);
  });

  it("shows the whole graph again once the filter is cleared", async () => {
    const { ctx, lastCall } = setup(nodes, edges);
    ctx.memoryAuthors = { you: "u1", members: [{ userId: "u1", name: "You (unused)" }, { userId: "u2", name: "Grace Hopper" }] };
    ctx.memoryActorFilter = "u2";
    await ctx.loadGraph();
    expect(lastCall()!.nodes.map((n) => n.id)).toEqual(["graces"]);

    ctx.memoryActorFilter = null;
    await ctx.loadGraph();
    expect(lastCall()!.nodes.map((n) => n.id).sort()).toEqual(["graces", "mine"]);
  });

  it("shows the true empty state, not a silent blank canvas, when the selected author has no nodes at all", async () => {
    const { ctx, els } = setup(nodes, edges);
    ctx.memoryAuthors = { you: "u1", members: [{ userId: "u1", name: "You (unused)" }, { userId: "u3", name: "Nobody Here" }] };
    ctx.memoryActorFilter = "u3";
    await ctx.loadGraph();
    expect(els.get("graph-empty").style.display).toBe("block");
    expect(els.get("graph-canvas").style.display).toBe("none");
  });
});
