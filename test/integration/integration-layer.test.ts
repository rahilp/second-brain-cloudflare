/**
 * POST /integrations/:provider/layer — change a connected integration's mirror
 * layer without disconnecting. See issue #346.
 *
 * Before this route existed, the only way to move a connection from personal
 * to the team layer (or back) was Disconnect + reconnect with the same token —
 * which meant re-entering a secret purely to flip one field. This exercises the
 * new route's contract end to end: admin-only (same gate as sync/disconnect),
 * 404 for an unconnected provider, everything else in the record surviving a
 * layer change untouched, a same-value call being a true no-op, and the
 * malformed-config narrowing rule (`=== "company" ? "company" : "personal"`)
 * applying identically to the route's own comparison and to the readout, so a
 * hand-edited KV blob cannot end up looking unchanged when it should count as
 * a change, or vice versa.
 *
 * The audit-event assertions for this route (event name, no-op emits no row)
 * live in admin-events-trail.test.ts, where the collecting ctx + settle()
 * already exist — see the trap documented there about the no-op ctx used here.
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

const ctx = { waitUntil: (_: Promise<any>) => {} } as unknown as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let memberToken: string;
let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;

function notionPage(id: string, title: string, lastEdited: string) {
  return {
    object: "page",
    id,
    last_edited_time: lastEdited,
    url: `https://notion.so/${id}`,
    archived: false,
    in_trash: false,
    properties: { title: { type: "title", title: [{ plain_text: title }] } },
  };
}

function paragraph(text: string) {
  return { object: "block", id: `blk-${text}`, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: text }] } };
}

/** Serves Notion's API well enough for connect + a one-page sync. */
function stubNotion(validTokens: string[], pages: any[] = [], blocks: Record<string, any[]> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const auth = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    if (!validTokens.includes(auth)) {
      return new Response(JSON.stringify({ message: "API token is invalid." }), { status: 401 });
    }
    if (url.endsWith("/users/me")) {
      return new Response(JSON.stringify({
        object: "user", type: "bot", name: "Second Brain", bot: { workspace_name: "Acme" },
      }), { status: 200 });
    }
    if (url.endsWith("/search")) {
      return new Response(JSON.stringify({ results: pages, has_more: false, next_cursor: null }), { status: 200 });
    }
    const m = url.match(/\/blocks\/([^/?]+)\/children/);
    if (m) {
      return new Response(JSON.stringify({ results: blocks[m[1]] ?? [], has_more: false, next_cursor: null }), { status: 200 });
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
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const created = await createMember(env, { name: "Dana" });
  memberToken = created.token;
  stubNotion(["admin-notion-token"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite?.close();
});

describe("POST /integrations/notion/layer", () => {
  it("an admin switches a connected integration from personal to company, and nothing else in the record moves", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });
    // Give the record some state a naive whole-object rebuild would drop.
    const seeded = (await loadIntegration(env, "notion"))!;
    seeded.itemMap = { p1: { entryId: "e-1", version: "v1" } as any };
    seeded.lastSyncedAt = 1_700_000_000_000;
    seeded.lastSyncError = "temporary blip";
    // Pinned to the past, not "whatever connect() just stamped" — so the
    // updatedAt-advances assertion below can't pass by same-millisecond luck.
    seeded.updatedAt = 1_700_000_000_000;
    await env.OAUTH_KV.put("integrations:notion", JSON.stringify(seeded));
    const before = (await loadIntegration(env, "notion"))!;

    const res = await call("POST", "/integrations/notion/layer", ADMIN, { workspace: "company" });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, provider: "notion", mirrorWorkspace: "company", changed: true });

    const after = (await loadIntegration(env, "notion"))!;
    expect(after.config.mirrorWorkspace).toBe("company");
    expect(after.itemMap).toEqual(before.itemMap);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt);
    expect(after.lastSyncError).toBe(before.lastSyncError);
    expect(after.workspaceName).toBe(before.workspaceName);
    expect(after.credentials).toEqual(before.credentials);
    // The other half of the no-op test's "updatedAt stays put when nothing
    // changed": a REAL change must stamp updatedAt, or a stale record would
    // silently keep whatever freshness a caller infers from it.
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it("a member cannot change the layer", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    const res = await call("POST", "/integrations/notion/layer", memberToken, { workspace: "company" });
    expect(res.status).toBe(403);
    expect((await loadIntegration(env, "notion"))!.config.mirrorWorkspace).toBe("personal");
  });

  it("404s for a provider that is not connected", async () => {
    const res = await call("POST", "/integrations/notion/layer", ADMIN, { workspace: "company" });
    expect(res.status).toBe(404);
    // Body too, not just the status: the dispatcher's own catch-all for an
    // unmatched path also returns 404, and so does disconnect's not-connected
    // check — this pins the layer branch's own error text, matching sync's
    // and disconnect's "<name> is not connected" shape, so a revert of the
    // dispatch regex or of this branch's own 404 cannot pass unnoticed.
    const data = await res.json() as any;
    expect(data).toEqual({ ok: false, error: "Notion is not connected" });
  });

  it("setting the layer to its current value is a no-op: no save happens", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });
    const before = (await loadIntegration(env, "notion"))!;

    const res = await call("POST", "/integrations/notion/layer", ADMIN, { workspace: "personal" });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data).toMatchObject({ ok: true, provider: "notion", mirrorWorkspace: "personal", changed: false });

    const after = (await loadIntegration(env, "notion"))!;
    expect(after.updatedAt).toBe(before.updatedAt); // no save happened
  });

  it("a malformed stored config.mirrorWorkspace reads as personal and a request for personal is a no-op against it", async () => {
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });
    for (const malformed of ["COMPANY", null, {}]) {
      const record = (await loadIntegration(env, "notion"))!;
      record.config = { ...record.config, mirrorWorkspace: malformed as any };
      await env.OAUTH_KV.put("integrations:notion", JSON.stringify(record));
      const before = (await loadIntegration(env, "notion"))!;

      // The readout narrows a malformed blob to personal...
      const list = await (await call("GET", "/integrations", ADMIN)).json() as any;
      const notion = list.integrations.find((i: any) => i.provider === "notion");
      expect(notion.mirrorWorkspace).toBe("personal");

      // ...and so does the route's own comparison: asking for "personal" against
      // a malformed-but-effectively-personal blob is a no-op, not a save that
      // would otherwise coerce config.mirrorWorkspace to the literal "personal".
      const res = await call("POST", "/integrations/notion/layer", ADMIN, { workspace: "personal" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toMatchObject({ ok: true, provider: "notion", mirrorWorkspace: "personal", changed: false });
      const after = (await loadIntegration(env, "notion"))!;
      expect(after.updatedAt).toBe(before.updatedAt);
    }
  });

  it("narrows a malformed requested value to personal rather than accepting a fourth spelling", async () => {
    // A connect to company first, so "personal" is an actual change and not
    // itself hidden by the no-op path — the assertion that matters is that
    // "COMPANY" (wrong case) does NOT widen to company.
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token", workspace: "company" });

    const res = await call("POST", "/integrations/notion/layer", ADMIN, { workspace: "COMPANY" });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.mirrorWorkspace).toBe("personal");
    expect((await loadIntegration(env, "notion"))!.config.mirrorWorkspace).toBe("personal");
  });

  it("after a change to company, mirrorWriteContext resolves to the company workspace and a mirrored write actually lands there", async () => {
    stubNotion(["admin-notion-token"], [notionPage("p1", "Project Plan", "2026-01-01T00:00:00.000Z")], {
      p1: [paragraph("Ship the beta in March")],
    });
    await call("POST", "/integrations/notion/connect", ADMIN, { token: "admin-notion-token" });

    const layerRes = await call("POST", "/integrations/notion/layer", ADMIN, { workspace: "company" });
    expect(layerRes.status).toBe(200);

    const record = await loadIntegration(env, "notion");
    expect((await mirrorWriteContext(env, record)).workspaceId).toBe(roots.companyWorkspaceId);

    const syncRes = await call("POST", "/integrations/notion/sync", ADMIN, {});
    expect(syncRes.status).toBe(200);
    const syncData = await syncRes.json() as any;
    expect(syncData.created).toBe(1);

    const rows = await sqlite.db.prepare(
      `SELECT workspace_id FROM entries WHERE source = 'notion'`,
    ).all();
    const workspaceIds = (rows.results as { workspace_id: string }[]).map((r) => r.workspace_id);
    expect(workspaceIds).toEqual([roots.companyWorkspaceId]);
  });
});
