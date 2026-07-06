import { describe, it, expect, beforeEach } from "vitest";
import worker, { deleteEdge } from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function pushEdge(db: D1Mock, source_id: string, target_id: string, type = "relates_to", weight = 0.7) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("POST /unlink", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "a", target_id: "b" }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when ids are missing", async () => {
    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "a" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown type", async () => {
    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "a", target_id: "b", type: "bogus" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("type must be one of");
  });

  it("deletes a directed edge regardless of argument order", async () => {
    pushEdge(db, "a", "b", "caused_by");

    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "b", target_id: "a" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, deleted: 1 });
    expect(db.edges).toHaveLength(0);
  });

  it("deletes a symmetric edge given in non-normalized order", async () => {
    // createEdge stores relates_to smaller-id-first: linking z→a lands as (a, z)
    pushEdge(db, "a", "z", "relates_to");

    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "z", target_id: "a" } }), env, ctx);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, deleted: 1 });
    expect(db.edges).toHaveLength(0);
  });

  it("type filter deletes only the matching edge when a pair has two edge types", async () => {
    pushEdge(db, "a", "b", "relates_to");
    pushEdge(db, "a", "b", "caused_by");

    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "a", target_id: "b", type: "caused_by" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.deleted).toBe(1);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].type).toBe("relates_to");
  });

  it("omitted type deletes all edges between the pair", async () => {
    pushEdge(db, "a", "b", "relates_to");
    pushEdge(db, "b", "a", "caused_by");
    pushEdge(db, "a", "c", "relates_to"); // unrelated pair, must survive

    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "a", target_id: "b" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.deleted).toBe(2);
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].target_id).toBe("c");
  });

  it("no match is still ok with deleted: 0 (idempotent delete)", async () => {
    const res = await worker.fetch(req("POST", "/unlink", { body: { source_id: "a", target_id: "b" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, deleted: 0 });
  });
});

describe("deleteEdge (backs the MCP unlink tool)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns the deleted count for the tool's happy-path message", async () => {
    pushEdge(db, "a", "b", "relates_to");
    expect(await deleteEdge("a", "b", undefined, env)).toBe(1);
    expect(db.edges).toHaveLength(0);
  });

  it("returns 0 when nothing matches, for the 'No link found' message", async () => {
    expect(await deleteEdge("a", "b", undefined, env)).toBe(0);
  });
});
