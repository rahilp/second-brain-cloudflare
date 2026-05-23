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

  it("stores importance_score after async AI scoring completes", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Decided to switch to TypeScript for all new projects" } }), env, ctx);
    expect(res.status).toBe(200);
    await drain();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].importance_score).toBeGreaterThanOrEqual(1);
    expect(db.entries[0].importance_score).toBeLessThanOrEqual(5);
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

  it("extracts hashtags from content and stores clean content with tags", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "went for a run #health #fitness" } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("went for a run");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("health");
    expect(tags).toContain("fitness");
  });

  it("merges hashtag tags with explicit tags and deduplicates case-insensitively", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "note #health", tags: ["Health", "fitness"] } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    const healthCount = tags.filter(t => t === "health").length;
    expect(healthCount).toBe(1);
    expect(tags).toContain("fitness");
  });

  it("behaves identically when no hashtags are present (regression)", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "plain note", tags: ["work"] } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("plain note");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toEqual(["work"]);
  });

  it("falls back to original content when input is only hashtags", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "#task" } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("#task");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("task");
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
