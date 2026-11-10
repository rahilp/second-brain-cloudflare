import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/config";
import type { Config } from "../../src/config";
import type { RecallInternalOptions } from "../../src/recall/types";
import { NeuronBudget, ReplayStore, makeReplayAi } from "./ai-replay";
import { loadCorpus, type LoadedCorpus } from "./corpus/loader";
import { ACTORS, EVAL_NOW, IDENTITIES, WORKSPACES, type CorpusEntry } from "./corpus/types";
import { readScopeWorkspaces } from "../../src/lib/scope";
import { vectorizeFilterState } from "../../src/vectorize/scope";
import { EVAL_TOP_K, RUNNER_VERSION, findLeaks, freezeClock, readReport, runVariant, writeReport } from "./runner";
import type { EmbeddingProducer, GoldenQuery, VariantReport } from "./types";
import { hashVector } from "./vectors";
import { RERANK_MODEL } from "../../src/constants";
import { dryReranker } from "./prepare";
import { checkRerankRoute } from "./runner";
import { getVariant, registerVariant, unregisterVariant } from "./variants";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTemp } from "../helpers/tmp";

afterEach(cleanTemp);

type Call = { params: Record<string, unknown>; ctx: ExecutionContext; cfg: Readonly<Config>; internal: RecallInternalOptions; now: number };
const seen: Call[] = [];
let bypassDb: unknown; // drift probe: hand recall the unguarded DB
vi.mock("../../src/recall/search", async (orig) => {
  const actual = await orig<typeof import("../../src/recall/search")>();
  return {
    ...actual,
    recallEntries: (params: Call["params"], env: never, ctx: ExecutionContext, cfg: Readonly<Config>, internal: RecallInternalOptions) => {
      seen.push({ params, ctx, cfg, internal, now: Date.now() });
      return actual.recallEntries(params as never, bypassDb ? { ...(env as object), DB: bypassDb } as never : env, ctx, cfg, internal);
    },
  };
});

const MODEL = "@cf/baai/bge-small-en-v1.5";
const row = (id: string, content: string, ws: keyof typeof WORKSPACES = "avery"): CorpusEntry => ({
  id, content, tags: [], source: "api", createdAt: EVAL_NOW - 86_400_000, workspaceId: WORKSPACES[ws], actorId: ACTORS.avery,
});
const entries = [
  row("a1", "xylo alpha quarterly plan"),
  row("b1", "xylo alpha quarterly plan", "blake"), // decoy: same words, another user's workspace
  row("c1", "shared roadmap for the xylo launch", "company"),
  ...Array.from({ length: 20 }, (_, i) => row(`f${i}`, `weekly gardening note number ${i} about tomatoes`)),
];
const queries: GoldenQuery[] = [
  { id: "q1", category: "rare-word", text: "xylo alpha", gold: [{ id: "a1", grade: 2 }], viewer: "avery" },
  { id: "q2", category: "paraphrase", text: "shared roadmap launch", gold: [{ id: "c1", grade: 2 }], viewer: "avery" },
  { id: "q3", category: "rare-word", text: "xylo alpha", gold: [{ id: "b1", grade: 2 }], viewer: "blake" },
];

let open: LoadedCorpus[] = [];
afterEach(async () => {
  seen.length = 0; bypassDb = undefined; await Promise.all(open.map(c => c.close())); open = []; });

async function corpus(dryOther?: (model: string, input: unknown) => unknown): Promise<LoadedCorpus> {
  const c = await loadCorpus({
    spec: { id: "tiny", intent: "tie", entries, edges: [], queries },
    backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry", dryOther }), embeddingModel: MODEL,
  });
  open.push(c);
  return c;
}
const run = (c: LoadedCorpus, name = "no-rerank", isolate: "warm" | "cold" = "warm") =>
  runVariant({ corpus: c, variant: getVariant(name), queries, isolate, embeddingModel: MODEL });

