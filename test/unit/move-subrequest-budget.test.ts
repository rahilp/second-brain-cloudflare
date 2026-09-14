/**
 * #347 locked decision 5: a single move batch must stay well inside the
 * free-plan 50-subrequest ceiling.
 *
 * Rebuilt after review found two gaps in the original version:
 *
 * 1. It counted D1 executions only. The data contract's own arithmetic
 *    (docs/superpowers/plans/2026-09-12-347-data-contract.md §4) names
 *    Vectorize as a real cost too — roughly 2 subrequests (one getByIds, one
 *    upsert) per 20 vector ids restamped — and D1 was never the axis at risk;
 *    Vectorize was, and nothing measured it.
 * 2. It hardcoded 10 fixtures and never read the batch size the route
 *    actually uses, so raising the batch (MOVE_BATCH_SIZE in
 *    src/routes/integrations.ts, not exported) would leave this test green
 *    with no batch big enough to notice. It cannot be imported — it is a
 *    private module constant — so this file PROBES it empirically: seed far
 *    more items than any plausible batch, make one call, and read the
 *    server's own `moved` count back as the real batch size. Every fixture
 *    below is sized from that probe, not from a literal.
 *
 * Worst case is also rebuilt: each entry gets long, NON-mirrored content
 * (mirrored sources are indexed by their first chunk only —
 * src/capture/store.ts's `MIRRORED_SOURCES.has(source)` branch — so a
 * realistic single-vector mirrored fixture would silently under-count the
 * Vectorize axis exactly the way the D1-only version under-counted it).
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import type { Env } from "../../src/env";

const FREE_PLAN_SUBREQUESTS = 50;

// D1 bills EXECUTIONS: run/first/all/exec spend one each, batch() spends one
// however many statements it carries — same rule cron-subrequest-budget.test.ts
// uses, so the two budgets stay comparable.
function countingD1(sqliteDb: any, tally: { d1: number }) {
  const wrap = (stmt: any, sql: string): any => ({
    bind: (...a: any[]) => wrap(stmt.bind(...a), sql),
    run: () => { tally.d1++; return stmt.run(); },
    first: (...a: any[]) => { tally.d1++; return stmt.first(...a); },
    all: () => { tally.d1++; return stmt.all(); },
    __inner: stmt,
  });
  return {
    prepare(sql: string) { return wrap(sqliteDb.prepare(sql), sql); },
    exec(sql: string) { tally.d1++; return sqliteDb.exec(sql); },
    batch: (stmts: any[]) => { tally.d1++; return sqliteDb.batch(stmts.map((s: any) => s.__inner ?? s)); },
  } as unknown as D1Database;
}

// Stateful (round-trips real ids/values, unlike the default auto-mock, whose
// getByIds always answers [] and would silently zero out this whole axis) and
// counted separately from D1 so the two axes can be reported and asserted on
// independently, the way the ceiling is actually spent.
function countingVectorize(tally: { vectorize: number }) {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    tally.vectorize++;
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => {
    tally.vectorize++;
    return ids.map((id) => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
  });
  return makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never });
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

async function connectNotion(env: Env, itemMap: Record<string, { entryId: string; version: string }>) {
  await env.OAUTH_KV.put(
    "integrations:notion",
    JSON.stringify({
      provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
      status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
      itemMap, createdAt: 0, updatedAt: 0,
    }),
  );
}

describe("#347 move batch subrequest budget (D1 + Vectorize)", () => {
  it("keeps a full, worst-case batch of long multi-chunk entries inside the free-plan ceiling, sized from the server's own real batch size", async () => {
    // ── Phase 1: probe the real batch size, without pretending to know it ──
    const probeD1 = makeSqliteD1();
    const probeKv = makeMemoryKV();
    const probeEnv = { ...makeTestEnv(undefined, { DB: probeD1.db as unknown as any, VECTORIZE: makeVectorizeMock(), OAUTH_KV: probeKv }), AUTH_TOKEN: "test-token" } as Env;
    resetDatabaseInit();
    await initializeDatabase(probeEnv);
    const probeRoots = await ensureTenantBootstrap(probeEnv);
    const probeHelper = makeCtx();
    // Far more than any plausible batch size, so the response's `moved` count
    // IS the batch size, not the fixture size.
    const PROBE_COUNT = 200;
    for (let i = 0; i < PROBE_COUNT; i++) {
      await captureEntry(`Probe fixture ${i}`, [], "notion", probeEnv, probeHelper.ctx, undefined, {
        workspaceId: probeRoots.ownerPersonalWorkspaceId, actorId: probeRoots.ownerUserId,
      });
    }
    await probeHelper.drain();
    const { results: probeRows } = await probeEnv.DB.prepare(`SELECT id FROM entries WHERE source = 'notion'`).all<{ id: string }>();
    await connectNotion(probeEnv, Object.fromEntries(probeRows.map((r, i) => [`page-${i}`, { entryId: r.id, version: "v1" }])));

    const probeRes = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), probeEnv, makeCtx().ctx);
    expect(probeRes.status).toBe(200);
    const probeData = await probeRes.json() as any;
    const batchSize = probeData.moved as number;
    expect(batchSize).toBeGreaterThan(0);
    expect(batchSize).toBeLessThan(PROBE_COUNT); // else the probe was too small to find the real ceiling

    // ── Phase 2: the actual worst-case measurement, sized from the probe ──
    const d1 = makeSqliteD1();
    const tally = { d1: 0, vectorize: 0 };
    const vectorize = countingVectorize(tally);
    const kv = makeMemoryKV();
    const env = { ...makeTestEnv(undefined, { DB: countingD1(d1.db, tally), VECTORIZE: vectorize, OAUTH_KV: kv }), AUTH_TOKEN: "test-token" } as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const helper = makeCtx();

    // Long, NON-mirrored content: chunkText splits above CHUNK_MAX_CHARS
    // (1600), and only mirrored sources are truncated to their first chunk.
    // Notion's own MAX_PAGE_CONTENT_CHARS (8000, ~5 chunks) is the documented
    // worst case for ONE provider, but MOVE_BATCH_SIZE has no per-entry size
    // ceiling at all — nothing stops an entry mirrored from a large
    // transcript, a long email thread, or a future provider with no
    // equivalent cap from carrying far more chunks than that. 48000 chars
    // (~30 chunks/entry) models that unbounded case: not Notion specifically,
    // but the batch's actual worst case, which is "as large as one entry's
    // content is allowed to get" — currently unlimited.
    const longContent = "x".repeat(48000);
    for (let i = 0; i < batchSize; i++) {
      await captureEntry(`${longContent} unique-${i}`, [], "api", env, helper.ctx, undefined, {
        workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId,
      });
    }
    await helper.drain();
    const { results } = await env.DB.prepare(`SELECT id, vector_ids FROM entries WHERE source = 'api'`).all<{ id: string; vector_ids: string }>();
    expect(results.length).toBe(batchSize);
    const totalVectorIds = results.reduce((n, r) => n + (JSON.parse(r.vector_ids || "[]") as string[]).length, 0);
    expect(totalVectorIds).toBeGreaterThan(batchSize); // confirms multi-chunk, not a single-vector fixture in disguise

    await connectNotion(env, Object.fromEntries(results.map((r, i) => [`page-${i}`, { entryId: r.id, version: "v1" }])));

    tally.d1 = 0;
    tally.vectorize = 0;
    const moveCall = makeCtx();
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, moveCall.ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.moved).toBe(batchSize);
    await moveCall.drain();

    const total = tally.d1 + tally.vectorize;
    expect(total, `D1=${tally.d1} + Vectorize=${tally.vectorize} = ${total} subrequests for a batch of ${batchSize} entries carrying ${totalVectorIds} vector ids`).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });
});
