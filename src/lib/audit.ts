import type { Env } from "../env";

/**
 * Immutable audit trail writes. entry_events is INSERT-only by design — there is
 * no update or delete path anywhere in src/, so tamper evidence is the absence
 * of a way to rewrite it.
 *
 * Fire-and-forget by contract: callers hand this to ctx.waitUntil (or call it
 * inside one) so an audit write never blocks or fails a user-visible operation.
 * A lost audit row is acceptable; a lost memory is not.
 */
export type EntryEventName =
  | "created"
  | "updated"
  | "appended"
  | "deleted"
  | "status_changed"
  | "shared"
  | "unshared";

export function auditEvent(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  event: {
    entryId: string;
    actorId: string;
    event: EntryEventName;
    payload?: Record<string, unknown>;
  },
): void {
  const { entryId, actorId, event: name, payload } = event;
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), entryId, actorId, name, JSON.stringify(payload ?? {}), Date.now())
      .run()
      .catch((e: unknown) => console.error("entry_events insert failed (non-fatal):", e)),
  );
}