it("uses a query's as-of clock and excludes later documents without changing the next query's clock", async () => {
  const c = await corpus();
  const at = EVAL_NOW - 3 * 86_400_000;
  const dated: GoldenQuery[] = [
    { ...queries[0], id: "dated", asOf: at },
    { ...queries[0], id: "undated" },
  ];
  await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: dated, isolate: "cold", embeddingModel: MODEL });
  expect(seen.find(call => call.params.query === "xylo alpha" && call.now === at)?.params.before).toBe(at + 1);
  expect(seen.some(call => call.params.query === "xylo alpha" && call.now === EVAL_NOW && call.params.before === undefined)).toBe(true);
});

it("passes asOf only for a query carrying asOfParam (T-0089.2.6), ahead of B3 adding the param to recallEntries", async () => {
  const c = await corpus();
  const at = EVAL_NOW - 5 * 86_400_000;
  const withAsOfParam: GoldenQuery[] = [
    { ...queries[0], id: "with-asof-param", asOfParam: at },
    { ...queries[0], id: "without-asof-param" },
  ];
  await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: withAsOfParam, isolate: "cold", embeddingModel: MODEL });
  const withCall = seen.find(call => call.params.query === "xylo alpha" && (call.params as { asOf?: number }).asOf === at);
  expect(withCall).toBeDefined();
  const withoutCall = seen.find(call => call.params.query === "xylo alpha" && !("asOf" in call.params));
  expect(withoutCall).toBeDefined();
});

it("measures standing cosine from the embedding used by recall", async () => {
  const q: GoldenQuery = { id: "standing-probe", category: "standing", text: "arranging a flight", gold: [{ id: "st-one", grade: 2 }], viewer: "avery", tags: ["standing:yes", "split:dev"] };
  const c = await loadCorpus({
    spec: { id: "standing-probe", intent: "tie", entries: [{ ...row("st-one", "When arranging a flight, check the calendar"), tags: ["standing"] }], edges: [], queries: [q] },
    backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry" }), embeddingModel: MODEL,
  });
  open.push(c);
  const report = await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: [q], isolate: "cold", embeddingModel: MODEL });
  expect(report.standing?.memories).toBe(1);
  expect(report.standing?.groups.yes).toBe(1);
  // Deliberate: Task 2 (T-0089.7.1) moved the reported grid from THRESHOLD_GRID (13) to THRESHOLD_GRID_FINE (21).
  expect(report.standing?.inputs.distilled.curve).toHaveLength(21);
  expect(report.standing?.inputs.raw.curve).toHaveLength(21);
  expect(report.results[0].error).toBeUndefined();
});

