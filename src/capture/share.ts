import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { isCompanyWorkspace, scopeWhere, scopeWrite } from "../lib/scope";
import { VECTORIZE_GET_BY_IDS_BATCH } from "../constants";

/** Move entries between personal and company workspaces; sharing is not a copy. */

export type ShareTarget = "personal" | "company";

export type ShareResult =
  | { status: "shared"; workspaceId: string; vectorIds: string[] }
  | { status: "unshared"; workspaceId: string; vectorIds: string[] }
  | { status: "no_change"; workspaceId: string; vectorIds: string[] }
  | { status: "not_found" }
  | { status: "forbidden" };

export async function moveEntry(
  id: string,
  target: ShareTarget,
  env: Env,
  identity: Identity,
  team?: string,
): Promise<ShareResult> {
  const scope = scopeWhere(identity);
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, actor_id, vector_ids FROM entries WHERE id = ? AND ${scope.clause}`
  ).bind(id, ...scope.bindings).first<{ id: string; workspace_id: string; actor_id: string; vector_ids: string }>();
  if (!row) return { status: "not_found" };

  // Parse before moving the row so malformed metadata cannot fail after commit.
  let vectorIds: string[] = [];
  try { vectorIds = JSON.parse(row.vector_ids ?? "[]") as string[]; } catch { vectorIds = []; }

  // Admins un-share another person's entry into their own personal workspace.
  const targetWorkspaceId = scopeWrite(identity, target, target === "company" ? team : undefined);
  // Carries vectorIds/workspaceId like the moved branches do, so a caller can
  // repair a stale Vectorize stamp on an already-moved row by re-running.
  if (row.workspace_id === targetWorkspaceId) return { status: "no_change", workspaceId: targetWorkspaceId, vectorIds };

  if (isCompanyWorkspace(identity, row.workspace_id) && target === "personal") {
    const isActor = row.actor_id === identity.userId;
    if (!isActor && identity.role !== "admin") return { status: "forbidden" };
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(targetWorkspaceId, id),
    // Edges carry denormalized workspace metadata and must move with the entry.
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
 * Best-effort metadata update; SQL remains the correctness boundary.
 * Never throws (per-chunk catch, not one catch around the whole loop, so one
 * bad chunk doesn't abort the rest) — /share's ctx.waitUntil path depends on
 * that. Returns whether every chunk actually succeeded, for callers (the
 * #347 move route) that need to know rather than just fire-and-forget.
 */
export async function restampVectorWorkspace(env: Env, vectorIds: string[], workspaceId: string): Promise<{ ok: boolean }> {
  let ok = true;
  for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    const batch = vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
    if (!batch.length) continue;
    try {
      const vectors = await env.VECTORIZE.getByIds(batch);
      if (!vectors.length) continue;
      await env.VECTORIZE.upsert(
        vectors.map(v => ({ ...v, metadata: { ...v.metadata, workspace_id: workspaceId } })),
      );
    } catch (e) {
      console.error("Vectorize workspace re-stamp failed (non-fatal):", e);
      ok = false;
    }
  }
  return { ok };
}
