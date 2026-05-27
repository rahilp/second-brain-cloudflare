import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function entry(id: string, tags: string[], importance: number) {
  return { id, content: `Content ${id}`, tags: JSON.stringify(tags), source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: importance };
}

describe("GET /stats", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("GET", "/stats", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns zeroed stats when no entries", async () => {
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.count).toBe(0);
    expect(data.avg_importance).toBeNull();
    expect(data.top_tags).toEqual([]);
  });

  it("returns correct total count", async () => {
    db.entries.push(entry("a", [], 5), entry("b", [], 7));
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.count).toBe(2);
  });

  it("returns avg importance rounded to 1 decimal", async () => {
    db.entries.push(entry("a", [], 5), entry("b", [], 8));
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.avg_importance).toBe(6.5);
  });

  it("returns top tags ordered by frequency", async () => {
    db.entries.push(
      entry("a", ["work", "react"], 5),
      entry("b", ["work", "typescript"], 6),
      entry("c", ["work"], 7),
    );
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.top_tags[0]).toBe("work"); // 3 occurrences — must be first
    expect(data.top_tags).toContain("react");
    expect(data.top_tags).toContain("typescript");
  });

  it("limits top tags to 5", async () => {
    db.entries.push(entry("a", ["a", "b", "c", "d", "e", "f"], 5));
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.top_tags.length).toBeLessThanOrEqual(5);
  });
});
