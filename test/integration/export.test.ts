import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, id: string, content: string, tags: string[] = [], created_at = 1000) {
  db.entries.push({ id, content, tags: JSON.stringify(tags), source: "api", created_at, vector_ids: '["v1"]', recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0 });
}

describe("GET /export", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/export", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns ALL entries when the count exceeds the /list cap of 100", async () => {
    for (let i = 0; i < 150; i++) seedEntry(db, `e${i}`, `Memory ${i}`, [], 1000 + i);

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.version).toBe(2);
    expect(typeof data.exported_at).toBe("number");
    expect(data.entries).toHaveLength(150);
    // newest first
    expect(data.entries[0].id).toBe("e149");
  });

  it("includes edges and parses tags to real arrays", async () => {
    seedEntry(db, "a", "Memory A", ["work", "kind:semantic"]);
    seedEntry(db, "b", "Memory B", ["idea"]);
    db.edges.push({ id: "edge-1", source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 });

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    const a = data.entries.find((e: any) => e.id === "a");
    expect(a.tags).toEqual(["work", "kind:semantic"]); // array, not a JSON string
    expect(data.edges).toEqual([
      { source_id: "a", target_id: "b", type: "relates_to", weight: 0.7, provenance: "inferred", created_at: 1 },
    ]);
  });

  it("never includes vector_ids (deployment-specific, import re-embeds)", async () => {
    seedEntry(db, "a", "Memory A");

    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    const data = await res.json() as any;
    expect(data.entries[0]).not.toHaveProperty("vector_ids");
  });

  it("exports an empty brain as a valid structure with empty arrays", async () => {
    const res = await worker.fetch(req("GET", "/export"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.entries).toEqual([]);
    expect(data.edges).toEqual([]);
  });
});
