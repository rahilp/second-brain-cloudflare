/**
 * #245 — every seam in the issue's table reads its tunables from the resolved
 * config rather than module scope.
 *
 * Each test moves one setting and asserts the observable behaviour moves with
 * it. Where a seam is pure (allowanceFor, compressionEligibilitySql) it is
 * called directly with no env at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULTS } from "../../src/config";
import { allowanceFor } from "../../src/recall/snippet";
import { compressionEligibilitySql } from "../../src/compression/eligibility";
import { embed } from "../../src/lib/ai";
import { expandGraph } from "../../src/graph/traverse";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";

describe("seam: output budgeting (snippet.ts)", () => {
  it("uses the configured full-match allowance for a strong early match", () => {
    const generous = allowanceFor(0, 1, { ...DEFAULTS, FULL_MATCH_MAX_CHARS: 9000 });
    expect(generous).toBe(9000);
  });

  it("uses the configured snippet allowance once past the full-match count", () => {
    const config = { ...DEFAULTS, RECALL_FULL_MATCHES: 0, SNIPPET_MAX_CHARS: 123 };
    expect(allowanceFor(0, 1, config)).toBe(123);
  });

  it("respects a configured strong-match ratio", () => {
    // relScore 0.5 is strong under a 0.4 ratio, weak under the shipped 0.75.
    const lenient = { ...DEFAULTS, STRONG_MATCH_RATIO: 0.4 };
    expect(allowanceFor(0, 0.5, lenient)).toBe(DEFAULTS.FULL_MATCH_MAX_CHARS);
    expect(allowanceFor(0, 0.5, DEFAULTS)).toBe(DEFAULTS.SNIPPET_MAX_CHARS);
  });

  it("falls back to the shipped config when none is passed", () => {
    expect(allowanceFor(0, 1)).toBe(DEFAULTS.FULL_MATCH_MAX_CHARS);
  });
});

describe("seam: compression eligibility (eligibility.ts)", () => {
  it("embeds the configured importance threshold in the SQL", () => {
    const sql = compressionEligibilitySql("", { ...DEFAULTS, COMPRESSION_IMPORTANCE_THRESHOLD: 2 });
    expect(sql).toContain("importance_score < 2");
  });

  it("embeds the configured minimum recall count in the SQL", () => {
    const sql = compressionEligibilitySql("", { ...DEFAULTS, COMPRESSION_MIN_RECALL: 7 });
    expect(sql).toContain("recall_count < 7");
  });

  it("still emits exactly one bind placeholder", () => {
    const sql = compressionEligibilitySql("entries.", { ...DEFAULTS, COMPRESSION_MIN_RECALL: 7 });
    expect(sql.split("?").length - 1).toBe(1);
  });

  it("falls back to the shipped config when none is passed", () => {
    expect(compressionEligibilitySql()).toContain(`importance_score < ${DEFAULTS.COMPRESSION_IMPORTANCE_THRESHOLD}`);
  });
});

describe("seam: embedding model (ai.ts)", () => {
  it("embeds with the configured model", async () => {
    const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] });
    const env = makeTestEnv(undefined, { AI: { run } as never });

    await embed("hello", env, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/some/other-model" });

    expect(run.mock.calls[0][0]).toBe("@cf/some/other-model");
  });

  it("falls back to the shipped model when no config is passed", async () => {
    const run = vi.fn().mockResolvedValue({ data: [[0.1]] });
    const env = makeTestEnv(undefined, { AI: { run } as never });

    await embed("hello", env);

    expect(run.mock.calls[0][0]).toBe(DEFAULTS.EMBEDDING_MODEL);
  });
});

describe("seam: graph expansion (traverse.ts)", () => {
  let db: D1Mock;

  function seed(id: string) {
    db.entries.push({
      id, content: id, tags: "[]", source: "api", created_at: 1000,
      vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
  }
  function edge(a: string, b: string) {
    db.edges.push({
      id: `${a}-${b}`, source_id: a, target_id: b, type: "relates_to",
      weight: 1, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1,
    });
  }

  beforeEach(() => {
    db = makeTestDb();
    seed("a"); seed("b"); seed("c");
    edge("a", "b"); edge("b", "c");
  });

  it("clamps hops to the configured maximum", async () => {
    const env = makeTestEnv(db);

    const capped = await expandGraph(["a"], { hops: 2 }, env, { ...DEFAULTS, GRAPH_MAX_HOPS: 1 });

    // With a 1-hop ceiling, the 2-hop neighbour must not appear.
    expect(capped.map(n => n.id)).not.toContain("c");
  });

  it("reaches a 2-hop neighbour when the configured maximum allows it", async () => {
    const env = makeTestEnv(db);

    const full = await expandGraph(["a"], { hops: 2 }, env, DEFAULTS);

    expect(full.map(n => n.id)).toContain("c");
  });

  // GRAPH_HOP_DECAY is deliberately not tested here: expandGraph returns
  // GraphNeighbor, which carries hop/viaWeight but no score. The decay is
  // applied downstream in search.ts, so it is threaded and covered there.
});

describe("seam: duplicate detection (duplicate.ts)", () => {
  function envWithTopScore(score: number) {
    return makeTestEnv(makeTestDb(), {
      AI: { run: vi.fn().mockResolvedValue({ data: [[0.1]] }) } as never,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "dup", score, metadata: { parentId: "dup" } }],
        }),
      }),
    });
  }

  it("blocks at the configured block threshold", async () => {
    const { duplicate } = await checkDuplicateAndContradiction(
      "x", envWithTopScore(0.9), { ...DEFAULTS, DUPLICATE_BLOCK_THRESHOLD: 0.88 },
    );
    expect(duplicate.status).toBe("blocked");
  });

  it("only flags the same score when the block threshold is raised above it", async () => {
    const { duplicate } = await checkDuplicateAndContradiction(
      "x", envWithTopScore(0.9), { ...DEFAULTS, DUPLICATE_BLOCK_THRESHOLD: 0.99, DUPLICATE_FLAG_THRESHOLD: 0.8 },
    );
    expect(duplicate.status).toBe("flagged");
  });

  it("treats the same score as unique when both thresholds sit above it", async () => {
    const { duplicate } = await checkDuplicateAndContradiction(
      "x", envWithTopScore(0.9), { ...DEFAULTS, DUPLICATE_BLOCK_THRESHOLD: 0.99, DUPLICATE_FLAG_THRESHOLD: 0.95 },
    );
    expect(duplicate.status).toBe("unique");
  });
});
