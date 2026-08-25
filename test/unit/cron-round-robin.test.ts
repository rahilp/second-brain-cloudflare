/**
 * The nightly maintenance rotation (src/runtime/rotation.ts): one workspace slice per
 * night behind the maintenance_cursor round-robin, so free-plan invocations stay inside
 * their ~50-query budget as workspaces grow. These tests run against real SQLite via
 * test/helpers/sqlite-d1.ts because the subject IS the SQL — cursor ordering, the wrap,
 * and which rows a sliced candidate query returns cannot be evaluated by a string-matching
 * double.
 */
import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { nextWorkspace } from "../../src/runtime/rotation";
import { runStalenessPass, STALENESS_AGE_MS } from "../../src/staleness/pass";

async function makeEnv() {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: "owner-token" } as Env;
  const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
  // The init memo is module-scoped; each fresh database needs the seam reset first.
  resetDatabaseInit();
  await initializeDatabase(env);
  return { d1, env, ctx };
}

/** Insert an entry directly into a workspace (bypassing capture's tenancy plumbing). */
async function seedEntry(env: Env, id: string, workspaceId: string, createdAt?: number) {
  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, workspace_id) VALUES (?, ?, '[]', 'api', ?, ?)`,
  ).bind(id, `Memory ${id}`, createdAt ?? Date.now() - 2 * STALENESS_AGE_MS, workspaceId).run();
}

async function cursorRow(env: Env) {
  return (await env.DB.prepare(
    `SELECT workspace_id, advanced_at FROM maintenance_cursor WHERE id = 1`,
  ).first<{ workspace_id: string; advanced_at: number }>())!;
}

describe("nextWorkspace", () => {
  it("advances through workspaces in order and wraps, with '' in the ring", async () => {
    const { env } = await makeEnv();
    // Lexicographic ring: '' < 'ws-a' < 'ws-b'. The seeded cursor is '', so '' itself
    // gets its turn at the wrap-around, like any other value.
    await seedEntry(env, "legacy-1", "");
    await seedEntry(env, "a-1", "ws-a");
    await seedEntry(env, "b-1", "ws-b");

    expect(await nextWorkspace(env)).toBe("ws-a");
    expect(await nextWorkspace(env)).toBe("ws-b");
    expect(await nextWorkspace(env)).toBe("");
    expect(await nextWorkspace(env)).toBe("ws-a"); // wrapped back to the first
  });

  it("keeps advancing past a cursor pointing at a workspace whose entries are gone", async () => {
    const { env } = await makeEnv();
    await seedEntry(env, "legacy-1", "");
    await seedEntry(env, "a-1", "ws-a");
    expect(await nextWorkspace(env)).toBe("ws-a");
    await env.DB.prepare(`DELETE FROM entries WHERE workspace_id = 'ws-a'`).run();

    // ws-a no longer has rows, but it is still the stored position: nothing sorts after
    // it any more, so the ring wraps straight past the gap to what remains.
    expect(await nextWorkspace(env)).toBe("");
  });

  it("yields null on an empty corpus without crashing or touching the cursor", async () => {
    const { env } = await makeEnv();
    expect(await nextWorkspace(env)).toBeNull();
    expect(await nextWorkspace(env)).toBeNull();
    const row = await cursorRow(env);
    expect(row.workspace_id).toBe("");
    expect(row.advanced_at).toBe(0);
  });

  it("updates the cursor row: workspace_id moves and advanced_at is stamped", async () => {
    const { env } = await makeEnv();
    await seedEntry(env, "a-1", "ws-a");

    const before = await cursorRow(env);
    expect(before.workspace_id).toBe("");
    expect(before.advanced_at).toBe(0);

    const beforeMs = Date.now();
    expect(await nextWorkspace(env)).toBe("ws-a");

    const after = await cursorRow(env);
    expect(after.workspace_id).toBe("ws-a");
    expect(after.advanced_at).toBeGreaterThanOrEqual(beforeMs);
  });
});

describe("sliced nightly passes", () => {
  it("a sliced staleness pass processes exactly its workspace's rows; unsliced sees everything", async () => {
    const { env, ctx } = await makeEnv();
    const old = Date.now() - 2 * STALENESS_AGE_MS;
    await seedEntry(env, "legacy-1", "", old);
    await seedEntry(env, "x-1", "ws-x", old);
    await seedEntry(env, "y-1", "ws-y", old);

    const checked = async (id: string) =>
      (await env.DB.prepare(`SELECT staleness_checked_at FROM entries WHERE id = ?`).bind(id)
        .first<{ staleness_checked_at: number | null }>())?.staleness_checked_at ?? null;

    // Sliced to ws-x: exactly that workspace's row is inspected.
    await runStalenessPass(env, ctx, "ws-x");
    expect(await checked("x-1")).not.toBeNull();
    expect(await checked("legacy-1")).toBeNull();
    expect(await checked("y-1")).toBeNull();

    // Unsliced (the direct/manual-caller path): the remaining rows are reached.
    await runStalenessPass(env, ctx);
    expect(await checked("legacy-1")).not.toBeNull();
    expect(await checked("y-1")).not.toBeNull();
  });

  it("the unsliced candidate SQL carries no workspace clause; the sliced one appends it", async () => {
    const { d1, env, ctx } = await makeEnv();
    await seedEntry(env, "legacy-1", "");

    d1.issued.length = 0;
    await runStalenessPass(env, ctx);
    const unslicedCandidate = d1.issued.find(s => s.includes("ORDER BY COALESCE(staleness_checked_at"));
    expect(unslicedCandidate).toBeTruthy();
    expect(unslicedCandidate!.includes("workspace_id = ?")).toBe(false);

    d1.issued.length = 0;
    await runStalenessPass(env, ctx, "ws-x");
    const slicedCandidate = d1.issued.find(s => s.includes("ORDER BY COALESCE(staleness_checked_at"));
    // The slice is purely additive: identical text up to the appended clause.
    expect(slicedCandidate!.startsWith(unslicedCandidate!.slice(0, unslicedCandidate!.indexOf("ORDER BY")))).toBe(true);
    expect(slicedCandidate!.includes("AND workspace_id = ?")).toBe(true);
  });
});