describe("runVariant", () => {
  it("returns per-query results with real cost fields and no cross-workspace leaks", async () => {
    const report = await run(await corpus());
    expect(report).toMatchObject({ schema: 1, variant: "no-rerank", corpus: "tiny", d1Backend: "sqlite", isolate: "warm" });
    const [q1, q2, q3] = report.results;
    expect(q1.rankedIds).toContain("a1");
    expect(q1.rankedIds).not.toContain("b1"); // the decoy belongs to another user
    expect(q2.rankedIds).toContain("c1");
    expect(q3.rankedIds).toContain("b1");
    expect(q3.rankedIds).not.toContain("a1");
    expect(report.results.every(r => r.leaked.length === 0 && !r.error)).toBe(true);
    expect(q1.cost).toMatchObject({ embeddingCalls: 1, vectorizeQueries: expect.any(Number), d1RowsRead: null });
    expect(q1.cost.d1Statements).toBeGreaterThan(0);
    expect(q1.cost.neurons).toBeGreaterThan(0);
    expect(q1.ftsRoute).toBe("fts");
    expect(q1.metrics.recall10).toBe(1);
  });

  it("is deterministic: two runs give identical rankings, and the wall clock does not matter", async () => {
    const c = await corpus();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    const first = await run(c);
    vi.setSystemTime(new Date("2040-06-01T00:00:00Z"));
    const second = await run(c);
    vi.useRealTimers();
    expect(second.results.map(r => [r.queryId, r.rankedIds, r.metrics])).toEqual(first.results.map(r => [r.queryId, r.rankedIds, r.metrics]));
  });

  it("freezes Date.now during the run and restores it afterwards", async () => {
    const real = Date.now;
    const restore = freezeClock(EVAL_NOW);
    expect(Date.now()).toBe(EVAL_NOW);
    restore();
    expect(Date.now).toBe(real);
  });

  it("never mutates recall_count, so query order cannot change later results", async () => {
    const c = await corpus();
    await run(c);
    const sum = await c.env.DB.prepare(`SELECT COALESCE(SUM(recall_count), 0) AS n FROM entries`).first<{ n: number }>();
    expect(sum!.n).toBe(0);
  });

  it("routes each built-in variant the way its description says", async () => {
    const c = await corpus();
    expect((await run(c, "no-rerank")).results[0].ftsRoute).toBe("fts");
    expect((await run(c, "like")).results[0].ftsRoute).toBe("like-not-ready");
    expect((await run(c, "dense-only")).results[0].ftsRoute).toBe("skipped-by-variant");
    const keywordOnly = await run(c, "keyword-only");
    expect(keywordOnly.results[0].cost).toMatchObject({ embeddingCalls: 0, vectorizeQueries: 0 });
    expect(keywordOnly.results[0].rankedIds).toContain("a1");
    expect((await run(c, "no-rerank")).results[0].ftsRoute).toBe("fts"); // ready flag restored per run
  });

  it("records a per-query error instead of aborting the run, and scores it as a miss", async () => {
    const c = await corpus();
    const empty = makeReplayAi({ store: new ReplayStore([]), mode: "replay" });
    (c.env as { AI: unknown }).AI = empty.ai;
    (c as { replay: unknown }).replay = empty;
    const report = await run(c);
    expect(report.results[0].error).toMatch(/replay cache miss/);
    expect(report.results[0].rankedIds).toEqual([]);
    expect(report.results[0].metrics.recall10).toBe(0);
  });

  it("refuses to run a variant whose index-time build differs from the loaded corpus", async () => {
    const c = await corpus();
    await expect(runVariant({ corpus: c, variant: { name: "alt", description: "x", index: { id: "alt-index", storeEntry: (async () => { throw new Error("unused"); }) as never } }, queries, isolate: "warm", embeddingModel: MODEL }))
      .rejects.toThrow(/index/);
  });

  it("round-trips a report through JSON", async () => {
    const report = await run(await corpus());
    const path = join(mkdtempSync(join(tmpdir(), "eval-report-")), "r.json");
    writeReport(path, report);
    expect(readReport(path)).toEqual(report);
  });
});

describe("findLeaks", () => {
  it("flags ids in a workspace the viewer cannot read, and ids it cannot place", () => {
    const workspaceOf = new Map([["a", "ws-avery"], ["b", "ws-blake"]]);
    expect(findLeaks(["a", "b", "ghost"], new Set(["ws-avery"]), workspaceOf)).toEqual(["b", "ghost"]);
  });
});

