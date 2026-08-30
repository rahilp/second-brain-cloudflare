/**
 * GET /digest must not cross tenant boundaries: manual rollups are scoped to the
 * caller's readable workspaces and must not mark or synthesize from a colleague's
 * private rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

function digestAI(prompts: string[]): Ai {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream) {
        prompts.push(String(opts?.messages?.[0]?.content ?? ""));
        return sse("Bob's digest paragraph.");
      }
      return { response: "3" };
    }),
  } as unknown as Ai;
}

describe("GET /digest tenancy", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let bobToken = "";
  let bobWorkspaceId = "";
  let aliceWorkspaceId = "";
  const prompts: string[] = [];
  const old = Date.now() - 200 * 24 * 3600 * 1000;

  function seed(id: string, workspaceId: string, actorId: string, content: string, tag: string) {
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, ?, 'test', ?, ?, '[]', ?, ?)`,
    ).bind(id, content, JSON.stringify([tag]), old, old, workspaceId, actorId).run();
  }

  beforeEach(async () => {
    resetDatabaseInit();
    prompts.length = 0;
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      AI: digestAI(prompts),
    });
    await initializeDatabase(env);
    const roots = await ensureTenantBootstrap(env);
    const bob = await createMember(env, { name: "Bob" });
    bobToken = bob.token;
    bobWorkspaceId = bob.member.personalWorkspaceId;
    aliceWorkspaceId = roots.ownerPersonalWorkspaceId;

    for (let i = 0; i < 12; i++) {
      seed(`alice-proj-${i}`, aliceWorkspaceId, roots.ownerUserId, `ALICE secret plan ${i}`, "proj");
      seed(`bob-proj-${i}`, bobWorkspaceId, bob.member.userId, `BOB team plan ${i}`, "proj");
    }
  });

  afterEach(() => sqlite.close());

  it("does not synthesize from or roll up a colleague's private workspace", async () => {
    const { results: aliceBefore } = await sqlite.db.prepare(
      `SELECT id, tags, content FROM entries WHERE workspace_id = ?`,
    ).bind(aliceWorkspaceId).all() as { results: { id: string; tags: string; content: string }[] };

    const res = await worker.fetch(
      new Request("http://localhost/digest?tag=proj", {
        headers: { Authorization: `Bearer ${bobToken}` },
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entry_id).toBeTruthy();
    expect(body.synthesis).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("ALICE secret");

    for (const p of prompts) {
      expect(p.includes("ALICE") && p.includes("BOB")).toBe(false);
      if (p.includes("Memories:")) expect(p).not.toContain("ALICE secret");
    }

    const digestRow = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(body.entry_id).first() as { workspace_id: string };
    expect(digestRow.workspace_id).toBe(bobWorkspaceId);

    const { results: aliceAfter } = await sqlite.db.prepare(
      `SELECT id, tags, content FROM entries WHERE workspace_id = ?`,
    ).bind(aliceWorkspaceId).all() as { results: { id: string; tags: string; content: string }[] };
    expect(aliceAfter).toEqual(aliceBefore);
    expect(aliceAfter.every(r => !JSON.parse(r.tags).includes("rolled-up"))).toBe(true);
  });

  it("admin digest stays scoped to readable workspaces, not every member private row", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/digest?tag=proj", {
        headers: { Authorization: `Bearer ${ADMIN}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entry_id).toBeTruthy();
    for (const p of prompts) {
      if (p.includes("Memories:")) expect(p.includes("ALICE") && p.includes("BOB")).toBe(false);
    }
  });
});
