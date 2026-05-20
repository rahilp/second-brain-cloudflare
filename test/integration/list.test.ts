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
});