describe("runner determinism rules", () => {
  it("runs recall with the default config and freezes Date.now at EVAL_NOW for every call", async () => {
    const c = await corpus();
    await c.env.OAUTH_KV.put("config:overrides", JSON.stringify({ DEFAULT_HOPS: 3, KEYWORD_CANDIDATE_LIMIT: 1 }));
    await run(c);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.cfg).toEqual({ ...DEFAULTS, EMBEDDING_MODEL: MODEL, RERANK_MODE: "off" }); // no-rerank pins the mode; KV overrides never reach the run
      expect(Object.isFrozen(call.cfg)).toBe(true);
      expect(call.now).toBe(EVAL_NOW);
    }
  });

  it("hands recall a waitUntil that does nothing and never synthesizes", async () => {
    const c = await corpus();
    await run(c);
    for (const call of seen) {
      expect(call.params).toMatchObject({ topK: 10, synthesize: false });
      const ran = vi.fn();
      expect(call.ctx.waitUntil(Promise.resolve().then(ran))).toBeUndefined();
      expect(Object.keys(call.ctx)).toEqual(["waitUntil"]);
    }
  });

  it("runs queries sequentially in file order and reports in that order", async () => {
    const c = await corpus();
    const order: string[] = [];
    const report = await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries, isolate: "cold", embeddingModel: MODEL, onProgress: (d) => order.push(String(d)) });
    expect(report.results.map(r => r.queryId)).toEqual(["q1", "q2", "q3"]);
    expect(order).toEqual(["1", "2", "3"]);
  });

  it("does not synthesize: no LLM call reaches the AI binding", async () => {
    const c = await corpus();
    const report = await run(c);
    expect(report.results.every(r => r.cost.aiCalls === r.cost.embeddingCalls)).toBe(true);
  });

  it("warm mode pre-warms per viewer and scores each query once; cold mode pays the readiness read every query", async () => {
    const c = await corpus();
    const warm = await run(c, "no-rerank", "warm");
    const cold = await run(c, "no-rerank", "cold");
    expect(warm.results).toHaveLength(3);
    expect(seen.length).toBe(2 + 3 + 3); // two viewers warmed once, then 3 scored, then 3 cold
    // the only difference is the readiness flag read, which cold repeats on every query
    expect(cold.results.map((r, i) => r.cost.kvReads - warm.results[i].cost.kvReads)).toEqual([1, 1, 1]);
    expect(cold.results.map(r => r.rankedIds)).toEqual(warm.results.map(r => r.rankedIds));
  });

  it("flags a leak when recall returns an id the viewer cannot read", async () => {
    const c = await corpus();
    c.workspaceOf.set("a1", WORKSPACES.outsider); // mislabel a1 so a legitimate hit looks foreign
    const report = await run(c);
    expect(report.results[0].leaked).toContain("a1");
  });

  it.skipIf(!process.env.EVAL_WORKERD)("workerd reports real rows_read", async () => {
    const c = await loadCorpus({
      spec: { id: "tiny", intent: "tie", entries, edges: [], queries },
      backend: "workerd", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry" }), embeddingModel: MODEL,
    });
    open.push(c);
    const report = await run(c);
    expect(report.results.every(r => typeof r.cost.d1RowsRead === "number" && r.cost.d1RowsRead > 0)).toBe(true);
 }, 180_000); // a workerd boot on a CI runner (or under parallel load) takes well over 30 s; the corpus is tiny
});

describe("leak sentinel", () => {
  it("flags an unplaceable id even for an admin whose readable set contains the empty string", () => {
    const readable = new Set(readScopeWorkspaces(IDENTITIES.avery));
    expect(readable.has("")).toBe(true); // premise: the admin identity's default share is ""
    expect(findLeaks(["ghost"], readable, new Map())).toEqual(["ghost"]);
  });
});

describe("degraded recalls", () => {
  const dead = (c: LoadedCorpus) => { (c.vectorize as unknown as { query: unknown }).query = async () => { throw new Error("vectorize down"); }; };

  it("records a dead dense arm on the query instead of reporting a clean run", async () => {
    const c = await corpus();
    dead(c);
    const report = await run(c);
    expect(report.results.every(r => !r.error)).toBe(true);
    expect(report.results.every(r => r.degraded?.includes("semantic-unavailable"))).toBe(true);
  });

  it("records a rejected workspace filter as degraded", async () => {
    const c = await corpus();
    (c.env as { VECTORIZE: unknown }).VECTORIZE = c.vectorize.withMetadataIndexes([]);
    const report = await run(c);
    expect(report.results.every(r => r.degraded?.includes("vectorize-filter-unfiltered"))).toBe(true);
  });

  it("records an FTS failure that fell back to LIKE as degraded", async () => {
    const c = await corpus();
    await c.env.DB.prepare(`DROP TABLE entries_fts`).run(); // the ready flag still says fts
    const report = await run(c);
    expect(report.results[0].ftsRoute).toBe("like-error");
    expect(report.results.every(r => r.degraded?.includes("fts-error"))).toBe(true);
  });

  it("records a first() statement that returns more than one row as degraded (the observer would fetch them all)", async () => {
    const c = await corpus();
    const real = c.env.DB;
    const doubled = (st: any): any => new Proxy(st, {
      get: (t, p) => p === "bind" ? (...a: unknown[]) => doubled(t.bind(...a))
        : p === "all" ? async () => { const r = await t.all(); return { ...r, results: [...r.results, ...r.results] }; }
        : typeof t[p] === "function" ? t[p].bind(t) : t[p],
    });
    (c.env as { DB: unknown }).DB = new Proxy(real, {
      get: (t, p) => p === "prepare" ? (sql: string) => (sql.includes("SELECT COUNT(*) AS total") ? doubled(t.prepare(sql)) : t.prepare(sql)) : typeof (t as any)[p] === "function" ? (t as any)[p].bind(t) : (t as any)[p],
    });
    const report = await run(c, "like"); // the LIKE document-frequency probe is the recall first() statement
    expect(report.results.some(r => r.degraded?.includes("first-returned-many-rows"))).toBe(true);
  });

  it("leaves a healthy run with no degradation", async () => {
    const report = await run(await corpus());
    expect(report.results.map(r => r.degraded)).toEqual([[], [], []]);
  });
});

