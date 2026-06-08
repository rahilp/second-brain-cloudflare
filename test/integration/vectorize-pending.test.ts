import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function pastGraceEntry(id: string) {
  return {
    id,
    content: `Content for ${id}`,
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 600000, // 10 minutes ago — past default 5-min grace
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
  };
}

describe("POST /vectorize-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when no past-grace entries", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes past-grace entries and returns correct counts", async () => {
    db.entries.push(pastGraceEntry("e1"), pastGraceEntry("e2"));
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("updates vector_ids in D1 after successful re-embed", async () => {
    db.entries.push(pastGraceEntry("fix-me"));
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "fix-me");
    const ids = JSON.parse(updated.vector_ids);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("skips entries within the grace window (vector_ids=[] but recent)", async () => {
    db.entries.push({
      id: "pending",
      content: "Just captured",
      tags: "[]",
      source: "api",
      created_at: Date.now(), // within grace window
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("skips entries that already have vector_ids populated", async () => {
    db.entries.push({
      id: "already-done",
      content: "Already vectorized",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600000,
      vector_ids: '["already-done"]',
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
  });

  it("counts failed and continues when storeEntry throws for one entry", async () => {
    db.entries.push(pastGraceEntry("bad"), pastGraceEntry("good"));
    let callCount = 0;
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error("Vectorize error");
          return Promise.resolve({ mutationId: "m" });
        }),
      }),
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.remaining).toBe(1);
  });

  it("respects VECTORIZE_GRACE_MS env var", async () => {
    // entry 90s old — past 60s grace but within default 300s
    db.entries.push({
      id: "e90",
      content: "90-second-old memory",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 90000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
  });
});
