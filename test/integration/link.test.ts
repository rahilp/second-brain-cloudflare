import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

async function seedLinkEntries(env: Env, ids: string[]) {
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const now = Date.now();
  for (const id of ids) {
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, `entry ${id}`, "[]", "test", now, now, "[]", roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
  }
}

describe("POST /link", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeTestEnv(db);
    await seedLinkEntries(env, ["a", "b", "new", "old"]);
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
