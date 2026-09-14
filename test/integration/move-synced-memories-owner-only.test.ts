/**
 * #347 locked decision 1: only the tenant owner may drive the move, and a
 * non-owner admin must be refused with a reason — never told "moved 0" as if
 * it succeeded. That exact confusion is the defect the issue was filed about
 * (mirrored memories live in the owner's workspace, so a non-owner admin's
 * scoped SELECT would silently match nothing).
 *
 * See move-synced-memories.test.ts's header comment for the route contract
 * this exercises: POST /integrations/:provider/move.
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { D1Mock } from "../helpers/d1-mock";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap, type TenantRoots } from "../../src/lib/tenancy";
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

async function makeEnv() {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: makeVectorizeMock(), OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

async function seedMirrored(env: Env, roots: TenantRoots, helper: { ctx: ExecutionContext; drain: () => Promise<unknown> }, n: number): Promise<string[]> {
  for (let i = 0; i < n; i++) {
    await captureEntry(`Mirrored page ${i} awaiting a move`, [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
  }
  await helper.drain();
  const { results } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' ORDER BY created_at ASC`).all<{ id: string }>();
  return results.map((r) => r.id);
}

async function connectNotion(env: Env, ids: string[]) {
  const itemMap = Object.fromEntries(ids.map((id, i) => [`page-${i}`, { entryId: id, version: "v1" }]));
  await env.OAUTH_KV.put(
    "integrations:notion",
    JSON.stringify({
      provider: "notion", authKind: "token", credentials: { token: "t" }, config: { mirrorWorkspace: "company" },
      status: "connected", workspaceName: "Acme", lastSyncedAt: Date.now(), lastSyncError: null,
      itemMap, createdAt: 0, updatedAt: 0,
    }),
  );
}

describe("#347 owner-only move authorization", () => {
  it("refuses a non-owner admin with a reason, moves nothing, and its response cannot be mistaken for a completed move of zero", async () => {
    const { env, roots } = await makeEnv();
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 2);
    await connectNotion(env, ids);

    // A second admin, created after tenant bootstrap, so findOwner's
    // earliest-created-admin rule still names the original owner, not Carol.
    const carol = await createMember(env, { name: "Carol", role: "admin" });
    expect(carol.member.userId).not.toBe(roots.ownerUserId);

    const res = await worker.fetch(
      req("POST", "/integrations/notion/move", { body: {}, token: carol.token }),
      env,
      makeCtx().ctx,
    );

    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe("string");
    expect(data.error.length).toBeGreaterThan(0);
    // The precise confusion the issue was filed about: a refusal must not
    // carry the same shape a completed zero-item move would.
    expect(data.moved).toBeUndefined();
    expect(data.alreadyThere).toBeUndefined();
    expect(data.missing).toBeUndefined();
    expect(data.refused).toBeUndefined();
    expect(data.remaining).toBeUndefined();
    expect(data.cursor).toBeUndefined();

    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first<{ workspace_id: string }>();
      expect(row!.workspace_id).toBe(roots.ownerPersonalWorkspaceId); // untouched
    }

    // And no audit event was written for a move that never ran.
    const { results: auditRows } = await env.DB.prepare(
      `SELECT event FROM admin_events WHERE event = 'integration_memories_moved'`,
    ).all();
    expect(auditRows.length).toBe(0);
  });

  it("a plain member (not even an admin) is refused the same way, not with a different error shape", async () => {
    const { env, roots } = await makeEnv();
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 1);
    await connectNotion(env, ids);

    const erin = await createMember(env, { name: "Erin" }); // role defaults to member

    const res = await worker.fetch(
      req("POST", "/integrations/notion/move", { body: {}, token: erin.token }),
      env,
      makeCtx().ctx,
    );
    // Admin-gated at the edge (same regex family as connect/sync/disconnect/layer).
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);

    const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(ids[0]).first<{ workspace_id: string }>();
    expect(row!.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
  });

  it("the tenant owner (not merely any admin) succeeds against the same data", async () => {
    const { env, roots } = await makeEnv();
    const helper = makeCtx();
    const ids = await seedMirrored(env, roots, helper, 2);
    await connectNotion(env, ids);

    // "test-token" is the owner's own token (makeTestEnv's AUTH_TOKEN, the
    // legacy owner sentinel every other integration test in this tree relies
    // on — see test/integration/team-isolation.test.ts's ALICE constant).
    const res = await worker.fetch(req("POST", "/integrations/notion/move", { body: {} }), env, makeCtx().ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.moved).toBe(2);

    for (const id of ids) {
      const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first<{ workspace_id: string }>();
      expect(row!.workspace_id).toBe(roots.companyWorkspaceId);
    }
  });
});
