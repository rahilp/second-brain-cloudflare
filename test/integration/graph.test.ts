import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], importance = 0) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]", importance_score: importance });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, type = "relates_to", weight = 0.7) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("GET /graph", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/graph", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns nodes and the edges among them, with kind and status annotations", async () => {
    seedEntry(db, "a", "Memory A", ["kind:semantic"]);
    seedEntry(db, "b", "Memory B", ["kind:episodic", "status:deprecated"]);
    pushEdge(db, "a", "b");

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b"]);
    const a = data.nodes.find((n: any) => n.id === "a");
    expect(a).toMatchObject({ kind: "semantic", status: null, label: "Memory A" });
    const b = data.nodes.find((n: any) => n.id === "b");
    expect(b).toMatchObject({ kind: "episodic", status: "deprecated" });
    expect(data.edges).toEqual([{ source: "a", target: "b", type: "relates_to", weight: 0.7 }]);
  });

  it("never returns dangling edges (an endpoint missing from the node set)", async () => {
    seedEntry(db, "a", "Memory A");
    seedEntry(db, "b", "Memory B");
    pushEdge(db, "a", "b");
    pushEdge(db, "a", "ghost"); // ghost has no entry row

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["a", "b"]);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("returns the neighborhood of a seed when ?seed= is given", async () => {
    seedEntry(db, "seed", "Seed");
    seedEntry(db, "n1", "One hop");
    seedEntry(db, "n2", "Two hops");
    seedEntry(db, "far", "Unconnected");
    pushEdge(db, "seed", "n1");
    pushEdge(db, "n1", "n2");

    const res = await worker.fetch(req("GET", "/graph?seed=seed"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["n1", "n2", "seed"]);
    expect(data.nodes.map((n: any) => n.id)).not.toContain("far");
  });

  it("returns the whole graph by default — no node cap", async () => {
    for (let i = 0; i < 250; i++) seedEntry(db, `n${i}`, `Memory ${i}`);
    for (let i = 0; i < 249; i++) pushEdge(db, `n${i}`, `n${i + 1}`);

    const res = await worker.fetch(req("GET", "/graph"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(250);
    expect(data.edges).toHaveLength(249);
  });

  it("still honors an explicit ?limit=", async () => {
    for (let i = 0; i < 10; i++) seedEntry(db, `n${i}`, `Memory ${i}`);
    for (let i = 0; i < 9; i++) pushEdge(db, `n${i}`, `n${i + 1}`);

    const res = await worker.fetch(req("GET", "/graph?limit=4"), env, ctx);
    const data = await res.json() as any;
    expect(data.nodes).toHaveLength(4);
  });
});
