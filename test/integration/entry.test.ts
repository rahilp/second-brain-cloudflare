import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /entry", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("GET", "/entry?id=a", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("GET", "/entry"), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns the full row with tags parsed to an array", async () => {
    const longContent = "A memory well past the eighty character graph label limit — ".repeat(4);
    db.entries.push({ id: "a", content: longContent, tags: '["work","kind:semantic"]', source: "api", created_at: 1234, vector_ids: '["v"]', recall_count: 3, importance_score: 4 });

    const res = await worker.fetch(req("GET", "/entry?id=a"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.entry).toEqual({
      id: "a",
      content: longContent, // full content, not an 80-char label
      tags: ["work", "kind:semantic"],
      source: "api",
      created_at: 1234,
    });
  });

  it("404s for an unknown id", async () => {
    const res = await worker.fetch(req("GET", "/entry?id=ghost"), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toContain("ghost");
  });
});
