/**
 * admin_events is the audit trail for team administration actions — same
 * INSERT-only contract as entry_events (see src/lib/audit.ts). These tests
 * verify the write shape against real SQLite (db/schema.sql applied for
 * real), and that no code anywhere under src/ can UPDATE or DELETE a row
 * once it lands: tamper evidence here is the absence of a way to rewrite it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { adminAuditEvent } from "../../src/lib/admin-audit";
import type { Env } from "../../src/env";

const ROOT = resolve(import.meta.dirname, "../..");

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

async function makeEnv(): Promise<Env> {
  const d1 = makeSqliteD1();
  const env = makeTestEnv(d1.db as unknown as D1Mock) as unknown as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  return env;
}

type AdminEventRow = {
  id: string;
  actor_id: string;
  target_user_id: string;
  workspace_id: string;
  event: string;
  payload: string;
  created_at: number;
};

describe("adminAuditEvent", () => {
  it("inserts exactly one row with every field set, payload round-tripping through JSON", async () => {
    const env = await makeEnv();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

    adminAuditEvent(env, ctx, {
      actorId: "usr-admin",
      targetUserId: "usr-target",
      workspaceId: "ws-1",
      event: "member_suspended",
      payload: { reason: "policy violation" },
    });
    await Promise.all(pending);

    const { results } = (await env.DB.prepare(`SELECT * FROM admin_events`).all()) as {
      results: AdminEventRow[];
    };
    expect(results).toHaveLength(1);
    const row = results[0];
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
    expect(row.actor_id).toBe("usr-admin");
    expect(row.target_user_id).toBe("usr-target");
    expect(row.workspace_id).toBe("ws-1");
    expect(row.event).toBe("member_suspended");
    expect(JSON.parse(row.payload)).toEqual({ reason: "policy violation" });
    expect(typeof row.created_at).toBe("number");
  });

  it("stores omitted targetUserId and workspaceId as empty strings, not NULL", async () => {
    const env = await makeEnv();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

    adminAuditEvent(env, ctx, {
      actorId: "usr-admin",
      event: "team_renamed",
    });
    await Promise.all(pending);

    const row = await env.DB.prepare(
      `SELECT target_user_id, workspace_id, payload FROM admin_events`,
    ).first<{ target_user_id: string | null; workspace_id: string | null; payload: string }>();
    expect(row?.target_user_id).toBe("");
    expect(row?.workspace_id).toBe("");
    expect(row?.target_user_id).not.toBeNull();
    expect(row?.workspace_id).not.toBeNull();
    expect(JSON.parse(row!.payload)).toEqual({});
  });

  it("does not reject the returned waitUntil promise when env.DB rejects", async () => {
    const rejectingDb = {
      prepare: () => ({
        bind: () => ({
          run: () => Promise.reject(new Error("D1 unavailable")),
        }),
      }),
    } as unknown as D1Database;
    const env = { ...(await makeEnv()), DB: rejectingDb };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

    adminAuditEvent(env, ctx, { actorId: "usr-admin", event: "member_removed" });

    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  it("has no UPDATE or DELETE path against admin_events anywhere in src/", () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(resolve(ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      if (/UPDATE\s+admin_events/i.test(source) || /DELETE\s+FROM\s+admin_events/i.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
