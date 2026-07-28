import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = []) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at: 1000, vector_ids: "[]" });
}

function pushEdge(db: D1Mock, source_id: string, target_id: string, type: string, weight = 0.5) {
  db.edges.push({ id: `${source_id}-${target_id}-${type}`, source_id, target_id, type, weight, provenance: "explicit", metadata: "{}", created_at: 1, updated_at: 1 });
}

describe("GET /connections", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/connections?id=a", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("GET", "/connections"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("returns the 1-hop neighbors of an entry with their edge type", async () => {
    seedEntry(db, "a", "Decision A");
    seedEntry(db, "b", "Outcome B");
    pushEdge(db, "a", "b", "relates_to", 0.7);

    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]).toMatchObject({ id: "b", content: "Outcome B", type: "relates_to", label: "Related to" });
  });

  it("surfaces edge provenance and when it was formed (#225)", async () => {
    seedEntry(db, "a", "Decision A");
    seedEntry(db, "b", "Auto-linked B");
    db.edges.push({ id: "a-b-relates_to", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1710000000000, updated_at: 1710000000000 });

    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    expect(data.connections[0]).toMatchObject({ id: "b", provenance: "inferred", linkedAt: 1710000000000 });
  });

  it("filters by relationship type", async () => {
    seedEntry(db, "a", "A");
    seedEntry(db, "b", "B");
    seedEntry(db, "c", "C");
    pushEdge(db, "a", "b", "relates_to");
    pushEdge(db, "a", "c", "supersedes");

    const res = await worker.fetch(req("GET", "/connections?id=a&type=supersedes"), env, ctx);
    const data = await res.json() as any;
    expect(data.connections.map((c: any) => c.id)).toEqual(["c"]);
  });

  it("returns an empty list when there are no connections", async () => {
    seedEntry(db, "a", "A");
    const res = await worker.fetch(req("GET", "/connections?id=a"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.connections).toEqual([]);
  });
});
