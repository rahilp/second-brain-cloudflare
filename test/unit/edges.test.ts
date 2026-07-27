import { describe, it, expect, beforeEach } from "vitest";
import { createEdge, inferEdgesOnWrite, isValidEdgeType, isSymmetric } from "../../src/graph/edges";
import { expandGraph } from "../../src/graph/traverse";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

function edge(source_id: string, target_id: string, weight = 0.5, type = "relates_to") {
  return { id: `${source_id}-${target_id}`, source_id, target_id, type, weight, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 };
}

describe("edge-type registry", () => {
  it("validates known edge types and rejects unknown ones", () => {
    expect(isValidEdgeType("relates_to")).toBe(true);
    expect(isValidEdgeType("supersedes")).toBe(true);
    expect(isValidEdgeType("bogus")).toBe(false);
  });

  it("treats relates_to as symmetric and supersedes as directed", () => {
    expect(isSymmetric("relates_to")).toBe(true);
    expect(isSymmetric("supersedes")).toBe(false);
  });
});

describe("createEdge", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("rejects a self-link and writes nothing", async () => {
    const result = await createEdge("a", "a", "relates_to", {}, env);
    expect(result).toBeNull();
    expect(db.edges).toHaveLength(0);
  });

  it("rejects an unknown edge type and writes nothing", async () => {
    const result = await createEdge("a", "b", "bogus", {}, env);
    expect(result).toBeNull();
    expect(db.edges).toHaveLength(0);
  });

  it("orders symmetric edges smaller-id-first so A→B and B→A collapse to one row", async () => {
    await createEdge("zeta", "alpha", "relates_to", {}, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].source_id).toBe("alpha");
    expect(db.edges[0].target_id).toBe("zeta");

    // Reverse direction is the same logical edge — must not create a second row.
    await createEdge("alpha", "zeta", "relates_to", {}, env);
    expect(db.edges).toHaveLength(1);
  });

  it("preserves direction for directed edge types", async () => {
    await createEdge("new", "old", "supersedes", {}, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].source_id).toBe("new");
    expect(db.edges[0].target_id).toBe("old");
  });

  it("is idempotent and keeps the higher weight on re-link", async () => {
    await createEdge("a", "b", "relates_to", { weight: 0.4 }, env);
    await createEdge("a", "b", "relates_to", { weight: 0.9 }, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].weight).toBe(0.9);

    // A weaker re-link must not lower the stored weight.
    await createEdge("a", "b", "relates_to", { weight: 0.2 }, env);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].weight).toBe(0.9);
  });

  it("stores provenance and metadata", async () => {
    await createEdge("a", "b", "relates_to", { provenance: "explicit", metadata: { note: "hi" } }, env);
    expect(db.edges[0].provenance).toBe("explicit");
    expect(JSON.parse(db.edges[0].metadata)).toEqual({ note: "hi" });
  });
});

describe("expandGraph", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns nothing at hop 0", async () => {
    db.edges.push(edge("a", "b"));
    expect(await expandGraph(["a"], { hops: 0 }, env)).toEqual([]);
  });

  it("finds 1-hop neighbors regardless of edge direction", async () => {
    db.edges.push(edge("a", "b", 0.6), edge("c", "a", 0.7)); // a as source, then a as target
    const out = await expandGraph(["a"], { hops: 1 }, env);
    expect(out.map(n => n.id).sort()).toEqual(["b", "c"]);
    expect(out.every(n => n.hop === 1)).toBe(true);
  });

  it("never returns a seed node", async () => {
    db.edges.push(edge("a", "b"));
    const out = await expandGraph(["a", "b"], { hops: 1 }, env);
    expect(out).toHaveLength(0);
  });

  it("skips status:deprecated neighbors by default", async () => {
    db.entries.push({ id: "b", content: "x", tags: JSON.stringify(["status:deprecated"]), source: "api", created_at: 1, vector_ids: "[]" });
    db.edges.push(edge("a", "b", 0.9), edge("a", "c", 0.8));
    const out = await expandGraph(["a"], { hops: 1 }, env);
    expect(out.map(n => n.id)).toEqual(["c"]);
  });

  it("reaches 2-hop nodes when hops allows", async () => {
    db.edges.push(edge("a", "b"), edge("b", "c"));
    const out = await expandGraph(["a"], { hops: 2 }, env);
    const byId = Object.fromEntries(out.map(n => [n.id, n.hop]));
    expect(byId).toEqual({ b: 1, c: 2 });
  });
});

describe("inferEdgesOnWrite", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("auto-links only genuinely-related neighbors, not loose keyword-overlap ones", async () => {
    await inferEdgesOnWrite("new", [
      { id: "strong", score: 0.84 }, // clearly related — link
      { id: "loose", score: 0.66 },  // shares a keyword but not really related — must NOT link
      { id: "weak", score: 0.4 },    // unrelated
    ], env);
    expect(db.edges).toHaveLength(1);
    const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
    expect(linked).toEqual(["strong"]);
    expect(db.edges[0].type).toBe("relates_to");
    expect(db.edges[0].provenance).toBe("inferred");
  });

  it("never links the new entry to itself", async () => {
    await inferEdgesOnWrite("new", [{ id: "new", score: 0.99 }, { id: "a", score: 0.8 }], env);
    expect(db.edges).toHaveLength(1);
    expect([db.edges[0].source_id, db.edges[0].target_id].sort()).toEqual(["a", "new"]);
  });

  it("caps at the top 3 strongest neighbors", async () => {
    await inferEdgesOnWrite("new", [
      { id: "a", score: 0.9 }, { id: "b", score: 0.85 }, { id: "c", score: 0.8 },
      { id: "d", score: 0.75 }, { id: "e", score: 0.7 },
    ], env);
    expect(db.edges).toHaveLength(3);
    const linked = db.edges.flatMap((e: any) => [e.source_id, e.target_id]).filter((id: string) => id !== "new");
    expect(linked.sort()).toEqual(["a", "b", "c"]);
  });

  it("uses the similarity score as the edge weight", async () => {
    await inferEdgesOnWrite("new", [{ id: "a", score: 0.82 }], env);
    expect(db.edges[0].weight).toBeCloseTo(0.82);
  });

  it("writes nothing when there are no qualifying neighbors", async () => {
    await inferEdgesOnWrite("new", [{ id: "a", score: 0.3 }], env);
    expect(db.edges).toHaveLength(0);
  });
});
