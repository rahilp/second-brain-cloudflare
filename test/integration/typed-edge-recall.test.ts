/**
 * The recall gate for Phases B and C: typing an edge must not hide it.
 *
 * Both phases REPLACE edges rather than adding them — a capture-time `follows`
 * retires the inferred `relates_to` between the same pair, and an insight-pass
 * `caused_by` does the same. So every edge these phases produce is one that
 * recall could previously reach by another name, and the failure mode is not a
 * missing feature but a silent loss: evidence that used to arrive at hops=1 and
 * now does not.
 *
 * Graph expansion applies no type filter, but it does `ORDER BY weight DESC`,
 * and the replacement is not weight-neutral. An inferred `relates_to` carries
 * the pair's similarity score (0.78 and up); an insight-reasoned `caused_by`
 * carries a flat 0.75. So a typed edge can sort BELOW the generic edge it
 * retired, which is the specific regression these fixtures are here to catch.
 *
 * Modelled on graph-aware-recall-benchmark: five strong direct matches crowd
 * Recall@5, and the answer can only enter through the edge.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";

const QUERY = "pricing rollback";
const ANSWER = "The flat tier was withdrawn after the margin review";

function suppressKeywordSearch(db: ReturnType<typeof makeTestDb>) {
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    if (sql.includes("WHERE content LIKE") && sql.includes("ORDER BY created_at DESC LIMIT")) {
      return { bind: () => ({ all: async () => ({ results: [] }) }) };
    }
    return prepare(sql);
  };
}

/** Root plus linked answer, joined by whatever edges the case is about. */
function fixture(edges: { type: string; weight: number; provenance: string }[]) {
  const db = makeTestDb();
  for (let i = 0; i < 5; i++) {
    db.entries.push({
      id: `direct-${i}`, content: `unrelated direct note ${i}`, tags: "[]", source: "api",
      created_at: 2000 - i, vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
  }
  db.entries.push({
    id: "root", content: "decision root", tags: '["kind:episodic"]', source: "api",
    created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0,
  });
  db.entries.push({
    id: "answer", content: `${QUERY} ${ANSWER}`, tags: '["kind:episodic"]', source: "api",
    created_at: 900, vector_ids: "[]", recall_count: 0, importance_score: 0,
  });

  edges.forEach((e, i) => {
    db.edges.push({
      id: `edge-${i}`, source_id: "root", target_id: "answer",
      type: e.type, weight: e.weight, provenance: e.provenance,
      metadata: "{}", created_at: 1, updated_at: 1,
    });
  });
  suppressKeywordSearch(db);

  const matches = [
    ...[0, 1, 2, 3, 4].map(i => ({
      id: `direct-${i}`, score: 0.95 - i * 0.04,
      metadata: { parentId: `direct-${i}`, isUpdate: false },
    })),
    { id: "root", score: 0.7, metadata: { parentId: "root", isUpdate: false } },
  ];
  const env = makeTestEnv(db, {
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }),
  });
  return { env, ctx: { waitUntil: () => undefined } as any as ExecutionContext };
}

async function idsAtHop1(edges: { type: string; weight: number; provenance: string }[]): Promise<string[]> {
  const { env, ctx } = fixture(edges);
  const result = await recallEntries({ query: QUERY, topK: 5, hops: 1, synthesize: false }, env, ctx);
  return result.matches.map(m => m.id);
}

describe("typed edges still carry linked evidence into recall", () => {
  // The pre-Phase-B state of the pair: what the typed edges below replace.
  it("baseline: an inferred relates_to reaches the answer at hops=1", async () => {
    expect(await idsAtHop1([{ type: "relates_to", weight: 0.85, provenance: "inferred" }]))
      .toContain("answer");
  });

  it("a capture-time follows reaches it just as well", async () => {
    expect(await idsAtHop1([{ type: "follows", weight: 0.85, provenance: "inferred" }]))
      .toContain("answer");
  });

  // The weight drop is the point: 0.75 is what the insight pass stamps, and it
  // is LOWER than the 0.85 relates_to it deletes.
  it("an insight-reasoned caused_by reaches it at its lower weight", async () => {
    expect(await idsAtHop1([{ type: "caused_by", weight: 0.75, provenance: "system" }]))
      .toContain("answer");
  });

  it("an insight-reasoned decided reaches it too", async () => {
    expect(await idsAtHop1([{ type: "decided", weight: 0.75, provenance: "system" }]))
      .toContain("answer");
  });

  // Typed-replaces-generic is not instantaneous everywhere: a backfill or an
  // explicit link can leave both standing on one pair.
  it("a pair carrying both relates_to and follows surfaces the answer exactly once", async () => {
    const ids = await idsAtHop1([
      { type: "relates_to", weight: 0.85, provenance: "explicit" },
      { type: "follows", weight: 0.85, provenance: "inferred" },
    ]);
    expect(ids).toContain("answer");
    expect(ids.filter(id => id === "answer")).toHaveLength(1);
  });

  it("still spends the whole Recall@5 budget rather than dropping a result", async () => {
    expect(await idsAtHop1([{ type: "follows", weight: 0.85, provenance: "inferred" }]))
      .toHaveLength(5);
  });

  it("leaves the strongest direct match on top", async () => {
    const ids = await idsAtHop1([{ type: "caused_by", weight: 0.75, provenance: "system" }]);
    expect(ids[0]).toBe("direct-0");
  });
});

