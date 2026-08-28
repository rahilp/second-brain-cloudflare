import type { Env } from "../env";

/**
 * Immutable audit trail writes for team administration actions. admin_events is
 * INSERT-only by design, same contract as entry_events (see src/lib/audit.ts) —
 * there is no update or delete path anywhere in src/, so tamper evidence is the
 * absence of a way to rewrite it.
 *
 * Fire-and-forget by contract: callers hand this to ctx.waitUntil (or call it
 * inside one) so an audit write never blocks or fails an administration action.
 * A lost audit row is acceptable; a failed administration action is not.
 */
export type AdminEventName =
  | "member_created"
  | "member_removed"
  | "member_suspended"
  | "member_unsuspended"
  | "member_token_rotated"
  | "member_default_share_set"
  | "member_profile_updated"
  | "team_renamed";

export function adminAuditEvent(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  event: {
    actorId: string;
    targetUserId?: string;
    workspaceId?: string;
    event: AdminEventName;
    payload?: Record<string, unknown>;
  },
): void {
  const { actorId, targetUserId, workspaceId, event: name, payload } = event;
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO admin_events (id, actor_id, target_user_id, workspace_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        actorId,
        targetUserId ?? "",
        workspaceId ?? "",
        name,
        JSON.stringify(payload ?? {}),
        Date.now(),
      )
      .run()
      .catch((e: unknown) => console.error("admin_events insert failed (non-fatal):", e)),
  );
}
