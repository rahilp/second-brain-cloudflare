/**
 * POST /import must stamp the caller's own workspace/actor onto every row it
 * writes, not the pre-team OWNER_WRITE_CONTEXT ('', ''). A member restoring
 * their own backup previously got rows that only an admin could see
 * (readableWorkspaces gives a member their personal and company workspaces,
 * never '') — a live data-loss bug, not a cosmetic gap.
 *
 * Driven through worker.fetch against real SQLite, using the same two-member
 * harness as team-isolation.test.ts, because the subject is what a member can
 * see afterwards, not just what landed in the SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";

const ALICE = "test-token"; // the owner/admin, per makeTestEnv's AUTH_TOKEN
let bobToken = "";
let bobPersonalWorkspaceId = "";
let bobUserId = "";

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const jsonOf = async (res: Response) => res.json() as Promise<any>;

let sqlite: SqliteD1;
let env: Env;

const PAYLOAD = {
  version: 2,
  entries: [
    { id: "imp-a", content: "Bob's imported memory A", created_at: 1_700_000_000_000 },
    { id: "imp-b", content: "Bob's imported memory B", created_at: 1_700_000_001_000 },
  ],
  edges: [{ source_id: "imp-a", target_id: "imp-b", type: "relates_to" }],
};

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);

  await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;
  bobPersonalWorkspaceId = bob.member.personalWorkspaceId;
  bobUserId = bob.member.userId;
});

afterEach(() => sqlite?.close());

describe("POST /import stamps the caller's WriteContext", () => {
  it("stamps Bob's personal workspace/actor on imported entries and the edge, and makes them visible to Bob only", async () => {
    const res = await call("POST", "/import", bobToken, PAYLOAD);
    expect(res.status).toBe(200);
    const summary = await jsonOf(res);
    expect(summary.imported).toBe(2);
    expect(summary.edges_imported).toBe(1);

    const { results: entryRows } = await sqlite.db
      .prepare(`SELECT id, workspace_id, actor_id FROM entries WHERE id IN ('imp-a', 'imp-b')`)
      .all() as { results: { id: string; workspace_id: string; actor_id: string }[] };
    expect(entryRows).toHaveLength(2);
    for (const row of entryRows) {
      expect(row.workspace_id).toBe(bobPersonalWorkspaceId);
      expect(row.actor_id).toBe(bobUserId);
    }

    const edgeRow = await sqlite.db
      .prepare(`SELECT workspace_id FROM edges WHERE source_id = 'imp-a' AND target_id = 'imp-b'`)
      .first() as { workspace_id: string } | null;
    expect(edgeRow?.workspace_id).toBe(bobPersonalWorkspaceId);

    // Visible to Bob immediately — this is the assertion that fails before the fix,
    // because the rows were previously stamped '' and readableWorkspaces never
    // includes '' for a member.
    const bobList = await jsonOf(await call("GET", "/list?n=50", bobToken));
    const bobContents = bobList.map((e: any) => e.content as string);
    expect(bobContents).toEqual(expect.arrayContaining([
      "Bob's imported memory A",
      "Bob's imported memory B",
    ]));

    // Not visible to Alice, the admin — an import is not a share.
    const aliceList = await jsonOf(await call("GET", "/list?n=50", ALICE));
    const aliceContents = aliceList.map((e: any) => e.content as string);
    expect(aliceContents).not.toEqual(expect.arrayContaining([
      "Bob's imported memory A",
    ]));
  });

  it("stamps both pages of a paged import identically", async () => {
    const page1 = await call("POST", "/import?limit=1&offset=0", bobToken, PAYLOAD);
    const summary1 = await jsonOf(page1);
    expect(summary1.imported).toBe(1);
    expect(summary1.next_offset).toBe(1);

    const page2 = await call("POST", `/import?limit=1&offset=${summary1.next_offset}`, bobToken, PAYLOAD);
    const summary2 = await jsonOf(page2);
    expect(summary2.imported).toBe(1);

    const { results: entryRows } = await sqlite.db
      .prepare(`SELECT id, workspace_id, actor_id FROM entries WHERE id IN ('imp-a', 'imp-b')`)
      .all() as { results: { id: string; workspace_id: string; actor_id: string }[] };
    expect(entryRows).toHaveLength(2);
    for (const row of entryRows) {
      expect(row.workspace_id).toBe(bobPersonalWorkspaceId);
      expect(row.actor_id).toBe(bobUserId);
    }
  });
});