describe("report identity", () => {
  it("carries clusterKey into the report and defaults it to the query id", async () => {
    const c = await corpus();
    const qs: GoldenQuery[] = [{ ...queries[0], clusterKey: "grp" }, queries[1]];
    const report = await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: qs, isolate: "warm", embeddingModel: MODEL });
    expect(report.results.map(r => r.clusterKey)).toEqual(["grp", "q2"]);
  });

  it("records the top-k and runner version so reports from different harnesses are not compared", async () => {
    const report = await run(await corpus());
    expect(report).toMatchObject({ topK: EVAL_TOP_K, runnerVersion: RUNNER_VERSION });
  });
});

describe("model producers in the report", () => {
  const mk = (repo: string): EmbeddingProducer => ({ kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "4.3.0", onnxRuntime: "onnxruntime-node@1.30.0", repo, revision: "abc", dtype: "fp32" });
  const RERANK = "@cf/baai/bge-reranker-base";

  it("carries the producer of every model the run used (verified rows only), and labels neurons as projected", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-producer-"));
    mkdirSync(join(root, ".eval-cache"), { recursive: true });
    const file = join(root, ".eval-cache", "p.jsonl");
    const live = {
      run: async (model: string, input: unknown) => model === RERANK ? { response: [], usage: { prompt_tokens: 3, total_tokens: 3 } }
        : { data: (input as { text: string[] }).text.map(t => hashVector(t, 384)), usage: { prompt_tokens: 3, total_tokens: 3 } },
      producer: (model: string) => mk(model === RERANK ? "BAAI/bge-reranker-base" : "BAAI/bge-small-en-v1.5"),
    };
    const replay = makeReplayAi({ store: new ReplayStore([], file, { root }), mode: "record", live });
    const c = await loadCorpus({ spec: { id: "tiny", intent: "tie", entries, edges: [], queries }, backend: "sqlite", replay, embeddingModel: MODEL });
    open.push(c);
    await replay.ai.run(RERANK as never, { query: "q", contexts: [{ text: "x" }] } as never); // a variant that reranks
    const report = await run(c);
    expect(report.producers).toEqual({ [MODEL]: mk("BAAI/bge-small-en-v1.5"), [RERANK]: mk("BAAI/bge-reranker-base") });
    expect(report.neuronSource).toBe("projected");
  });

  it("records which tag arm answered the LLM calls", async () => {
    const stand = await run(await corpus());
    expect(stand.llmTags).toBe("stand-in");
    const c = await loadCorpus({ spec: { id: "tiny", intent: "tie", entries, edges: [], queries }, backend: "sqlite", replay: makeReplayAi({ store: new ReplayStore([]), mode: "dry", llmTags: "empty" }), embeddingModel: MODEL });
    open.push(c);
    expect((await run(c)).llmTags).toBe("empty");
  });

  it("rejects a report whose llmTags is not a known arm", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eval-arm-")), "r.json");
    writeReport(path, { ...({ schema: 1, variant: "v", corpus: "c", embeddingModel: "m", d1Backend: "sqlite", isolate: "warm", topK: 10, runnerVersion: RUNNER_VERSION, results: [] } as VariantReport), llmTags: "oracle" as never });
    expect(() => readReport(path)).toThrow(/llmTags/);
  });

  it("carries no producers and no neuron source when nothing had verified provenance (hash smoke, dry run)", async () => {
    const report = await run(await corpus());
    expect(report.producers).toBeUndefined();
    expect(report.neuronSource).toBeUndefined();
  });
});

