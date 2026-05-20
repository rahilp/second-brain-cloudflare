import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /append", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { addition: "update" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when addition is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "abc" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "no-such-id", addition: "update" } }), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("appends to existing entry", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries[0].content).toContain("Original content");
    expect(db.entries[0].content).toContain("New info");
  });
});
