/**
 * #347's headline acceptance criterion, rebuilt after review found the
 * original fixture vacuous: `GET /recall`'s keyword path is D1-scoped (LIKE
 * over `entries.content`, filtered by the caller's readable `workspace_id`s),
 * so once a move's D1 UPDATE lands, a second team member's keyword search
 * finds the row regardless of whether its Vectorize metadata was ever
 * re-stamped. A test that only checks "recall found it" after a move can
 * therefore pass even with the vector re-stamp deleted outright — proving the
 * column write, exactly what the plan says this test must NOT do.
 *
 * Fix: use a query with no literal overlap with the entry's content, and a
 * STATEFUL, workspace-FILTERING Vectorize double (same shape as
 * test/integration/duplicate-workspace-scope.test.ts's `filteringVectorize`,
 * made stateful so the filter tracks metadata this test's own move call
 * mutates). Keyword search then finds nothing at all — every result has to
 * come through Vectorize's `workspace_id: {$in: [...]}` filter, which only
 * admits Bob once the entry's vector metadata actually says his readable
 * workspace. This makes the test fail if the re-stamp is skipped, deferred
 * past the response, or silently swallowed, because in every one of those
 * cases the metadata stays stamped with the owner's PERSONAL workspace, which
 * is never in Bob's `$in` set.
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { captureEntry } from "../../src/capture/entry";
import type { Env } from "../../src/env";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

/** Stateful AND workspace-filtering — the two properties duplicate-workspace-
 * scope.test.ts's own doubles each have separately, combined here because
 * this file needs a query whose result set actually changes when THIS test's
 * own move call mutates metadata mid-run. */
function makeStatefulFilteringVectorizeMock(opts: { rejectGetByIds?: boolean } = {}) {
  const state = { reject: !!opts.rejectGetByIds };
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => {
    if (state.reject) throw new Error("Vectorize is down");
    return ids.map((id) => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
  });
  const query = vi.fn(async (_values: number[], queryOpts: any) => {
    const wanted: string[] | undefined = queryOpts?.filter?.workspace_id?.$in;
    const matches = [...store.values()]
      .filter((v) => !wanted || wanted.includes(String(v.metadata.workspace_id)))
      .map((v) => ({ id: v.id, score: 0.9, metadata: v.metadata, values: v.values }));
    return { matches };
  });
  const vectorize = makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never, query: query as never });
  return { vectorize, store, upsert, getByIds, query, setReject: (v: boolean) => { state.reject = v; } };
}

async function makeEnv(vectorize: ReturnType<typeof makeVectorizeMock>) {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

// Deliberately shares no word with any fixture content in this file, so the
// keyword path (LIKE '%term%' over entries.content) contributes zero
// candidates and the whole result set comes from Vectorize's filtered query.
const QUERY = "xenoprocedural";

describe("#347 scoped recall visibility genuinely depends on the vector re-stamp", () => {
  it("a second team member's semantic-only recall does not find a moved memory until its vector metadata is re-stamped, and does once it is", async () => {
    const { vectorize } = makeStatefulFilteringVectorizeMock();
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const bob = await createMember(env, { name: "Bob" });

    await captureEntry("Design team notes about next release scheduling and staffing", [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};
    expect(id).toBeTruthy();

    const before = await worker.fetch(req("GET", `/recall?query=${QUERY}`, { token: bob.token }), env, makeCtx().ctx);
    expect(before.status).toBe(200);
    const beforeIds = ((await before.json()) as any).results.map((r: any) => r.id);
    expect(beforeIds).not.toContain(id); // owner's personal metadata is not in Bob's $in set

    await env.OAUTH_KV.put(
      "integrations:notion",
      JSON.stringify({
        provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
        status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
        itemMap: { "page-0": { entryId: id, version: "v1" } }, createdAt: 0, updatedAt: 0,
      }),
    );
    const moveCall = makeCtx();
    const moveRes = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, moveCall.ctx);
    expect(moveRes.status).toBe(200);
    const moveData = await moveRes.json() as any;
    expect(moveData.moved).toBe(1);
    // Pinned new field (see this file's sibling move-synced-memories.test.ts
    // and the test-author's report): the route must positively confirm the
    // re-stamp, not merely attempt it and swallow the result the way
    // restampVectorWorkspace does today. Absent today, so this line alone
    // already fails against the current implementation.
    expect(moveData.vectorFailures).toBe(0);
    await moveCall.drain();

    const after = await worker.fetch(req("GET", `/recall?query=${QUERY}`, { token: bob.token }), env, makeCtx().ctx);
    expect(after.status).toBe(200);
    const afterIds = ((await after.json()) as any).results.map((r: any) => r.id);
    expect(afterIds).toContain(id); // now filtered IN, because the metadata itself changed
  });

  it("self-healing: a re-run after a failed re-stamp repairs the vector metadata, and a second team member's recall then finds it", async () => {
    // getByIds throws on the FIRST move call only, so the first run's D1 move
    // commits but restampVectorWorkspace's getByIds/upsert never runs — the
    // exact failure mode restampVectorWorkspace's blanket try/catch hides
    // today. The second call must repair it.
    const { vectorize, setReject } = makeStatefulFilteringVectorizeMock({ rejectGetByIds: true });
    const { env, roots } = await makeEnv(vectorize);
    const helper = makeCtx();
    const bob = await createMember(env, { name: "Bob" });

    await captureEntry("Quarterly staffing plan for the platform group", [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};

    await env.OAUTH_KV.put(
      "integrations:notion",
      JSON.stringify({
        provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
        status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
        itemMap: { "page-0": { entryId: id, version: "v1" } }, createdAt: 0, updatedAt: 0,
      }),
    );

    const firstRes = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, makeCtx().ctx);
    expect(firstRes.status).toBe(200);
    const firstData = await firstRes.json() as any;
    expect(firstData.moved).toBe(1); // D1 committed regardless of Vectorize's outage
    expect(firstData.vectorFailures).toBe(1); // and the response says so — not a clean success

    const midway = await worker.fetch(req("GET", `/recall?query=${QUERY}`, { token: bob.token }), env, makeCtx().ctx);
    const midwayIds = ((await midway.json()) as any).results.map((r: any) => r.id);
    expect(midwayIds).not.toContain(id); // moved in D1, but still invisible on the metadata-gated path

    // Vectorize recovers; the same connection's move is run again over the
    // SAME item map. moveEntry alone would report this as "no_change" for an
    // entry already in the target workspace, which today carries no vectorIds
    // at all — the second run must still attempt (and this time succeed at)
    // the re-stamp.
    setReject(false);

    const secondRes = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, makeCtx().ctx);
    expect(secondRes.status).toBe(200);
    const secondData = await secondRes.json() as any;
    expect(secondData.moved).toBe(0);
    expect(secondData.alreadyThere).toBe(1); // idempotent: the D1 row was already correct
    expect(secondData.vectorFailures).toBe(0); // and this run repaired the vector metadata

    const after = await worker.fetch(req("GET", `/recall?query=${QUERY}`, { token: bob.token }), env, makeCtx().ctx);
    const afterIds = ((await after.json()) as any).results.map((r: any) => r.id);
    expect(afterIds).toContain(id);
  });
});