describe("stand-in failures fail closed", () => {
  const tagged = entries.map(e => ({ ...e, tags: ["gardening", "planning"] }));
  const qs: GoldenQuery[] = [{ id: "t1", category: "paraphrase", text: "tomato advice", gold: [{ id: "f1", grade: 2 }], viewer: "avery" }];
  const producer: EmbeddingProducer = { kind: "local-transformers-js", library: "@huggingface/transformers", libraryVersion: "4.3.0", onnxRuntime: "onnxruntime-node@1.30.0", repo: "BAAI/bge-small-en-v1.5", revision: "abc", dtype: "fp32" };
  const live = { run: async (_m: string, input: unknown) => ({ data: (input as { text: string[] }).text.map(t => hashVector(t, 384)) }), producer: () => producer };

  async function recorded() {
    const root = mkdtempSync(join(tmpdir(), "eval-standin-"));
    mkdirSync(join(root, ".eval-cache"), { recursive: true });
    const file = join(root, ".eval-cache", "s.jsonl");
    // the empty arm records the corpus and the query embedding but no tag embeddings
    const rec = makeReplayAi({ store: new ReplayStore([], file, { root }), mode: "record", live, budget: new NeuronBudget(1e6), llmTags: "empty" });
    const c = await loadCorpus({ spec: { id: "tiny", intent: "tie", entries: tagged, edges: [], queries: qs }, backend: "sqlite", replay: rec, embeddingModel: MODEL });
    try { await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: qs, isolate: "warm", embeddingModel: MODEL }); } finally { await c.close(); }
    return () => makeReplayAi({ store: new ReplayStore([file], undefined, { root }), mode: "replay" });
  }

  // Recall no longer calls the tag LLM; issue the retired call from the embedding so the stand-in's fail-closed path stays covered.
  const withLegacyTagCall = (replay: ReturnType<typeof makeReplayAi>, when: (text: string) => boolean = () => true) => {
    const ai = replay.ai as unknown as { run: (m: string, i: { text?: string[] }) => Promise<unknown> };
    const run = ai.run.bind(ai);
    ai.run = (m, i) => {
      if (m === MODEL && i.text && when(i.text[0])) {
        const content = "From this list of tags: gardening, planning\n\nWhich tags best match this query? Reply with only a comma-separated list of matching tag names from the list, or nothing if none apply.\n\nQuery: tomato advice";
        void run(DEFAULTS.LLM_MODEL, { messages: [{ role: "user", content }], max_tokens: 100, stream: true } as never).catch(() => {});
      }
      return run(m, i);
    };
    return replay;
  };
  const replayRun = async (replay: ReturnType<typeof makeReplayAi>) => {
    const c = await loadCorpus({ spec: { id: "tiny", intent: "tie", entries: tagged, edges: [], queries: qs }, backend: "sqlite", replay, embeddingModel: MODEL });
    open.push(c);
    withLegacyTagCall(replay);
    return runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: qs, isolate: "warm", embeddingModel: MODEL });
  };

  it("a tag embedding missing from the cache becomes that query's error instead of an empty tag list", async () => {
    const report = await replayRun((await recorded())());
    expect(report.llmTags).toBe("stand-in");
    expect(report.results[0].error).toMatch(/query-tag stand-in failed.*replay cache miss/);
    expect(report.results[0].rankedIds).toEqual([]);
  });

  it("a prompt the stand-in cannot parse becomes that query's error", async () => {
    const replay = (await recorded())();
    const run = (replay.ai as unknown as { run: (m: string, i: { messages?: { role: string; content: string }[] }) => Promise<unknown> }).run.bind(replay.ai);
    (replay.ai as unknown as { run: typeof run }).run = (m, i) =>
      run(m, i.messages ? { ...i, messages: [{ role: "user", content: i.messages[0].content.replace("Which tags best match", "Which tags match") }] } : i);
    const report = await replayRun(replay); // the legacy call goes through the drifting wrapper above
    expect(report.results[0].error).toMatch(/query-tag stand-in failed.*inferQueryTags prompt/);
  });

  it("an embedding failure plus a slower failing stand-in charges the same query, never the next", async () => {
    const recorded = mkdtempSync(join(tmpdir(), "eval-standin-"));
    mkdirSync(join(recorded, ".eval-cache"), { recursive: true });
    let armed = false;
    const timing = { producer: () => producer, run: async (_m: string, input: unknown) => {
      const t = (input as { text: string[] }).text[0];
      if (armed && (t === "gardening" || t === "planning")) { await new Promise(r => setTimeout(r, 80)); throw new Error("tag boom"); } // the stand-in fails later
      if (armed && t === "advice") throw new Error("embedding boom"); // the first query's main embedding (of its distilled text) fails at once
      return { data: [hashVector(t, 384)] };
    } };
    const replay = makeReplayAi({ store: new ReplayStore([], join(recorded, ".eval-cache", "t.jsonl"), { root: recorded }), mode: "record", live: timing, budget: new NeuronBudget(1e6) });
    const two: GoldenQuery[] = [
      { id: "t1", category: "paraphrase", text: "tomato advice", gold: [{ id: "f1", grade: 2 }], viewer: "avery" }, // no tag word: reaches the stand-in
      { id: "t2", category: "paraphrase", text: "#gardening notes", gold: [{ id: "f1", grade: 2 }], viewer: "avery" }, // a hashtag: never calls the LLM
    ];
    const c = await loadCorpus({ spec: { id: "tiny", intent: "tie", entries: tagged, edges: [], queries: two }, backend: "sqlite", replay, embeddingModel: MODEL });
    open.push(c);
    withLegacyTagCall(replay, t => t === "advice"); // only t1 ran the retired call; t2's hashtag never did
    armed = true;
    const report = await runVariant({ corpus: c, variant: getVariant("no-rerank"), queries: two, isolate: "cold", embeddingModel: MODEL });
    const [t1, t2] = report.results;
    expect(t1.error).toMatch(/embedding boom/);
    expect(t1.error).toMatch(/query-tag stand-in failed.*tag boom/); // its own late failure, waited for
    expect(t2.error).toBeUndefined(); // and not billed to the query that follows
  });

  it("the empty arm still runs clean", async () => {
    const report = await replayRun(makeReplayAi({ store: new ReplayStore([]), mode: "dry", llmTags: "empty" }));
    expect(report.llmTags).toBe("empty");
    expect(report.results[0].error).toBeUndefined();
  });
});

