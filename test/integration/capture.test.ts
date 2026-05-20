import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

describe("POST /capture", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when content is missing", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is whitespace-only", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "   " } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("stores valid entry and returns id", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Test note" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe("string");
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("Test note");
  });

  it("blocks a near-exact duplicate (score ≥ 0.95)", async () => {
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "existing", score: 0.97, metadata: { parentId: "existing" } }],
      }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Duplicate note" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.duplicate).toBe(true);
    expect(data.matchId).toBe("existing");
    expect(db.entries).toHaveLength(0);
  });

  it("stores flagged duplicate (score 0.85–0.94) with duplicate-candidate tag", async () => {
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
      }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Similar note" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.warning).toBe("similar");
    expect(db.entries).toHaveLength(1);
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("duplicate-candidate");
  });
});
