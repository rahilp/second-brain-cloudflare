/**
 * POST /team/members/remove must not report failure for work that succeeded.
 *
 * The D1 rows (member tombstone, personal workspace, entries, edges,
 * memberships) and the admin_events audit row are committed BEFORE the route
 * drops the removed entries' vectors from Vectorize. A Vectorize failure used to
 * escape the route as a raw 500 — the caller read the removal as failed and
 * the dashboard showed an error for an operation that actually happened. The
 * degradation is the one /patterns/resolve already accepts: dead vectors linger
 * in the index, every D1-backed read still answers correctly, and the audit
 * trail keeps the counts either way.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const OWNER = "test-token"; // the bootstrap admin, per makeTestEnv's AUTH_TOKEN

let sqlite: SqliteD1;
let env: Env;
let pending: Promise<unknown>[] = [];

const ctx = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
} as unknown as ExecutionContext;

/** Every waitUntil promise the request handed back, settled. */
async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

beforeEach(async () => {
  pending = [];
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});

afterEach(() => sqlite?.close());

function removeRequest(id: string): Promise<Response> {
  return worker.fetch(new Request(`${BASE}/team/members/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
    body: JSON.stringify({ id }),
  }), env, ctx);
}

describe("POST /team/members/remove with a failing Vectorize index", () => {
  it("answers ok and keeps the audit row when the vector delete fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { member } = await createMember(env, { name: "Ada" });
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
       VALUES ('p1', 'private', '[]', 'api', 1, '["v-p1"]', ?, ?)`,
    ).bind(member.personalWorkspaceId, member.userId).run();

    const failing = makeVectorizeMock({
      deleteByIds: vi.fn().mockRejectedValue(new Error("vectorize down")),
    });
    env.VECTORIZE = failing;

    const res = await removeRequest(member.userId);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; removedEntries: number; removedVectors: number };
    expect(body).toMatchObject({ ok: true, removedEntries: 1, removedVectors: 1 });
    // The failure was reported, not swallowed silently.
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("non-fatal"), expect.any(Error));
    consoleSpy.mockRestore();
    await settle();

    // The removal itself happened; only the index cleanup degraded.
    expect(await sqlite.db.prepare(`SELECT id FROM entries WHERE id = 'p1'`).first()).toBeNull();
    expect(await sqlite.db.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(member.personalWorkspaceId).first()).toBeNull();
    // The audit row was written before the failing delete and survives it.
    const audit = (await sqlite.db.prepare(
      `SELECT payload FROM admin_events WHERE event = 'member_removed' AND target_user_id = ?`,
    ).bind(member.userId).first()) as { payload: string } | null;
    expect(audit?.payload).toContain('"removedEntries":1');
  });

  it("still deletes the vectors when the index is healthy", async () => {
    const { member } = await createMember(env, { name: "Ada" });
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
       VALUES ('p2', 'private', '[]', 'api', 1, '["v-p2"]', ?, ?)`,
    ).bind(member.personalWorkspaceId, member.userId).run();

    const res = await removeRequest(member.userId);
    expect(res.status).toBe(200);
    await settle();

    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(["v-p2"]);
  });
});
