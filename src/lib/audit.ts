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
  | "unshared"
  | "insight_confirmed"
  | "insight_dismissed";

export interface AuditEventInput {
  entryId: string;
  actorId: string;
  event: EntryEventName;
  payload?: Record<string, unknown>;
}

/**
 * The one INSERT, prepared and bound but not run.
 *
 * `auditEvent` below is the ordinary way in and hands this to ctx.waitUntil. A
 * caller ruling on MANY entries in one request collects these instead and hands
 * ONE env.DB.batch to ctx.waitUntil — same statement, same table, same
 * never-blocks contract, one subrequest rather than N. POST /patterns/resolve
 * is that caller: it exists because a per-id loop puts a ceiling on the batch
 * size (a free-plan invocation gets roughly 50 D1 queries), and its cost is
 * pinned flat in the number of ids in test/integration/patterns.test.ts. A
 * per-id audit write would have reintroduced exactly the ceiling the route was
 * built to remove.
 *
 * This is a seam in the existing mechanism, not a second one: there is still
 * one place that knows the entry_events INSERT and one EntryEventName union.
 */
export function auditEventStatement(env: Env, event: AuditEventInput): D1PreparedStatement {
  const { entryId, actorId, event: name, payload } = event;
  return env.DB.prepare(
    `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), entryId, actorId, name, JSON.stringify(payload ?? {}), Date.now());
}

export function auditEvent(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  event: AuditEventInput,
): void {
  ctx.waitUntil(
    auditEventStatement(env, event)
      .run()
      .catch((e: unknown) => console.error("entry_events insert failed (non-fatal):", e)),
  );
}

/**
 * The batched form. Callers that already build a statement list use this so the
 * whole trail for one request costs one subrequest; it keeps the same
 * fire-and-forget contract, so a failed trail can never fail the operation it
 * describes.
 */
export function auditEvents(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  events: AuditEventInput[],
): void {
  if (!events.length) return;
  // The try is not redundant with the catch. `.catch` only covers a REJECTED
  // promise; prepare, bind and batch are called during the argument expression
  // and a synchronous throw from any of them would escape into the caller —
  // which for POST /patterns/resolve means failing a resolution that has
  // already been committed to D1, the exact thing fire-and-forget exists to
  // make impossible.
  try {
    ctx.waitUntil(
      env.DB.batch(events.map((e) => auditEventStatement(env, e)))
        .catch((e: unknown) => console.error("entry_events batch insert failed (non-fatal):", e)),
    );
  } catch (e: unknown) {
    console.error("entry_events batch insert failed (non-fatal):", e);
  }
}
