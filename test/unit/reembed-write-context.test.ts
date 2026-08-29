/**
 * The three re-embed repair paths — capture's smart-merge, the embedding-model
 * migration, and POST /vectorize-pending — all call storeEntry/reembedOrThrow,
 * which stamps `metadata.workspace_id` on every Vectorize vector it writes
 * (src/capture/store.ts). None of these sites is reachable from a request
 * identity for the TARGET row, so each must derive the workspace from the row
 * being repaired rather than from the caller.
 *
 * Before the fix, all three omitted the context and re-stamped the vector with
 * "" — silently detaching it from its entry's workspace and defeating
 * queryVectorizeScoped's metadata filter. Real SQLite is used throughout
 * because the assertion is about what actually lands in Vectorize metadata and
 * D1, not about which function was called.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeKVMock, makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { DEFAULTS } from "../../src/config";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { captureEntry } from "../../src/capture/entry";
import { runBatch, clearMigration } from "../../src/migration/embedding";
import worker from "../../src/index";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

describe("Merge re-embed carries the writer's workspace (src/capture/entry.ts)", () => {
  let d1: SqliteD1;

  beforeEach(async () => {
    resetDatabaseInit();
    d1 = makeSqliteD1();
  });
  afterEach(() => d1.close());

  it("re-embeds the merge target's vector with the writer's workspace, not ''", async () => {
    const upsert = vi.fn().mockResolvedValue({ mutationId: "m" });
    const env = {
      DB: d1.db as unknown as Env["DB"],
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        upsert,
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string, opts: any) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          const prompt: string = (opts?.messages ?? []).map((m: any) => m.content).join("\n");
          if (prompt.includes("Choose exactly one action")) {
            return makeSseStream('{"action":"merge","target_id":"existing-id","merged_content":"Combined memory"}');
          }
          return makeSseStream('{"importance":2,"canonical":false,"kind":"episodic"}');
        }),
      } as unknown as Ai,
      OAUTH_KV: makeKVMock(),
      AUTH_TOKEN: "test-token",
    } as Env;

    await initializeDatabase(env);
    // The merge target already lives in ws-a — dedupe (checkDuplicateAndContradiction)
    // only ever returns a target inside the writer's own workspace, so this is the
    // realistic precondition, not an artificial seed.
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, workspace_id, actor_id)
       VALUES ('existing-id', 'I prefer dark mode', '[]', 'api', ?, ?, '["existing-id"]', 0, 2, 'ws-a', 'user-a')`,
    ).bind(Date.now() - 1000, Date.now() - 1000).run();

    const result = await captureEntry(
      "I like dark mode at night",
      [],
      "api",
      env,
      makeCtx(),
      DEFAULTS,
      { workspaceId: "ws-a", actorId: "user-a" },
    );

    expect(result.status).toBe("merged");
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertedVectors = upsert.mock.calls[0][0] as { metadata: Record<string, unknown> }[];
    expect(upsertedVectors).toHaveLength(1);
    expect(upsertedVectors[0].metadata.workspace_id).toBe("ws-a");
    expect(upsertedVectors[0].metadata.workspace_id).not.toBe("");
  });
});

describe("Migration re-embed carries the row's workspace (src/migration/embedding.ts)", () => {
  let d1: SqliteD1;

  beforeEach(async () => {
    resetDatabaseInit();
    d1 = makeSqliteD1();
  });
  afterEach(() => d1.close());

  it("stamps ws-b on the migrated row's vector, taken from the row not the caller", async () => {
    const upsert = vi.fn().mockResolvedValue({ mutationId: "m" });
    const env = {
      DB: d1.db as unknown as Env["DB"],
      VECTORIZE: makeVectorizeMock({ upsert }),
      AI: {
        run: vi.fn().mockResolvedValue({ data: [new Array(384).fill(0.1)] }),
      } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
      AUTH_TOKEN: "test-token",
    } as Env;

    await initializeDatabase(env);
    await clearMigration(env);
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES ('row-b', 'a memory in ws-b', '[]', 'api', ?, ?, '["row-b"]', 'ws-b', 'user-b')`,
    ).bind(Date.now() - 1000, Date.now() - 1000).run();

    const result = await runBatch(env, DEFAULTS);

    expect(result.processed).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertedVectors = upsert.mock.calls[0][0] as { metadata: Record<string, unknown> }[];
    expect(upsertedVectors[0].metadata.workspace_id).toBe("ws-b");
    expect(upsertedVectors[0].metadata.workspace_id).not.toBe("");
  });
});

describe("/vectorize-pending carries the target row's workspace, not the admin's (src/routes/admin.ts)", () => {
  const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
  let d1: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    d1 = makeSqliteD1();
  });
  afterEach(() => d1.close());

  it("upserts Bob's row's vector with Bob's workspace when the admin runs the repair", async () => {
    const upsert = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(undefined, {
      DB: d1.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ upsert }),
      AI: {
        run: vi.fn().mockResolvedValue({ data: [new Array(384).fill(0.1)] }),
      } as unknown as Ai,
    });
    await initializeDatabase(env);

    const roots = await ensureTenantBootstrap(env);
    const bob = await createMember(env, { name: "Bob" });

    const seededAt = Date.now() - 3_600_000;
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES ('bob-pending', 'Bob memory pending vectorization', '[]', 'api', ?, ?, '[]', ?, ?)`,
    ).bind(seededAt, seededAt, bob.member.personalWorkspaceId, bob.member.userId).run();

    const res = await worker.fetch(
      new Request("http://localhost/vectorize-pending", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertedVectors = upsert.mock.calls[0][0] as { metadata: Record<string, unknown> }[];
    expect(upsertedVectors[0].metadata.workspace_id).toBe(bob.member.personalWorkspaceId);
    expect(upsertedVectors[0].metadata.workspace_id).not.toBe(roots.ownerPersonalWorkspaceId);
    expect(upsertedVectors[0].metadata.workspace_id).not.toBe("");
  });
});
