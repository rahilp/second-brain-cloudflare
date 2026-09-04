/**
 * B2 — typing the one relationship capture already knows about.
 *
 * Two episodic memories written minutes apart are usually one train of thought,
 * and `relates_to` throws that away. The ordering is already in `created_at` and
 * the kinds are already in the tags the classifier writes, so `follows` costs no
 * model call — only the decision to record what is known.
 *
 * Driven against real SQLite: the pair-level DELETE behind typed-replaces-
 * generic and the `kind:` tag parsing are both things the string-matching D1
 * mock only approximates.
 *
 * The burst guard is the part worth arguing with. Importing a week of notes, or
 * a transcript splitting into many chunks, writes a dozen episodic entries in
 * one minute; each would "follow" the last, and the chain would be an artefact
 * of the write, not of the thinking. So `follows` is emitted only when exactly
 * one neighbour qualifies — a claim about a specific predecessor, or nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEdge, inferEdgesOnWrite, GRAPH_FOLLOWS_WINDOW_MS } from "../../src/graph/edges";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { captureEntry } from "../../src/capture/entry";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

const NOW = 1_700_000_000_000;
const EPISODIC = ["kind:episodic"];
const SEMANTIC = ["kind:semantic"];

describe("follows edges", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
    await initializeDatabase(env);
  });

  afterEach(() => sqlite.close());

  async function edges(): Promise<{ source_id: string; target_id: string; type: string }[]> {
    const r = await sqlite.db.prepare(`SELECT source_id, target_id, type FROM edges`).all() as any;
    return r.results;
  }

  /** The new entry, written at NOW, plus its neighbours at explicit offsets. */
  function seedPair(opts: {
    newKindTags?: string[];
    source?: string;
    neighbors: { id: string; agoMs: number; tags?: string[]; source?: string }[];
  }): void {
    sqlite.seed({ id: "new", content: "the entry being written", createdAt: NOW, tags: opts.newKindTags ?? EPISODIC, source: opts.source ?? "api" });
    for (const n of opts.neighbors) {
      sqlite.seed({ id: n.id, content: `neighbour ${n.id}`, createdAt: NOW - n.agoMs, tags: n.tags ?? EPISODIC, source: n.source ?? "api" });
    }
  }

  it("holds the window at 30 minutes", () => {
    expect(GRAPH_FOLLOWS_WINDOW_MS).toBe(30 * 60_000);
  });

  it("types the edge as follows when one episodic neighbour precedes it in the window", async () => {
    seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: "episodic" });

    expect(await edges()).toEqual([{ source_id: "new", target_id: "earlier", type: "follows" }]);
  });

  // A literal, not GRAPH_FOLLOWS_WINDOW_MS + n: deriving the fixture from the
  // constant makes the test move with it, so widening the window to a year
  // would still pass. The pin below is what makes such a change deliberate.
  it("leaves the edge generic when the neighbour is two hours old", async () => {
    seedPair({ neighbors: [{ id: "earlier", agoMs: 2 * 60 * 60_000 }] });

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: "episodic" });

    expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
  });

  it("emits no follows when several neighbours qualify, because a burst is not a train of thought", async () => {
    seedPair({
      neighbors: [
        { id: "burst-a", agoMs: 2 * 60_000 },
        { id: "burst-b", agoMs: 3 * 60_000 },
      ],
    });

    await inferEdgesOnWrite("new", [{ id: "burst-a", score: 0.85 }, { id: "burst-b", score: 0.84 }], env, { newKind: "episodic" });

    const types = (await edges()).map(e => e.type);
    expect(types).not.toContain("follows");
    expect(types).toEqual(["relates_to", "relates_to"]);
  });

  it("refuses follows when the neighbour is semantic, because the type is episodic-only", async () => {
    seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000, tags: SEMANTIC }] });

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: "episodic" });

    expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
  });

  it("refuses follows when the new entry is semantic", async () => {
    seedPair({ newKindTags: SEMANTIC, neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: "semantic" });

    expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
  });

  it("degrades to a generic edge when the kind is unknown", async () => {
    seedPair({ newKindTags: [], neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: null });

    expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
  });

  it("replaces an inferred relates_to already standing between the pair", async () => {
    seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });
    // Written by an earlier pass, in the symmetric orientation relates_to stores.
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('old', 'earlier', 'new', 'relates_to', 0.8, 'inferred', '{}', 0, 0, '')`,
    ).run();

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: "episodic" });

    expect(await edges()).toEqual([{ source_id: "new", target_id: "earlier", type: "follows" }]);
  });

  it("keeps an explicit relates_to the user drew themselves", async () => {
    seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('mine', 'earlier', 'new', 'relates_to', 0.9, 'explicit', '{}', 0, 0, '')`,
    ).run();

    await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: "episodic" });

    const kept = (await edges()).filter(e => e.type === "relates_to");
    expect(kept).toHaveLength(1);
  });

  // The chain that makes any of the above reachable in production: the
  // classifier already runs on every capture, and its `kind` is what the gate
  // above needs. Without this the feature is dead code — inference would keep
  // being handed `undefined`.
  describe("the capture path", () => {
    /** Embeddings for bge-*, one classification JSON for the LLM call. */
    function aiReturningKind(kind: string) {
      return {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
          const payload = JSON.stringify({
            response: `{"importance": 4, "canonical": false, "kind": "${kind}"}`,
          });
          return new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as any;
    }

    /** 0.82: above EDGE_INFER_THRESHOLD, below DUPLICATE_FLAG_THRESHOLD. */
    function envCapturing(ai: any): Env {
      return makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        AI: ai,
        VECTORIZE: {
          query: async () => ({ matches: [{ id: "earlier", score: 0.82, metadata: { parentId: "earlier" } }] }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
        } as any,
      });
    }

    async function capture(ai: any): Promise<void> {
      sqlite.seed({
        id: "earlier", content: "the earlier thought", tags: EPISODIC,
        createdAt: Date.now() - 5 * 60_000,
      });
      const pending: Promise<any>[] = [];
      const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
      await captureEntry("the thought that follows it", [], "api", envCapturing(ai), ctx);
      await Promise.all(pending);
    }

    it("types the edge as follows using the kind the classifier just produced", async () => {
      await capture(aiReturningKind("episodic"));
      expect((await edges()).map(e => e.type)).toEqual(["follows"]);
    });


    /**
     * The end-to-end proof that B2 fires under production conditions.
     *
     * Every other case here seeds the neighbour's `kind:` tag directly. That
     * assumes away the thing most likely to break the feature: classification is
     * asynchronous, and the neighbour's kind is written by ITS OWN deferred
     * classification. If that had not landed by the time a later capture reads
     * its tags, the kind gate would refuse `follows` for exactly the
     * recently-written neighbour B2 exists to link — and every seeded test here
     * would still pass.
     *
     * So this captures BOTH entries through the real path, draining the first
     * capture's deferred work before the second begins, and asserts the typed
     * edge appears with nothing hand-seeded.
     */
    it("types a follows edge between two entries both captured through the real path", async () => {
      const ai = aiReturningKind("episodic");
      const seen: string[] = [];
      const envFor = () => makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        AI: ai,
        VECTORIZE: {
          // Answers with whatever has already been written, so the second
          // capture sees the first as a neighbour without it being seeded.
          query: async () => ({
            matches: seen.map(id => ({ id, score: 0.82, metadata: { parentId: id } })),
          }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
        } as any,
      });

      const runCapture = async (content: string) => {
        const pending: Promise<any>[] = [];
        const c = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
        const result = await captureEntry(content, [], "api", envFor(), c);
        // Drain before the next capture, as the platform would between requests.
        await Promise.all(pending);
        if (result.status === "stored" || result.status === "flagged") seen.push(result.id);
      };

      await runCapture("The first thought in the thread.");
      await runCapture("The thought that follows on from it.");

      // kind:episodic reached the DB via the first capture's own classification,
      // and the second capture's inference read it from there.
      expect((await edges()).map(e => e.type)).toEqual(["follows"]);
    });

    it("still infers a generic edge when the classifier says semantic", async () => {
      await capture(aiReturningKind("semantic"));
      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });


    /**
     * The hard constraint this phase is built on, asserted rather than assumed.
     *
     * Chaining inference onto classification is only free because ONE
     * classifyEntry call feeds both halves. A refactor that gave inference its
     * own call would double the LLM cost of every capture in the product and
     * leave every other test in this file green.
     */
    it("classifies exactly once per capture", async () => {
      let classifyCalls = 0;
      const ai = {
        run: vi.fn().mockImplementation(async (model: string, opts: any) => {
          if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
          // Counted by PROMPT, not by call: capture also runs a pre-existing
          // contradiction check on this path, which is not what is being
          // constrained here and would make a raw call count read as 2.
          if (String(opts?.messages?.[0]?.content ?? "").includes("Classify this memory")) classifyCalls++;
          const payload = JSON.stringify({ response: '{"importance": 4, "canonical": false, "kind": "episodic"}' });
          return new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as any;

      await capture(ai);

      expect(classifyCalls).toBe(1);
    });

    /**
     * classifyEntry swallows its own model failures, so the earlier test only
     * exercises that. This one breaks the DB write that runs AFTER it — the
     * other half of the chain, and the one whose failure would otherwise take
     * edge inference down with it.
     */
    it("still infers an edge when the classification WRITE fails", async () => {
      sqlite.seed({
        id: "earlier", content: "the earlier thought", tags: EPISODIC,
        createdAt: Date.now() - 5 * 60_000,
      });
      const inner = sqlite.db as any;
      const failingDb = {
        prepare(sql: string) {
          if (sql.includes("UPDATE entries SET importance_score")) {
            throw new Error("D1 unavailable");
          }
          return inner.prepare(sql);
        },
        batch: (st: any) => inner.batch(st),
        exec: (sql: string) => inner.exec(sql),
      };
      const env2 = makeTestEnv(undefined, {
        DB: failingDb as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
        AI: aiReturningKind("episodic"),
        VECTORIZE: {
          query: async () => ({ matches: [{ id: "earlier", score: 0.82, metadata: { parentId: "earlier" } }] }),
          insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
        } as any,
      });
      const pending: Promise<any>[] = [];
      const ctx2 = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;

      await captureEntry("the thought that follows it", [], "api", env2, ctx2);
      await Promise.all(pending);

      // Degraded, not lost: no kind survived the failed write, so no `follows`,
      // but the pair is still connected.
      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });

    it("still infers an edge when classification fails outright", async () => {
      const ai = {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
          throw new Error("model unavailable");
        }),
      } as any;
      await capture(ai);
      // Degraded, not lost: no kind means no `follows`, but the pair is still linked.
      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });
  });

  /**
   * The conflict clause every edge writer depends on, pinned where a constraint
   * violation is actually observable.
   *
   * Two writers legitimately produce the same edge: capture-time inference and
   * the weekly insight pass. Without ON CONFLICT the second INSERT raises a
   * UNIQUE violation, and in production that aborts the whole D1 batch it rides
   * in — taking unrelated writes in the same batch down with it.
   */
  describe("edge upsert", () => {
    it("writes the same edge twice without raising, keeping the stronger weight", async () => {
      sqlite.seed({ id: "one", content: "first", createdAt: NOW - 1000, tags: EPISODIC });
      sqlite.seed({ id: "two", content: "second", createdAt: NOW, tags: EPISODIC });

      await createEdge("two", "one", "follows", { weight: 0.9, provenance: "explicit", workspaceId: "" }, env);
      await createEdge("two", "one", "follows", { weight: 0.75, provenance: "system", workspaceId: "" }, env);

      const rows = await edges();
      expect(rows).toHaveLength(1);
      const [row] = await sqlite.db.prepare(`SELECT weight FROM edges`).all().then((r: any) => r.results);
      expect(row.weight).toBe(0.9);
    });
  });

  /**
   * Edge writes cost one D1 call, not one per edge.
   *
   * Two reasons, and the second is the sharper one:
   *
   *   - ATOMICITY. Retiring the generic edge and writing the typed one are the
   *     two halves of a replacement. Issued separately, a failure between them
   *     leaves the pair with NO edge at all — strictly worse than either state.
   *   - BUDGET. A Worker request may make 50 subrequests. Capture already spends
   *     most of that on chunk embedding, and inference at one call per edge put
   *     a large multi-chunk capture over the line.
   *
   * The sqlite facade counts a batch as one entry in `issued`, matching what the
   * platform actually charges.
   */
  it("writes every edge for one capture in a single batched D1 call", async () => {
    seedPair({
      neighbors: [
        { id: "earlier", agoMs: 5 * 60_000 },
        { id: "other-a", agoMs: 3 * 60 * 60_000, tags: SEMANTIC },
        { id: "other-b", agoMs: 4 * 60 * 60_000, tags: SEMANTIC },
      ],
    });

    const before = sqlite.issued.length;
    await inferEdgesOnWrite("new", [
      { id: "earlier", score: 0.9 },
      { id: "other-a", score: 0.85 },
      { id: "other-b", score: 0.8 },
    ], env, { newKind: "episodic" });

    // One endpoint SELECT, then one batch carrying the DELETE and all three
    // edge writes. Per-edge calls would make this five.
    expect(sqlite.issued.length - before).toBe(2);
    expect((await edges()).map(e => e.type).sort()).toEqual(["follows", "relates_to", "relates_to"]);
  });

  /**
   * B#5 — a typed edge must not collect a generic one beside it.
   *
   * `follows` is emitted only inside the 30-minute window and only with a known
   * kind. Every LATER write touching the same pair — an edit, an append, a
   * nightly backfill — re-runs inference outside those conditions, falls to the
   * generic branch, and inserts `relates_to` alongside the `follows` that is
   * already there. The pair then carries both, and "typed replaces generic"
   * holds only for the instant the typed edge was written.
   *
   * The guard rides on the INSERT itself rather than on a lookup, so it costs no
   * additional D1 call.
   */
  describe("a pair that already carries a typed edge", () => {
    it("does not lay a generic edge beside it", async () => {
      seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });
      await createEdge("new", "earlier", "follows", { weight: 0.85, provenance: "inferred", workspaceId: "" }, env);

      // An edit re-runs inference with no kind, so `follows` cannot be re-emitted
      // and the pair falls to the generic branch.
      await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, {});

      expect((await edges()).map(e => e.type)).toEqual(["follows"]);
    });

    it("still draws the generic edge when the pair has no typed edge", async () => {
      // Two hours apart, so the generic branch is reached because the pair is
      // outside the follows window — not because the kind is unavailable. The
      // caller passing no kind no longer implies "unknown": inference falls back
      // to the row's own classifier kind.
      seedPair({ neighbors: [{ id: "earlier", agoMs: 2 * 60 * 60_000 }] });

      await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, {});

      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });

    it("does not let one pair's typed edge suppress another pair's generic edge", async () => {
      seedPair({
        neighbors: [
          { id: "earlier", agoMs: 5 * 60_000 },
          { id: "unrelated", agoMs: 3 * 60 * 60_000 },
        ],
      });
      await createEdge("new", "earlier", "follows", { weight: 0.85, provenance: "inferred", workspaceId: "" }, env);

      await inferEdgesOnWrite("new", [
        { id: "earlier", score: 0.9 },
        { id: "unrelated", score: 0.85 },
      ], env, {});

      const rows = await edges();
      expect(rows.map(e => e.type).sort()).toEqual(["follows", "relates_to"]);
      expect(rows.find(e => e.type === "relates_to")!.target_id).toBe("unrelated");
    });
  });

  /**
   * Finding 2 — the kind the gate needs is already in hand on every path.
   *
   * `follows` was reachable only from the capture path, because only that path
   * passes the classifier's kind. The nightly backfill, the update path and the
   * append path all call inference with no kind at all, so the gate refused
   * every time — even though the endpoint SELECT already reads the row's own
   * `kind:` tag for the workspace check.
   *
   * That is not academic. A Vectorize write takes a median under 30 seconds to
   * become queryable, so the predecessor written moments earlier is exactly the
   * neighbour capture-time inference cannot see; when that capture finds nothing
   * else it becomes an orphan, and the backfill is the only pass that revisits
   * it. An imported or restored brain is worse still: import never infers at
   * all, so its whole graph comes from the backfill.
   */
  describe("falling back to the entry's own kind", () => {
    it("types the edge when the caller passes no kind at all", async () => {
      seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });

      await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, {});

      expect((await edges()).map(e => e.type)).toEqual(["follows"]);
    });

    it("still honours an explicit null kind as unknown", async () => {
      seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000 }] });

      // The capture path passes what the classifier returned. `null` there means
      // classification failed, which must not be second-guessed from the tags.
      await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, { newKind: null });

      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });

    /**
     * Mirrored records are classified like anything else, and a mailbox import
     * writes dozens of episodic rows minutes apart. Left alone, the backfill
     * would chain them into a `follows` sequence describing the order the
     * mailbox happened to sync — the artefact of a bulk write, not a train of
     * thought, which is the same thing the burst guard exists to refuse.
     */
    it("refuses follows between two mirrored records", async () => {
      seedPair({
        source: "email-gmail",
        neighbors: [{ id: "earlier", agoMs: 5 * 60_000, source: "email-gmail" }],
      });

      await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, {});

      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });

    it("refuses follows when only one side is a mirrored record", async () => {
      seedPair({ neighbors: [{ id: "earlier", agoMs: 5 * 60_000, source: "calendar-google" }] });

      await inferEdgesOnWrite("new", [{ id: "earlier", score: 0.85 }], env, {});

      expect((await edges()).map(e => e.type)).toEqual(["relates_to"]);
    });
  });
});
