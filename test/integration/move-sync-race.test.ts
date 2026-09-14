/**
 * #347 review: the concurrency hazard nobody had considered before the
 * mutation pass — a sync running during (or after) a drain can silently
 * revert a moved entry's vector stamp.
 *
 * `makeMirrorStore(env, writeCtx).updateEntry` (src/integrations/mirror.ts)
 * is what every provider's sync calls when an already-mirrored page changes
 * upstream. It re-embeds with `storeEntry(..., writeCtx)` — the SYNC's own
 * write context, resolved from the connection's CURRENT `mirrorWorkspace`
 * setting (`mirrorWriteContext`), not from the row's actual current
 * `workspace_id`. Contrast with the manual-edit path,
 * `updateEntryContent` (src/capture/store.ts), which explicitly reads
 * `embedContextForRow(row, writeCtx)` — the row's OWN current workspace —
 * specifically so an edit cannot silently reset a shared row's vectors to the
 * editor's own workspace. The mirror sync's `updateEntry` has no equivalent
 * guard.
 *
 * Sequence that trips it: #347 moves a mirrored page's D1 row and vectors
 * into company. The connection's OWN `mirrorWorkspace` setting is still
 * "personal" (#347 moves already-synced memories; it does not change the
 * setting — that's #346's job, and the two are explicitly independent
 * actions). The next scheduled sync notices the page changed upstream
 * (calendar.ts / notion.ts's own diff), calls `updateEntry`, and
 * `mirrorWriteContext` resolves the connection's write context to the
 * owner's PERSONAL workspace — exactly what it did before the move. The
 * fresh vectors it uploads carry `metadata.workspace_id = personal`,
 * clobbering the correct `company` stamp #347 just wrote, even though the D1
 * row itself is untouched (`updateEntry`'s own UPDATE never touches
 * `workspace_id` — only the vector metadata drifts).
 *
 * This is pinned here, not fixed: it is a real, plausible defect but not
 * #347's to fix (the same "not in scope, don't accidentally fix it as a side
 * effect" boundary the data contract draws around #348/#349). If this pin
 * ever turns green with the OPPOSITE metadata (i.e. someone fixes
 * `updateEntry` to read the row's current workspace), that is progress, and
 * this test should be deleted in the same change, not updated to expect the
 * fix — a pin exists to make an undecided defect visible, not to enforce
 * staying broken.
 */
import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import { moveEntry, restampVectorWorkspace } from "../../src/capture/share";
import { makeMirrorStore } from "../../src/integrations/mirror";
import type { Env } from "../../src/env";

function makeStatefulVectorizeMock() {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const upsert = vi.fn(async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
    for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: { ...v.metadata } });
    return { mutationId: "m" };
  });
  const getByIds = vi.fn(async (ids: string[]) => ids.map((id) => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v));
  const vectorize = makeVectorizeMock({ upsert: upsert as never, getByIds: getByIds as never });
  return { vectorize, store };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

describe("#347 pinned hazard: a sync racing a move can revert the moved entry's vector stamp", () => {
  it("mirror sync's updateEntry re-stamps vectors from its OWN write context, not the row's actual (moved) workspace — CURRENT, undesired behaviour", async () => {
    const { vectorize, store } = makeStatefulVectorizeMock();
    const d1 = makeSqliteD1();
    const env = { ...makeTestEnv(d1.db as unknown as D1Mock, { VECTORIZE: vectorize, OAUTH_KV: makeMemoryKV() }), AUTH_TOKEN: "test-token" } as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const helper = makeCtx();

    await captureEntry("Mirrored page, later moved by #347", [], "notion", env, helper.ctx, undefined, {
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    await helper.drain();
    const { id } = await env.DB.prepare(`SELECT id FROM entries WHERE source = 'notion' LIMIT 1`).first<{ id: string }>() ?? {};

    // #347 moves it into company and correctly re-stamps its vectors —
    // establishing the state a completed move actually leaves behind.
    const moveResult = await moveEntry(id!, "company", env, {
      userId: roots.ownerUserId, role: "admin", personalWorkspaceId: roots.ownerPersonalWorkspaceId, companyWorkspaceIds: [roots.companyWorkspaceId],
    } as any);
    expect(moveResult.status).toBe("shared");
    await restampVectorWorkspace(env, (moveResult as any).vectorIds, roots.companyWorkspaceId);
    for (const vid of (moveResult as any).vectorIds) {
      expect(store.get(vid)?.metadata.workspace_id).toBe(roots.companyWorkspaceId); // correct, post-move
    }

    // The connection's OWN setting is still "personal" (#347 never touches
    // it) — exactly what a scheduled sync resolves its write context from.
    const staleWriteCtx = { workspaceId: roots.ownerPersonalWorkspaceId, actorId: roots.ownerUserId };
    const mirrorStore = makeMirrorStore(env, staleWriteCtx);
    const updated = await mirrorStore.updateEntry(id!, "Mirrored page, edited upstream after the move");
    expect(updated).toBe(true);

    const row = await env.DB.prepare(`SELECT workspace_id, vector_ids FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string; vector_ids: string }>();
    // The D1 row itself is untouched by updateEntry, as documented — it is
    // still correctly in company.
    expect(row!.workspace_id).toBe(roots.companyWorkspaceId);

    const newVectorIds: string[] = JSON.parse(row!.vector_ids || "[]");
    for (const vid of newVectorIds) {
      // PINNED CURRENT BEHAVIOUR, not desired: the fresh vector's metadata
      // reverted to the sync's own (stale) write context, disagreeing with
      // the row's own (correct) workspace_id above. This is the hazard —
      // if this assertion ever fails because it now correctly reads
      // `roots.companyWorkspaceId`, delete this test rather than "fixing" it,
      // per this file's header comment.
      expect(store.get(vid)?.metadata.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
    }
  });
});