describe("isolate hygiene", () => {
  const strict = async () => {
    const c = await corpus();
    (c.env as { VECTORIZE: unknown }).VECTORIZE = c.vectorize.withMetadataIndexes([]);
    return c;
  };
  const probes = (r: Awaited<ReturnType<typeof run>>) => r.results.map(x => x.cost.vectorizeQueries);

  it("starts every run with a fresh Vectorize filter latch", async () => {
    const a = await run(await strict());
    expect(a.results.every(r => r.degraded?.includes("vectorize-filter-unfiltered"))).toBe(true);
    expect(vectorizeFilterState().supported).toBe(false); // the first run left the latch tripped
    const b = await run(await corpus()); // a healthy index must not inherit that state
    expect(b.results.map(r => r.degraded)).toEqual([[], [], []]);
  });

  it("cold mode re-probes the filter on every query; warm mode learns it once", async () => {
    const c = await strict();
    const warm = await run(c, "no-rerank", "warm");
    const cold = await run(c, "no-rerank", "cold");
    const healthy = await run(await corpus(), "no-rerank", "warm");
    // Recall issues two dense queries. Once learned, a missing index costs what a healthy one
    // does; a cold isolate re-learns it with one unfiltered probe per query.
    expect(probes(healthy)).toEqual([2, 2, 2]);
    expect(probes(warm)).toEqual([2, 2, 2]);
    expect(probes(cold)).toEqual([3, 3, 3]);
  });

  it("restores Date.now even when the run itself throws", async () => {
    const c = await corpus();
    const real = Date.now;
    vi.spyOn(c.env.OAUTH_KV, "put").mockRejectedValue(new Error("kv down"));
    await expect(run(c)).rejects.toThrow(/kv down/);
    expect(Date.now).toBe(real);
    vi.restoreAllMocks();
  });
});

