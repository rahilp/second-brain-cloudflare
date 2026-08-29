import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import { restampVectorWorkspace } from "../../src/capture/share";
import type { Env } from "../../src/env";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

/**
 * A Vectorize double that actually remembers what was upserted, so getByIds
 * can hand it back — the real re-stamp round trip (getByIds -> mutate ->
 * upsert) is meaningless against the default auto-mock, which always answers
 * getByIds with [].
 */
function makeStatefulVectorizeMock() {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => ids.map(id => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v));
  const vectorize = makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never });
  return { vectorize, upsert, getByIds, store };
}

async function makeEnv(vectorize: ReturnType<typeof makeVectorizeMock>) {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: vectorize }), AUTH_TOKEN: "test-token" } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

describe("share/unshare re-stamps Vectorize workspace_id", () => {
  it("shares: the restamped upsert carries the company workspace id, and the same vector ids/values as the original", async () => {
    const { vectorize, upsert, getByIds } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const { ctx, drain } = makeCtx();

    await captureEntry("Alice's note about the roadmap", [], "api", env, ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await drain();
    expect(upsert).toHaveBeenCalledTimes(1);
    const firstUpsertVectors = upsert.mock.calls[0][0];

    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};
    expect(id).toBeTruthy();

    const shareCall = makeCtx();
    const res = await worker.fetch(req("POST", "/share", { body: { id } }), env, shareCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("shared");
    await shareCall.drain();

    expect(getByIds).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    const secondUpsertVectors = upsert.mock.calls[1][0];
    expect(secondUpsertVectors).toHaveLength(firstUpsertVectors.length);
    for (let i = 0; i < firstUpsertVectors.length; i++) {
      expect(secondUpsertVectors[i].id).toBe(firstUpsertVectors[i].id);
      expect(secondUpsertVectors[i].values).toEqual(firstUpsertVectors[i].values);
      expect(secondUpsertVectors[i].metadata.workspace_id).toBe(roots.companyWorkspaceId);
    }
  });

  it("unshares: moves the vector metadata back to the actor's personal workspace", async () => {
    const { vectorize, upsert } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const { ctx, drain } = makeCtx();

    await captureEntry("Alice shares, then regrets it", [], "api", env, ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};

    const shareCall = makeCtx();
    await worker.fetch(req("POST", "/share", { body: { id, workspace: "company" } }), env, shareCall.ctx);
    await shareCall.drain();
    expect(upsert).toHaveBeenCalledTimes(2);

    const unshareCall = makeCtx();
    const res = await worker.fetch(req("POST", "/share", { body: { id, workspace: "personal" } }), env, unshareCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("unshared");
    await unshareCall.drain();

    expect(upsert).toHaveBeenCalledTimes(3);
    const thirdUpsertVectors = upsert.mock.calls[2][0];
    for (const v of thirdUpsertVectors) {
      expect(v.metadata.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
    }
  });

  it("batches by VECTORIZE_GET_BY_IDS_BATCH: 25 vectors produce two getByIds calls (20 + 5) and two upserts", async () => {
    const { vectorize, upsert, getByIds, store } = makeStatefulVectorizeMock();
    const vectorIds = Array.from({ length: 25 }, (_, i) => `entry-multi-chunk-${i}`);
    for (const vid of vectorIds) {
      store.set(vid, { id: vid, values: [0.1, 0.2], metadata: { workspace_id: "ws-personal" } });
    }

    await restampVectorWorkspace({ VECTORIZE: vectorize } as unknown as Env, vectorIds, "ws-company");

    expect(getByIds).toHaveBeenCalledTimes(2);
    expect(getByIds.mock.calls[0][0]).toHaveLength(20);
    expect(getByIds.mock.calls[1][0]).toHaveLength(5);
    expect(upsert).toHaveBeenCalledTimes(2);
    const allUpserted = [...upsert.mock.calls[0][0], ...upsert.mock.calls[1][0]];
    expect(allUpserted).toHaveLength(25);
    for (const v of allUpserted) expect(v.metadata.workspace_id).toBe("ws-company");
  });

  it("a Vectorize getByIds failure does not change POST /share's status code, body, or the D1 move", async () => {
    const { vectorize, getByIds } = makeStatefulVectorizeMock();
    getByIds.mockRejectedValue(new Error("Vectorize is down"));
    const { env, roots } = await makeEnv(vectorize);
    const { ctx, drain } = makeCtx();

    await captureEntry("Bob's note survives a broken index", [], "api", env, ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};

    const shareCall = makeCtx();
    const res = await worker.fetch(req("POST", "/share", { body: { id } }), env, shareCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toEqual({ ok: true, id, status: "shared", workspaceId: roots.companyWorkspaceId });

    // The waitUntil'd restamp rejects internally (non-fatal by contract) —
    // draining it must not throw or leave an unhandled rejection.
    await expect(shareCall.drain()).resolves.toBeDefined();

    const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe(roots.companyWorkspaceId);
  });

  it("POST /share with status: no_change performs zero Vectorize calls", async () => {
    const { vectorize, upsert, getByIds } = makeStatefulVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const { ctx, drain } = makeCtx();

    await captureEntry("Never shared", [], "api", env, ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};
    upsert.mockClear();
    getByIds.mockClear();

    const shareCall = makeCtx();
    const res = await worker.fetch(req("POST", "/share", { body: { id, workspace: "personal" } }), env, shareCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("no_change");
    await shareCall.drain();

    expect(upsert).not.toHaveBeenCalled();
    expect(getByIds).not.toHaveBeenCalled();
  });
});
