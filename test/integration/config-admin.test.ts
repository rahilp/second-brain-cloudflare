/**
 * Deployment config writes are admin-only; members may still read GET /config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

describe("config admin gate", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let memberToken = "";

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
    });
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    const bob = await createMember(env, { name: "Bob" });
    memberToken = bob.token;
  });

  afterEach(() => sqlite.close());

  it("lets members read GET /config", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/config", { headers: { Authorization: `Bearer ${memberToken}` } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("forbids members from PATCH /config", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ MMR_LAMBDA: 0.42 }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("forbids members from DELETE /config/:key", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/config/MMR_LAMBDA", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${memberToken}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("lets admin PATCH /config", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ MMR_LAMBDA: 0.42 }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });
});
