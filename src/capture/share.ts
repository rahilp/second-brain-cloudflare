import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { isCompanyWorkspace, scopeWhere, scopeWrite } from "../lib/scope";

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
 * Vector note: entries and their edges move here. The vectors themselves stay
 * put until P3 introduces per-workspace Vectorize namespaces — with one shared
 * index there is nothing to move yet, and hydration is already scoped at the
 * SQL layer, so no cross-workspace read can occur in the meantime.
 */

export type ShareTarget = "personal" | "company";

export type ShareResult =
  | { status: "shared"; workspaceId: string }
  | { status: "unshared"; workspaceId: string }
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
    `SELECT id, workspace_id, actor_id FROM entries WHERE id = ? AND ${scope.clause}`
  ).bind(id, ...scope.bindings).first<{ id: string; workspace_id: string; actor_id: string }>();
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

  await env.DB.batch([
    env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(targetWorkspaceId, id),
    // Edges are denormalized from their source entry's workspace at insert time;
    // moving an entry without its edges would strand them in the old workspace,
    // where scoped graph walks could never find them again.
    env.DB.prepare(`UPDATE edges SET workspace_id = ? WHERE source_id = ?`).bind(targetWorkspaceId, id),
  ]);

  return {
    status: target === "company" ? "shared" : "unshared",
    workspaceId: targetWorkspaceId,
  };
}
