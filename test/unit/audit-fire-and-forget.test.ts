/**
 * The fire-and-forget contract, asserted the SAME WAY for both spellings.
 *
 * src/lib/audit.ts publishes one operation under two names: `auditEvent` for a
 * caller with one row and `auditEvents` for a caller with many. The contract is
 * identical and absolute — "a lost audit row is acceptable; a lost memory is
 * not" — so a guarantee that holds for one and not the other is not a smaller
 * guarantee, it is two different functions wearing one name.
 *
 * `auditEvents` gained a try/catch around its ctx.waitUntil argument because
 * `.catch` only covers a REJECTED promise: prepare, bind and batch all run
 * while the argument is being evaluated, so a synchronous throw from any of
 * them escapes into the caller. The singular form ran exactly the same
 * expressions with no guard. Both cases are driven from one table below, so the
 * next form added to this file is answerable to the same two assertions.
 */
import { describe, it, expect, vi } from "vitest";
import { auditEvent, auditEvents, type AuditEventInput } from "../../src/lib/audit";
import type { Env } from "../../src/env";

const ROW: AuditEventInput = { entryId: "e-1", actorId: "usr-1", event: "shared" };

/** A D1 whose `prepare` blows up before anything can be awaited. */
function envThatThrowsSynchronously(): Env {
  return {
    DB: {
      prepare() { throw new Error("entry_events is gone"); },
      batch() { throw new Error("entry_events is gone"); },
    },
  } as unknown as Env;
}

/** A D1 whose write rejects, the case `.catch` already covered. */
function envThatRejects(): Env {
  const stmt = { bind: () => ({ run: () => Promise.reject(new Error("on fire")) }) };
  return {
    DB: {
      prepare: () => stmt,
      batch: () => Promise.reject(new Error("on fire")),
    },
  } as unknown as Env;
}

const FORMS: [string, (env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => void][] = [
  ["auditEvent (singular)", (env, ctx) => auditEvent(env, ctx, ROW)],
  ["auditEvents (batched)", (env, ctx) => auditEvents(env, ctx, [ROW])],
];

describe.each(FORMS)("%s", (_name, write) => {
  it("does not throw when the audit write throws SYNCHRONOUSLY", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };

    // The whole contract in one line: the caller's operation is already
    // committed by the time this runs, so this must never be the thing that
    // fails it.
    expect(() => write(envThatThrowsSynchronously(), ctx)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("settles rather than rejecting when the audit write REJECTS", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };

    write(envThatRejects(), ctx);
    // Nothing handed to waitUntil may reject: an unhandled rejection in a
    // Worker is a different failure mode from a lost row.
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
