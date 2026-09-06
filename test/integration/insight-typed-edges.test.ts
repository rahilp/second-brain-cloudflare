/**
 * C — turning the weekly insight call's spare verdict into typed edges.
 *
 * The call already reasons over two whole memories. It was returning prose and
 * nothing else, so the pass wrote at most three edges a week (the `drawn_from`
 * pair for each accepted insight) and learned nothing from the calls that
 * declined — which is most of them. Reading the relationship off every settled
 * response types roughly ten pairs a week at no extra model cost.
 *
 * The decline path is therefore the important one to test, not an edge case:
 * a version of this that only fired on accepted insights would be worth about
 * a third of it.
 *
 * Direction is taken from `created_at`, never from the candidate row's id
 * ordering. `insight_candidates` stores its pair with a_id < b_id, which is
 * lexicographic on a UUID and says nothing whatever about which was written
 * first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWeeklyInsights } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

/** Long enough and specific enough to clear the insight quality floor. */
const GOOD_TEXT =
  "You priced that tier at nine dollars flat, then reversed course to usage-based billing once the margin review landed.";

function makeAI(insightPayload: string) {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      return sse(prompt.includes("Memory A:") ? insightPayload : "3");
    }),
  } as unknown as Ai;
}

describe("typed edges from the insight pass", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
  });

  afterEach(() => sqlite.close());

  /**
   * One candidate. `older` is written 120 days before `newer`, and the ids are
   * chosen so a_id < b_id lexicographically matches chronology — the direction
   * tests below then deliberately invert the model's claim to prove which of
   * the two the code actually uses.
   */
  function seedPair(opts: { aTags?: string[]; bTags?: string[] } = {}): void {
    sqlite.seed({
      id: "a-older", createdAt: NOW - 120 * DAY, tags: opts.aTags ?? ["kind:episodic"],
      content: "Decision: price the starter tier flat at nine dollars a month for predictable billing.",
    });
    sqlite.seed({
      id: "b-newer", createdAt: NOW, tags: opts.bTags ?? ["kind:episodic"],
      content: "Decision: move the starter tier to usage-based billing; flat pricing left margin on the table.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-older', 'b-newer', 0.87, ?, 10, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
  }

  function envWith(payload: string): Env {
    return makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(payload), OAUTH_KV: makeMemoryKV(),
    });
  }

  async function typedEdges(): Promise<{ source_id: string; target_id: string; type: string; provenance: string; weight: number; metadata: string }[]> {
    const r = await sqlite.db.prepare(
      `SELECT source_id, target_id, type, provenance, weight, metadata FROM edges
       WHERE type != 'drawn_from' ORDER BY type`,
    ).all() as any;
    return r.results;
  }

  it("types the pair when the model declined to write an insight", async () => {
    seedPair();
    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    expect(await typedEdges()).toEqual([
      expect.objectContaining({ source_id: "b-newer", target_id: "a-older", type: "caused_by" }),
    ]);
  });

  it("types the pair when the model also wrote an insight", async () => {
    seedPair();
    await runWeeklyInsights(
      envWith(`{"insight": true, "shape": "contradiction", "text": ${JSON.stringify(GOOD_TEXT)}, "relationship": "caused_by", "source": "A", "target": "B"}`),
      ctx,
    );

    expect((await typedEdges()).map(e => e.type)).toContain("caused_by");
  });

  it("stamps the edge as system-authored with its reasoning provenance", async () => {
    seedPair();
    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    const [edge] = await typedEdges();
    expect(edge.provenance).toBe("system");
    expect(edge.weight).toBe(0.75);
    expect(JSON.parse(edge.metadata)).toMatchObject({ via: "insight-reasoning" });
  });

  it("writes nothing when the model names no relationship", async () => {
    seedPair();
    await runWeeklyInsights(envWith('{"insight": false}'), ctx);

    expect(await typedEdges()).toEqual([]);
  });

  // The model is asked which side is the source, but for `follows` chronology
  // is not its to decide: it cannot see created_at. Here it claims the OLDER
  // memory follows the newer one, which is backwards.
  it("orients follows by created_at even when the model says otherwise", async () => {
    seedPair();
    await runWeeklyInsights(envWith('{"insight": false, "relationship": "follows", "source": "A", "target": "B"}'), ctx);

    expect(await typedEdges()).toEqual([
      expect.objectContaining({ source_id: "b-newer", target_id: "a-older", type: "follows" }),
    ]);
  });

  it("refuses a decided edge between two semantic memories", async () => {
    seedPair({ aTags: ["kind:semantic"], bTags: ["kind:semantic"] });
    await runWeeklyInsights(envWith('{"insight": false, "relationship": "decided", "source": "B", "target": "A"}'), ctx);

    // decided is episodic-only in the edge-type registry.
    expect(await typedEdges()).toEqual([]);
  });

  it("allows caused_by between semantic memories, which it does not constrain", async () => {
    seedPair({ aTags: ["kind:semantic"], bTags: ["kind:semantic"] });
    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    expect((await typedEdges()).map(e => e.type)).toEqual(["caused_by"]);
  });

  it("retires the inferred relates_to it supersedes", async () => {
    seedPair();
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('old', 'a-older', 'b-newer', 'relates_to', 0.8, 'inferred', '{}', 0, 0, '')`,
    ).run();

    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    expect((await typedEdges()).map(e => e.type)).toEqual(["caused_by"]);
  });

  it("keeps a relates_to the user drew themselves", async () => {
    seedPair();
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('mine', 'a-older', 'b-newer', 'relates_to', 0.9, 'explicit', '{}', 0, 0, '')`,
    ).run();

    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    expect((await typedEdges()).map(e => e.type).sort()).toEqual(["caused_by", "relates_to"]);
  });

  /**
   * Phase B can already have drawn the very same typed edge for this pair at
   * capture time, so the pass must upsert rather than collide.
   *
   * What this proves: the existing edge survives and keeps the STRONGER weight
   * — an explicit 0.9 is better evidence than the pass's flat 0.75 and must not
   * be written down to it. That is sensitive to the `max(weight, excluded.weight)`
   * in edgeInsertStatement's ON CONFLICT clause.
   *
   * What it CANNOT prove, and is not claimed: that a failed INSERT would take
   * the candidate status updates down with it. Real D1 runs a batch in one
   * transaction, so a constraint failure would roll back the status writes and
   * leave the pass re-reasoning the same pairs forever. The test facade
   * (test/helpers/sqlite-d1.ts) executes batched statements sequentially and
   * non-atomically, and the status updates are ordered first, so they commit
   * before any edge statement can throw. The protection is the ON CONFLICT
   * clause itself, pinned directly in the edge-upsert test in
   * test/integration/graph-follows.test.ts.
   */
  it("upserts onto an identical edge rather than colliding with it", async () => {
    seedPair();
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('already', 'b-newer', 'a-older', 'caused_by', 0.9, 'explicit', '{}', 0, 0, '')`,
    ).run();

    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    const edges = await typedEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.9);
  });

  /**
   * A replacement must not cost the pair its place in the graph.
   *
   * Inferred edges only exist at EDGE_INFER_THRESHOLD (0.78) and above, so a
   * flat 0.75 is BELOW every generic edge this replaces. Graph expansion sorts
   * `ORDER BY weight DESC` and applies a per-node fanout cap, so on a
   * well-connected root the typed edge can sort below the cut that the generic
   * edge cleared — turning "typed replaces generic" into "reachable becomes
   * unreachable". The typed edge therefore inherits the weight it retires when
   * that is higher.
   */
  it("keeps the weight of the stronger generic edge it replaces", async () => {
    seedPair();
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('old', 'a-older', 'b-newer', 'relates_to', 0.85, 'inferred', '{}', 0, 0, '')`,
    ).run();

    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    const edges = await typedEdges();
    expect(edges.map(e => e.type)).toEqual(["caused_by"]);
    expect(edges[0].weight).toBe(0.85);
  });

  it("uses its own weight when nothing stronger was there", async () => {
    seedPair();
    await runWeeklyInsights(envWith('{"insight": false, "relationship": "caused_by", "source": "B", "target": "A"}'), ctx);

    expect((await typedEdges())[0].weight).toBe(0.75);
  });
});
