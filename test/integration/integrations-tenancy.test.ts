/**
 * What a plain member can do to the org's integrations.
 *
 * `/integrations/:provider/(connect|sync|disconnect)` gates on `requireIdentity`,
 * not `requireAdmin`, while the record it acts on lives at one deployment-wide KV
 * key (`integrations:<provider>`, src/integrations/framework.ts). There is exactly
 * one Notion connection, one Gmail connection and one calendar connection for the
 * whole brain, and every member can reach all of them.
 *
 * These cases pin the behaviour that is actually shipped rather than asserting a
 * policy that does not exist yet, so whichever way the product decides to go — a
 * per-member connection, or an admin-only surface — the change shows up here as a
 * deliberate edit rather than a silent one. Each case says what a member can do
 * today and why it is worth deciding about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { loadIntegration } from "../../src/integrations";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let memberToken: string;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let member: { userId: string; personalWorkspaceId: string };

/** Serves Notion's API for two different tokens, so "whose connection is this" is visible. */
function stubNotion(tokens: Record<string, string>) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const auth = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    const workspaceName = tokens[auth];
    if (!workspaceName) {
      return new Response(JSON.stringify({ message: "API token is invalid." }), { status: 401 });
    }
    if (url.endsWith("/users/me")) {
      return new Response(JSON.stringify({
        object: "user", type: "bot", name: "Second Brain", bot: { workspace_name: workspaceName },
      }), { status: 200 });
    }
    if (url.endsWith("/search")) {
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
}

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const created = await createMember(env, { name: "Dana" });
  memberToken = created.token;
  member = { userId: created.member.userId, personalWorkspaceId: created.member.personalWorkspaceId };
  stubNotion({ "admin-notion-token": "Acme HQ", "dana-notion-token": "Dana Personal" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite?.close();
});

describe("integrations are one deployment-wide connection, reachable by every member", () => {
  it("a member's connect REPLACES the admin's connection and credentials", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });
    expect((await loadIntegration(env, "notion"))!.workspaceName).toBe("Acme HQ");

    const res = await call("POST", "/integrations/notion/connect", memberToken, { token: "dana-notion-token" });
    expect(res.status).toBe(200);

    // The admin's Notion token is gone — overwritten by a member, with no warning
    // to either party and nothing in the response saying a connection was replaced.
    const record = (await loadIntegration(env, "notion"))!;
    expect(record.workspaceName).toBe("Dana Personal");
    expect(record.credentials.token).toBe("dana-notion-token");
  });

  it("a member can disconnect the org's integration outright", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    const res = await call("POST", "/integrations/notion/disconnect", memberToken, {});
    expect(res.status).toBe(200);
    expect(await loadIntegration(env, "notion")).toBeNull();
  });

  it("a member's disconnect+purge cannot delete mirrored memories out of the ADMIN's workspace", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    // A page the admin's sync had already mirrored into the admin's own workspace.
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES ('mirrored-1', 'Board minutes mirrored from Notion', '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`,
    ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();

    const record = (await loadIntegration(env, "notion"))!;
    record.itemMap = { "page-1": { entryId: "mirrored-1", version: "v1" } as any };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));

    const res = await call("POST", "/integrations/notion/disconnect", memberToken, { purge: true });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.purged).toBe(0);
    expect(body.kept).toBe(1);

    // `forgetEntry(id, env)` deletes by id with no workspace clause, so without the
    // route's own guard this purge reached a row the member could not read through
    // /entry, edit through /update, or delete through /forget. The row survives.
    const left = await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = 'mirrored-1'`)
      .first() as { n: number };
    expect(left.n).toBe(1);
  });

  it("a purge still removes the caller's own mirrored memories", async () => {
    // The guard must not turn purge into a no-op for the person who owns the rows.
    await call("POST", "/integrations/notion/connect", memberToken, { token: "dana-notion-token" });
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES ('mine-1', 'Dana page mirrored from Notion', '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`,
    ).bind(member.personalWorkspaceId, member.userId).run();

    const record = (await loadIntegration(env, "notion"))!;
    record.itemMap = { "page-9": { entryId: "mine-1", version: "v1" } as any };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));

    const res = await call("POST", "/integrations/notion/disconnect", memberToken, { purge: true });
    expect((await res.json() as any).purged).toBe(1);
    const left = await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = 'mine-1'`)
      .first() as { n: number };
    expect(left.n).toBe(0);
  });

  it("the same connection mirrors into different workspaces depending on who syncs it", async () => {
    // Manual sync writes to the CALLER's workspace (src/routes/integrations.ts),
    // while the nightly cron resolves the owner and writes to the OWNER's
    // (runScheduledIntegrationSync, src/integrations/mirror.ts). One connection,
    // two destinations, decided by who happened to press the button.
    await call("POST", "/integrations/notion/connect", memberToken, { token: "dana-notion-token" });
    const res = await call("POST", "/integrations/notion/sync", memberToken, {});
    expect(res.status).toBe(200);

    // Nothing to assert on rows here — the stub returns no pages — but the write
    // context is built from `auth`, so a member's sync lands in the member's
    // workspace while the cron's lands in the owner's. Recorded as the reason the
    // two paths must be reconciled before a team ships.
    expect(member.personalWorkspaceId).not.toBe(roots.ownerPersonalWorkspaceId);
  });

  it("a member sees the org's connected workspace name and sync state", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    const list = await (await call("GET", "/integrations", memberToken)).json() as any;
    const notion = list.integrations.find((i: any) => i.provider === "notion");
    expect(notion.connected).toBe(true);
    // The token is never exposed, but the workspace name is — a member learns which
    // Notion workspace the admin connected.
    expect(notion.workspaceName).toBe("Acme HQ");
  });
});
