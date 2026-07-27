import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /forget", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when body is invalid JSON", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: "{not json",
      }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/forget", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe("id is required");
  });

  it("returns 404 for non-existent id", async () => {
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "no-such-id" } }), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("deletes an existing entry and its vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1","entry-1-update-111"]',
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("entry-1");
    expect(data.deletedVectors).toBe(2);

    expect(db.entries.find((e: any) => e.id === "entry-1")).toBeUndefined();
    expect(deleteByIdsMock).toHaveBeenCalledWith(["entry-1", "entry-1-update-111"]);
  });

  it("trims whitespace from id before lookup", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "  entry-1  " } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.id).toBe("entry-1");
  });

  it("cascade-deletes edges touching the forgotten entry", async () => {
    db.entries.push({
      id: "entry-1", content: "Some content", tags: "[]", source: "api", created_at: Date.now(), vector_ids: "[]",
    });
    db.edges.push(
      { id: "e1", source_id: "entry-1", target_id: "other", type: "relates_to", weight: 0.5, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 },
      { id: "e2", source_id: "another", target_id: "entry-1", type: "relates_to", weight: 0.5, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 },
      { id: "e3", source_id: "x", target_id: "y", type: "relates_to", weight: 0.5, provenance: "inferred", metadata: "{}", created_at: 1, updated_at: 1 },
    );

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), env, ctx);
    expect(res.status).toBe(200);

    // Edges with entry-1 as source OR target are removed; the unrelated edge survives — no dangling edges.
    expect(db.edges.map((e: any) => e.id)).toEqual(["e3"]);
  });

  it("is non-fatal when Vectorize delete fails", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("Vectorize down")),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries.find((e: any) => e.id === "entry-1")).toBeUndefined();
  });
});
