/**
 * The WriteContext contract: every entry write stamps its row with the workspace
 * and actor of whoever issued it, defaulting to OWNER_WRITE_CONTEXT ('', '') —
 * pre-team semantics — when a caller has not been threaded yet.
 *
 * Uses the real-SQLite facade because the subject IS the SQL: which values land
 * in which columns of db/schema.sql's entries table. A string-matched D1 mock
 * would pass whatever the fixture said and prove nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeKVMock, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { DEFAULTS } from "../../src/config";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { captureEntry } from "../../src/capture/entry";
import { importExportPayload } from "../../src/entries/import";
import { OWNER_WRITE_CONTEXT } from "../../src/lib/scope";

function makeEmbedAI(): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      // Non-embedding calls are the classifier, whose failures are non-fatal;
      // rejecting keeps the fixture minimal without affecting what we assert.
      throw new Error("no LLM in this fixture");
    }),
  } as unknown as Ai;
}

function makeSqliteEnv(db = makeSqliteD1()): { env: Env; d1: typeof db } {
  const env = {
    DB: db.db as unknown as Env["DB"],
    VECTORIZE: makeVectorizeMock(),
    AI: makeEmbedAI(),
    OAUTH_KV: makeKVMock(),
    AUTH_TOKEN: "test-token",
  } as Env;
  return { env, d1: db };
}

/** schema.sql predates the runtime ALTERs; init adds updated_at etc. Idempotent. */
async function makeReadyEnv(db = makeSqliteD1()) {
  const { env, d1 } = makeSqliteEnv(db);
  // The init memo is module-scoped, so each fresh in-memory DB needs its own pass.
  resetDatabaseInit();
  await initializeDatabase(env);
  return { env, d1 };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

describe("WriteContext stamping", () => {
  it("captureEntry with a custom context stamps workspace_id and actor_id", async () => {
    const { env, d1 } = await makeReadyEnv();
    const result = await captureEntry(
      "team memory",
      [],
      "api",
      env,
      makeCtx(),
      DEFAULTS,
      { workspaceId: "ws-acme", actorId: "user-7" },
    );
    expect(result.status).toBe("stored");
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = ?`)
      .bind((result as { id: string }).id)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe("ws-acme");
    expect(row?.actor_id).toBe("user-7");
    d1.close();
  });

  it("captureEntry with no context stamps '' and '' (owner semantics)", async () => {
    const { env, d1 } = await makeReadyEnv();
    const result = await captureEntry("legacy memory", [], "api", env, makeCtx(), DEFAULTS);
    expect(result.status).toBe("stored");
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = ?`)
      .bind((result as { id: string }).id)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe(OWNER_WRITE_CONTEXT.workspaceId);
    expect(row?.actor_id).toBe(OWNER_WRITE_CONTEXT.actorId);
    d1.close();
  });

  it("imported rows carry the workspace_id/actor_id columns defaulted ''", async () => {
    const { env, d1 } = await makeReadyEnv();
    const summary = await importExportPayload(
      env,
      { version: 2, entries: [{ id: "imp-1", content: "restored memory", tags: [] }] },
    );
    expect(summary.imported).toBe(1);
    const row = await env.DB.prepare(`SELECT workspace_id, actor_id FROM entries WHERE id = 'imp-1'`)
      .first<{ workspace_id: string; actor_id: string }>();
    expect(row?.workspace_id).toBe("");
    expect(row?.actor_id).toBe("");
    d1.close();
  });
});
