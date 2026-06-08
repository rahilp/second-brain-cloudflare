import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /list", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns empty array when no entries", async () => {
    const res = await worker.fetch(req("GET", "/list"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toEqual([]);
  });

  it("returns entries sorted newest first", async () => {
    db.entries.push(
      { id: "old", content: "Old", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "new", content: "New", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]" },
    );

    const res = await worker.fetch(req("GET", "/list"), env, ctx);
    const data = await res.json() as any[];
    expect(data[0].id).toBe("new");
    expect(data[1].id).toBe("old");
  });

  it("respects ?n= limit", async () => {
    for (let i = 0; i < 10; i++) {
      db.entries.push({ id: `e${i}`, content: `Entry ${i}`, tags: "[]", source: "api", created_at: i, vector_ids: "[]" });
    }

    const res = await worker.fetch(req("GET", "/list?n=5"), env, ctx);
    const data = await res.json() as any[];
    expect(data).toHaveLength(5);
  });

  it("caps ?n= at 100 even when a larger value is requested", async () => {
    for (let i = 0; i < 110; i++) {
      db.entries.push({ id: `e${i}`, content: `Entry ${i}`, tags: "[]", source: "api", created_at: i, vector_ids: "[]" });
    }

    const res = await worker.fetch(req("GET", "/list?n=200"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data.length).toBeLessThanOrEqual(100);
  });

  it("returns a valid response when ?n= is non-numeric", async () => {
    db.entries.push({ id: "x", content: "One", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" });

    const res = await worker.fetch(req("GET", "/list?n=abc"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  // ── Filter parity with list_recent (?tag, ?after, ?before) ──────────────────

  it("filters by ?tag=", async () => {
    db.entries.push(
      { id: "work-1", content: "Work note", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "idea-1", content: "Idea note", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: "[]" },
    );

    const res = await worker.fetch(req("GET", "/list?tag=work"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("work-1");
  });

  it("filters by ?after=", async () => {
    db.entries.push(
      { id: "old", content: "Old", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "new", content: "New", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]" },
    );

    const res = await worker.fetch(req("GET", "/list?after=1500"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("new");
  });

  it("filters by ?before=", async () => {
    db.entries.push(
      { id: "old", content: "Old", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "new", content: "New", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]" },
    );

    const res = await worker.fetch(req("GET", "/list?before=1500"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("old");
  });

  it("combines ?tag=, ?after= and ?before=", async () => {
    db.entries.push(
      { id: "work-old", content: "Work old", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "work-mid", content: "Work mid", tags: '["work"]', source: "api", created_at: 2000, vector_ids: "[]" },
      { id: "work-new", content: "Work new", tags: '["work"]', source: "api", created_at: 3000, vector_ids: "[]" },
      { id: "idea-mid", content: "Idea mid", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: "[]" },
    );

    const res = await worker.fetch(req("GET", "/list?tag=work&after=1500&before=2500"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("work-mid");
  });

  it("includes vector_ids field in each entry", async () => {
    db.entries.push({
      id: "v1", content: "Vectorized note", tags: "[]", source: "api",
      created_at: 1000, vector_ids: '["v1"]',
    });
    db.entries.push({
      id: "v2", content: "Unvectorized note", tags: "[]", source: "api",
      created_at: 2000, vector_ids: "[]",
    });

    const res = await worker.fetch(req("GET", "/list"), env, ctx);
    const data = await res.json() as any[];
    const v1 = data.find((e: any) => e.id === "v1");
    const v2 = data.find((e: any) => e.id === "v2");
    expect(v1.vector_ids).toBe('["v1"]');
    expect(v2.vector_ids).toBe("[]");
  });
});
