import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /count", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("rejects missing auth token → 401", async () => {
    const res = await worker.fetch(req("GET", "/count", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns count 0 for empty DB", async () => {
    const res = await worker.fetch(req("GET", "/count"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as { count: number };
    expect(data.count).toBe(0);
  });

  it("returns correct count after entries are added", async () => {
    db.entries.push(
      { id: "a", content: "First", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]" },
      { id: "b", content: "Second", tags: "[]", source: "api", created_at: 2000, vector_ids: "[]" },
      { id: "c", content: "Third", tags: "[]", source: "api", created_at: 3000, vector_ids: "[]" },
    );
    const res = await worker.fetch(req("GET", "/count"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as { count: number };
    expect(data.count).toBe(3);
  });
});
