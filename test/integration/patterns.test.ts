import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedPattern(db: D1Mock, id: string, content: string) {
  db.entries.push({ id, content, tags: '["auto-pattern"]', source: "system", created_at: 1000, vector_ids: `["${id}"]`, recall_count: 0, importance_score: 0 });
}

describe("POST /patterns/resolve", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "confirm" }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown id", async () => {
    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "ghost", action: "confirm" } }), env, ctx);
    expect(res.status).toBe(404);
  });

  it("400s for an entry that is not an auto-derived pattern", async () => {
    db.entries.push({ id: "normal", content: "Just a memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]" });

    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "normal", action: "confirm" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("not an auto-derived pattern");
  });

  it("400s for an invalid action", async () => {
    seedPattern(db, "p1", "You tend to test things");
    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "promote" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("confirm strips auto-pattern, adds kind:semantic + status:canonical, and the entry becomes recallable", async () => {
    seedPattern(db, "p1", "You tend to write tests before shipping");
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "p1", score: 0.9, metadata: { parentId: "p1", isUpdate: false } }],
        }),
      }),
    });

    // Before confirmation the pattern is excluded from recall at D1 hydration.
    let recall = await worker.fetch(req("GET", "/recall?query=tests"), env, ctx);
    let recallData = await recall.json() as any;
    expect(recallData.results ?? []).toHaveLength(0);

    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "confirm" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, id: "p1", action: "confirm" });

    const tags = JSON.parse(db.entries.find((e: any) => e.id === "p1").tags);
    expect(tags).not.toContain("auto-pattern");
    expect(tags).toContain("kind:semantic");
    expect(tags).toContain("status:canonical");

    // After confirmation the same query returns it.
    recall = await worker.fetch(req("GET", "/recall?query=tests"), env, ctx);
    recallData = await recall.json() as any;
    expect(recallData.results).toHaveLength(1);
    expect(recallData.results[0].id).toBe("p1");
  });

  it("dismiss deprecates: vectors deleted, status:deprecated applied, row kept", async () => {
    seedPattern(db, "p1", "You tend to dismiss patterns");
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ deleteByIds }) });

    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "dismiss" } }), env, ctx);
    expect(res.status).toBe(200);

    const row = db.entries.find((e: any) => e.id === "p1");
    expect(row).toBeDefined(); // audit row kept
    expect(JSON.parse(row.tags)).toContain("status:deprecated");
    expect(row.vector_ids).toBe("[]");
    expect(deleteByIds).toHaveBeenCalledWith(["p1"]);
  });
});
