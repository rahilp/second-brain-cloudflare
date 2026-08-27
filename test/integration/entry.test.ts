import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /entry", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/entry?id=a", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("GET", "/entry"), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns the full row with tags parsed to an array", async () => {
    const longContent = "A memory well past the eighty character graph label limit — ".repeat(4);
    db.entries.push({ id: "a", content: longContent, tags: '["work","kind:semantic"]', source: "api", created_at: 1234, vector_ids: '["v"]', recall_count: 3, importance_score: 4 });

    const res = await worker.fetch(req("GET", "/entry?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.entry).toEqual({
      id: "a",
      content: longContent, // full content, not an 80-char label
      tags: ["work", "kind:semantic"],
      source: "api",
      created_at: 1234,
      // What the pipeline decided about this memory. The detail view shows all
      // of it, and none of it was reachable before v2.3 — /entry answered with
      // five fields while the row carried ten.
      updated_at: 1234, // coalesced: this row predates the column
      importance_score: 4,
      recall_count: 3,
      contradiction_wins: 0,
      contradiction_losses: 0,
      indexed: true,
      workspace: "personal",
      actor_name: "Owner",
      timeline: [],
    });
  });

  it("reports a memory recall cannot see as unindexed", async () => {
    db.entries.push({ id: "pending", content: "Just captured", tags: "[]", source: "api", created_at: 1, vector_ids: "[]" });

    const res = await worker.fetch(req("GET", "/entry?id=pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.indexed).toBe(false);
  });

  it("prefers updated_at when the memory has been edited since capture", async () => {
    db.entries.push({ id: "edited", content: "Changed", tags: "[]", source: "api", created_at: 1000, updated_at: 9000, vector_ids: '["v"]' });

    const res = await worker.fetch(req("GET", "/entry?id=edited"), env, ctx);
    const data = await res.json() as any;
    expect(data.entry.created_at).toBe(1000);
    expect(data.entry.updated_at).toBe(9000);
  });

  it("404s for an unknown id", async () => {
    const res = await worker.fetch(req("GET", "/entry?id=ghost"), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain("ghost");
  });
});
