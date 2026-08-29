import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { isCompanyWorkspace, scopeWhere, scopeWrite } from "../lib/scope";
import { VECTORIZE_GET_BY_IDS_BATCH } from "../constants";

/**
 * Share semantics: MOVE, not copy (spec decision, 2026-08-24). A shared entry
 * re-namespaces to the company workspace and stays one canonical row, so
 * contradiction scoring, compression eligibility and recall ranking all keep
 * seeing a single coherent fact. Un-sharing moves it back to the actor's
 * personal workspace.
 *
 * Who may move what:
 *   - personal → company: any member, for any entry in their readable set that
 *     is not already company-owned. Sharing your own memory is the normal case;
 *     sharing a company-visible row again is a no-op.
 *   - company → personal: only the entry's original actor or an admin. A member
 *     cannot un-share someone else's shared memory.
 *
 * Vector note: entries and their edges move here, and so do their vectors'
 * `workspace_id` metadata — restampVectorWorkspace below, called by the
 * REST/MCP callers after this returns. Per-workspace Vectorize namespaces
 * (P3/stage 3) are NOT built, so there is nothing to physically relocate; this
 * is a metadata-only re-stamp so the dense arm of recall (which filters on
 * that field, src/vectorize/scope.ts) stops excluding a just-shared entry from
 * every colleague's results. It is deliberately best-effort: hydration is
 * already scoped at the SQL layer, so a stale vector tag is a ranking
 * imperfection, never a correctness or leakage issue.
 */

export type ShareTarget = "personal" | "company";

export type ShareResult =
  | { status: "shared"; workspaceId: string; vectorIds: string[] }
  | { status: "unshared"; workspaceId: string; vectorIds: string[] }
  | { status: "no_change" }
  | { status: "not_found" }
  | { status: "forbidden" };

export async function moveEntry(
  id: string,
  target: ShareTarget,
  env: Env,
  identity: Identity,
): Promise<ShareResult> {
  const scope = scopeWhere(identity);
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, actor_id, vector_ids FROM entries WHERE id = ? AND ${scope.clause}`
  ).bind(id, ...scope.bindings).first<{ id: string; workspace_id: string; actor_id: string; vector_ids: string }>();
  if (!row) return { status: "not_found" };

  // An un-shared entry returns to the MOVER's personal workspace when they are
  // an admin acting on someone else's row; actors always move their own back to
  // their own. scopeWrite resolves both from the identity, so this can never
  // target a workspace the caller does not belong to.
  const targetWorkspaceId = scopeWrite(identity, target);
  if (row.workspace_id === targetWorkspaceId) return { status: "no_change" };

  if (isCompanyWorkspace(identity, row.workspace_id) && target === "personal") {
    const isActor = row.actor_id === identity.userId;
    if (!isActor && identity.role !== "admin") return { status: "forbidden" };
  }

  // Parsed before the D1 move, not after: storeEntry's schema guarantees
  // vector_ids is NOT NULL DEFAULT '[]', so this cannot fail today, but
  // parsing after the batch would mean a malformed value moves the row in D1
  // and then throws — losing the audit event and returning a 500 for a state
  // change that already happened. Same defensive shape as the identical
  // parse in src/lib/team-admin.ts.
  let vectorIds: string[] = [];
  try { vectorIds = JSON.parse(row.vector_ids ?? "[]") as string[]; } catch { vectorIds = []; }

  await env.DB.batch([
    env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(targetWorkspaceId, id),
    // Edges are denormalized from their source entry's workspace at insert time;
    // moving an entry without its edges would strand them in the old workspace,
    // where scoped graph walks could never find them again.
    //
    // Either endpoint, not source_id alone: edgeInsertStatement REORDERS a
    // symmetric pair lexically before inserting, so whether the entry being
    // moved sits in source_id or target_id is decided by how its id sorts
    // against the other endpoint's — not by who linked what. Matching only
    // source_id therefore carried the edge on about half the ids and stranded
    // it on the other half, pointing at a row that had left the workspace.
    //
    // Only workspace_id is written. The endpoint columns are left exactly as
    // stored, because for the directed types (supersedes, causes, …) their
    // order IS the claim the edge makes.
    env.DB.prepare(`UPDATE edges SET workspace_id = ? WHERE source_id = ? OR target_id = ?`)
      .bind(targetWorkspaceId, id, id),
  ]);

  return {
    status: target === "company" ? "shared" : "unshared",
    workspaceId: targetWorkspaceId,
    vectorIds,
  };
}

/**
 * Re-stamps every one of an entry's vectors with its new workspace after a
 * share/unshare. Vectorize has no metadata-only update — the only route is
 * getByIds -> mutate metadata -> upsert — but getByIds returns `values` too,
 * so this re-uses them: no re-embedding, no AI subrequest, just two Vectorize
 * calls per batch of VECTORIZE_GET_BY_IDS_BATCH ids.
 *
 * Non-fatal by contract: the SQL layer is the correctness boundary (every
 * hydration is scoped there regardless of vector metadata), and a share must
 * not fail — or leave the entry's already-committed D1 move unreachable —
 * because the vector index happens to be down. Callers fire this via
 * ctx.waitUntil AFTER the D1 move and its audit event, so a Vectorize outage
 * can never cost the state change or the audit trail, only this cosmetic
 * ranking follow-up.
 */
export async function restampVectorWorkspace(env: Env, vectorIds: string[], workspaceId: string): Promise<void> {
  try {
    for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
      const batch = vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
      if (!batch.length) continue;
      const vectors = await env.VECTORIZE.getByIds(batch);
      if (!vectors.length) continue;
      await env.VECTORIZE.upsert(
        vectors.map(v => ({ ...v, metadata: { ...v.metadata, workspace_id: workspaceId } })),
      );
    }
  } catch (e) {
    console.error("Vectorize workspace re-stamp failed (non-fatal):", e);
  }
}
