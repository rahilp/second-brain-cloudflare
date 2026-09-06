/**
 * Who may change the org's integrations, and where what they mirror lands.
 *
 * An integration is ONE connection per provider for the whole deployment
 * (`integrations:<provider>`, a single KV blob — src/integrations/framework.ts).
 * That single-connection model is what decides the access rules here, and these
 * cases exist because it briefly had none: connect/sync/disconnect gated on
 * requireIdentity, so any member could replace the admin's Notion token, remove
 * the connection for everyone, purge mirrored memories out of a colleague's
 * private workspace, and — because the manual sync built its write context from
 * the caller while the nightly cron built one from the owner — split a single
 * connection's output across two people's private space.
 *
 * If per-member connections ever land, the gate and the storage key both change,
 * and these are the cases that should change with them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { loadIntegration } from "../../src/integrations";
import { mirrorWriteContext } from "../../src/integrations/mirror";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let memberToken: string;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let member: { userId: string; personalWorkspaceId: string };

/** Serves Notion's API for two tokens, so "whose connection is this" is visible. */
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

describe("one connection per provider, administered by an admin", () => {
  it("a member cannot connect — which would replace the org's token, not add their own", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    const res = await call("POST", "/integrations/notion/connect", memberToken, { token: "dana-notion-token" });
    expect(res.status).toBe(403);

    // The admin's connection is untouched, credentials included.
    const record = (await loadIntegration(env, "notion"))!;
    expect(record.workspaceName).toBe("Acme HQ");
    expect(record.credentials.token).toBe("admin-notion-token");
  });

  it("a member cannot disconnect or sync the org's integration", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    expect((await call("POST", "/integrations/notion/sync", memberToken, {})).status).toBe(403);
    expect((await call("POST", "/integrations/notion/disconnect", memberToken, {})).status).toBe(403);
    expect(await loadIntegration(env, "notion")).not.toBeNull();
  });

  it("a member can still SEE what is connected", async () => {
    // Read stays open: the Integrations screen tells a member what the brain is
    // mirroring and when it last ran. The token is never in this payload.
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    const list = await (await call("GET", "/integrations", memberToken)).json() as any;
    const notion = list.integrations.find((i: any) => i.provider === "notion");
    expect(notion.connected).toBe(true);
    expect(notion.workspaceName).toBe("Acme HQ");
    expect(JSON.stringify(list)).not.toContain("admin-notion-token");
  });

  it("an admin's purge removes only rows they could have deleted one at a time", async () => {
    // forgetEntry deletes by id with no workspace clause, so the route applies
    // /forget's own guard per row. A member's mirrored memory is not the admin's
    // to purge even though the connection is.
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES ('admin-page', 'Board minutes mirrored from Notion', '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`,
    ).bind(roots.ownerPersonalWorkspaceId, roots.ownerUserId).run();
    await sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES ('dana-page', 'Dana page mirrored from Notion', '["notion"]', 'notion', 1000, 1000, '[]', ?, ?)`,
    ).bind(member.personalWorkspaceId, member.userId).run();

    const record = (await loadIntegration(env, "notion"))!;
    record.itemMap = {
      a: { entryId: "admin-page", version: "v1" } as any,
      d: { entryId: "dana-page", version: "v1" } as any,
    };
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));

    const body = await (await call("POST", "/integrations/notion/disconnect", ADMIN, { purge: true })).json() as any;
    expect(body.purged).toBe(1);
    expect(body.kept).toBe(1);

    const rows = await sqlite.db.prepare(`SELECT id FROM entries WHERE source = 'notion'`).all();
    expect((rows.results as { id: string }[]).map(r => r.id)).toEqual(["dana-page"]);
  });
});

describe("both sync paths mirror into the same place", () => {
  it("mirrorWriteContext resolves the owner, not the caller", async () => {
    // The manual sync and the nightly cron now call this one function, so a page
    // synced by hand and the same page synced overnight land in one workspace.
    // Built from `auth` before, which split one connection's output in two.
    const personal = await mirrorWriteContext(env, { config: { mirrorWorkspace: "personal" } });
    expect(personal).toEqual({
      workspaceId: roots.ownerPersonalWorkspaceId,
      actorId: roots.ownerUserId,
    });
    expect(personal.workspaceId).not.toBe(member.personalWorkspaceId);

    const company = await mirrorWriteContext(env, { config: { mirrorWorkspace: "company" } });
    expect(company.workspaceId).toBe(roots.companyWorkspaceId);

    // No record, or a record with no preference, is the private default.
    expect((await mirrorWriteContext(env, null)).workspaceId).toBe(roots.ownerPersonalWorkspaceId);
  });

  it("a connect with workspace:company sends the mirror to the shared layer", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, {
      token: "admin-notion-token",
      workspace: "company",
    });
    const record = await loadIntegration(env, "notion");
    expect(record!.config?.mirrorWorkspace).toBe("company");
    expect((await mirrorWriteContext(env, record)).workspaceId).toBe(roots.companyWorkspaceId);
  });
});
