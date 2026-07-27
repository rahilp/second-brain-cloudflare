import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /link", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "b" }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when ids are missing", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("creates an explicit edge between two entries", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "b" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.type).toBe("relates_to");
    expect(db.edges).toHaveLength(1);
    expect(db.edges[0].provenance).toBe("explicit");
    expect(db.edges[0].weight).toBe(1); // user-asserted links are full weight
  });

  it("rejects a self-link", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "a" } }), env, ctx);
    expect(res.status).toBe(400);
    expect(db.edges).toHaveLength(0);
  });

  it("rejects an unknown edge type", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "a", target_id: "b", type: "bogus" } }), env, ctx);
    expect(res.status).toBe(400);
    expect(db.edges).toHaveLength(0);
  });

  it("accepts a valid directed type and preserves order", async () => {
    const res = await worker.fetch(req("POST", "/link", { body: { source_id: "new", target_id: "old", type: "supersedes" } }), env, ctx);
    expect(res.status).toBe(200);
    expect(db.edges[0].type).toBe("supersedes");
    expect(db.edges[0].source_id).toBe("new");
    expect(db.edges[0].target_id).toBe("old");
  });
});