describe("seam and guard", () => {
  it("fts-orderless reaches recall as keywordPreRankedOverride=false; baseline leaves it unset", async () => {
    const c = await corpus();
    await run(c, "fts-orderless");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(x => x.internal.keywordPreRankedOverride === false)).toBe(true);
    seen.length = 0;
    await run(c, "no-rerank");
    expect(seen.every(x => x.internal.keywordPreRankedOverride === undefined)).toBe(true);
  });

  it("fails the run at the point of breakage if the recall_count write stops being intercepted", async () => {
    const c = await corpus();
    bypassDb = c.env.DB;
    await expect(run(c)).rejects.toThrow(/recall_count/);
  });
});

describe("variant registry", () => {
  it("registers, resolves and unregisters a variant; refuses duplicates and builtins", () => {
    registerVariant({ name: "tmp-x", description: "x" });
    expect(getVariant("tmp-x").name).toBe("tmp-x");
    expect(() => registerVariant({ name: "tmp-x", description: "y" })).toThrow(/already/);
    unregisterVariant("tmp-x");
    expect(() => getVariant("tmp-x")).toThrow(/unknown variant/);
    expect(() => unregisterVariant("baseline")).toThrow(/builtin/);
    expect(() => registerVariant({ name: "baseline", description: "z" })).toThrow(/already/);
  });
});

describe("the reranker under the runner", () => {
  it("checkRerankRoute passes healthy routes and fails a fail-open fallback", () => {
    const call = { model: RERANK_MODEL };
    expect(checkRerankRoute(true, "applied", [call])).toBeUndefined();
    for (const route of ["too-few", "exact-id", "clear-leader"]) expect(checkRerankRoute(true, route, [])).toBeUndefined();
    for (const route of [undefined, "off", "not-ready", "error", "timeout", "attempted"]) expect(checkRerankRoute(true, route, [])).toMatch(/ended in/);
    expect(checkRerankRoute(true, "applied", [])).toMatch(/expected exactly one/);
    expect(checkRerankRoute(true, "applied", [call, call])).toMatch(/expected exactly one/);
    expect(checkRerankRoute(true, "clear-leader", [call])).toMatch(/made 1 model call/);
    expect(checkRerankRoute(false, "off", [])).toBeUndefined();
    expect(checkRerankRoute(false, undefined, [])).toBeUndefined(); // an ablation that returns before the step (keyword-only with no candidates)
    expect(checkRerankRoute(false, "applied", [call])).toMatch(/off for this variant/);
  });

  it("a forced variant makes exactly one reranker call per applied query, and reports the route", async () => {
    const report = await run(await corpus(dryReranker), "rerank");
    const applied = report.results.filter(r => r.rerankRoute === "applied");
    expect(applied.length).toBeGreaterThan(0);
    expect(report.results.filter(r => r.error)).toEqual([]);
    const noRerank = await run(await corpus(dryReranker), "no-rerank");
    for (const r of applied) {
      const base = noRerank.results.find(x => x.queryId === r.queryId)!;
      expect(r.cost.aiCalls).toBe(base.cost.aiCalls + 1);
    }
    expect(noRerank.results.every(r => r.rerankRoute === undefined)).toBe(true);
  });

  it("a missing reranker answer is that query's error, never a silent un-reranked result", async () => {
    const report = await run(await corpus(), "rerank"); // dry replay with no reranker answer: the miss throws, production would fail open
    const failed = report.results.filter(r => r.error);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].error).toMatch(/reranker step ended in "error"/);
  });
});
