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

describe("GET /stats — vectorization fields", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns unvectorized: 0 when all entries are vectorized", async () => {
    db.entries.push({
      id: "a", content: "content", tags: "[]", source: "api",
      created_at: Date.now() - 600000, vector_ids: '["a"]', recall_count: 0, importance_score: 0,
    });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(0);
  });

  it("returns unvectorized: 0 for entries within the grace window (pending)", async () => {
    // created_at = now → within 5-minute grace window → not counted as failed
    db.entries.push({
      id: "b", content: "content", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(0);
  });

  it("counts past-grace entries with vector_ids=[] as unvectorized", async () => {
    db.entries.push(
      { id: "old-1", content: "c1", tags: "[]", source: "api", created_at: Date.now() - 600000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "old-2", content: "c2", tags: "[]", source: "api", created_at: Date.now() - 700000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "vec",   content: "c3", tags: "[]", source: "api", created_at: Date.now() - 600000, vector_ids: '["vec"]', recall_count: 0, importance_score: 0 },
    );
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(2);
  });

  it("returns vectorize_grace_ms in response", async () => {
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.vectorize_grace_ms).toBe(300000);
  });

  it("uses VECTORIZE_GRACE_MS env var when set", async () => {
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    // entry that is 90 seconds old — past the 60s grace but within default 300s
    db.entries.push({
      id: "x", content: "c", tags: "[]", source: "api",
      created_at: Date.now() - 90000, vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(1);
    expect(data.vectorize_grace_ms).toBe(60000);
  });
});

describe("GET /stats — digest candidates", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  function compressible(id: string, tag: string) {
    return { id, content: `c ${id}`, tags: JSON.stringify([tag]), source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0, contradiction_wins: 0 };
  }

  it("reports a tag with >10 eligible entries as a digest candidate", async () => {
    for (let i = 0; i < 11; i++) db.entries.push(compressible(`e-${i}`, "work"));
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.digest_candidates.some((c: any) => c.tag === "work" && c.count === 11)).toBe(true);
  });

  it("does not report a tag whose entries are all recall-protected", async () => {
    for (let i = 0; i < 11; i++) db.entries.push({ ...compressible(`e-${i}`, "work"), recall_count: 5 });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.digest_candidates.some((c: any) => c.tag === "work")).toBe(false);
  });

  it("does not report a tag whose entries are all contradiction survivors", async () => {
    for (let i = 0; i < 11; i++) db.entries.push({ ...compressible(`e-${i}`, "work"), contradiction_wins: 1 });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.digest_candidates.some((c: any) => c.tag === "work")).toBe(false);
  });

  it("excludes reserved namespaced tags (kind:* / status:*) from digest candidates", async () => {
    for (let i = 0; i < 12; i++) {
      db.entries.push({
        ...compressible(`e-${i}`, "work"),
        tags: JSON.stringify(["work", "kind:semantic", "status:canonical"]),
      });
    }
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    const tags = data.digest_candidates.map((c: any) => c.tag);
    expect(tags).toContain("work");                  // topical tag still a candidate
    expect(tags).not.toContain("kind:semantic");     // namespaced excluded
    expect(tags).not.toContain("status:canonical");  // namespaced excluded
  });
});