/**
 * The case the single-edge fixtures above cannot reach.
 *
 * Graph expansion takes at most GRAPH_FANOUT_CAP (8) neighbours per node,
 * ordered by weight. With one edge on the root, any weight clears the cut, so
 * those fixtures say nothing about what replacing a 0.85 edge with a 0.75 one
 * does. Here the root is well-connected — eight competitors between 0.76 and
 * 0.84 — so the answer's weight decides whether it is expanded at all.
 */
describe("a typed edge on a well-connected root", () => {
  const COMPETITORS = 8;

  function crowdedFixture(answerEdge: { type: string; weight: number; provenance: string }) {
    const db = makeTestDb();
    for (let i = 0; i < 5; i++) {
      db.entries.push({
        id: `direct-${i}`, content: `unrelated direct note ${i}`, tags: "[]", source: "api",
        created_at: 2000 - i, vector_ids: "[]", recall_count: 0, importance_score: 0,
      });
    }
    db.entries.push({
      id: "root", content: "decision root", tags: "[]", source: "api",
      created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    db.entries.push({
      id: "answer", content: `${QUERY} ${ANSWER}`, tags: "[]", source: "api",
      created_at: 900, vector_ids: "[]", recall_count: 0, importance_score: 0,
    });

    // Eight rivals for the eight slots, all weighted above 0.75 and below 0.85.
    for (let i = 0; i < COMPETITORS; i++) {
      db.entries.push({
        id: `rival-${i}`, content: `an unrelated neighbour ${i}`, tags: "[]", source: "api",
        created_at: 800 - i, vector_ids: "[]", recall_count: 0, importance_score: 0,
      });
      db.edges.push({
        id: `rival-edge-${i}`, source_id: "root", target_id: `rival-${i}`,
        type: "relates_to", weight: 0.76 + i * 0.01, provenance: "inferred",
        metadata: "{}", created_at: 1, updated_at: 1,
      });
    }
    db.edges.push({
      id: "answer-edge", source_id: "root", target_id: "answer",
      type: answerEdge.type, weight: answerEdge.weight, provenance: answerEdge.provenance,
      metadata: "{}", created_at: 1, updated_at: 1,
    });
    suppressKeywordSearch(db);

    const matches = [
      ...[0, 1, 2, 3, 4].map(i => ({
        id: `direct-${i}`, score: 0.95 - i * 0.04,
        metadata: { parentId: `direct-${i}`, isUpdate: false },
      })),
      { id: "root", score: 0.7, metadata: { parentId: "root", isUpdate: false } },
    ];
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches }) }),
    });
    return { env, ctx: { waitUntil: () => undefined } as any as ExecutionContext };
  }

  async function reaches(answerEdge: { type: string; weight: number; provenance: string }): Promise<boolean> {
    const { env, ctx } = crowdedFixture(answerEdge);
    const result = await recallEntries({ query: QUERY, topK: 5, hops: 1, synthesize: false }, env, ctx);
    return result.matches.map(m => m.id).includes("answer");
  }

  it("reaches the answer through the generic edge it starts with", async () => {
    expect(await reaches({ type: "relates_to", weight: 0.85, provenance: "inferred" })).toBe(true);
  });

  // The regression the weight carry-forward exists to prevent: the insight
  // pass's flat 0.75 sorts below all eight rivals and never gets expanded.
  it("loses the answer if the replacement drops to the flat insight weight", async () => {
    expect(await reaches({ type: "caused_by", weight: 0.75, provenance: "system" })).toBe(false);
  });

  it("keeps the answer when the replacement inherits the weight it retired", async () => {
    expect(await reaches({ type: "caused_by", weight: 0.85, provenance: "system" })).toBe(true);
  });
});
