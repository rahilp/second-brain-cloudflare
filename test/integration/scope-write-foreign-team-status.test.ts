/**
 * A write naming a team the caller is not on must answer a clean 400 / tool error,
 * not an opaque 1101. readTeamParam is made switchable so the real scopeWrite throws
 * its real ScopeWriteError inside the real routes and tools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

// Real stateless MCP transport for /mcp (the global setup stubs agents/mcp with a bare "mcp" body).
vi.mock("agents/mcp", async () => {
  const dir = resolve(import.meta.dirname, "../../node_modules/agents/dist");
  const file = readdirSync(dir).find((f) => f.startsWith("handler-stateless-") && f.endsWith(".js"));
  if (!file) throw new Error("agents/dist/handler-stateless-*.js not found");
  const real = await import(/* @vite-ignore */ resolve(dir, file));
  const make = real.createStatelessMcpHandler ?? real.t;
  return { createMcpHandler: (server: unknown, opts?: unknown) => make(() => server, opts) };
});

const mode = vi.hoisted(() => ({ guard: "real" as "real" | "bypass" | "boom" | "limit" }));

vi.mock("../../src/lib/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/scope")>();
  return {
    ...actual,
    readTeamParam: (raw: unknown, identity: Identity, layer?: "personal" | "company") => {
      if (mode.guard === "bypass") return raw === undefined || raw === null ? {} : { teamId: raw as string };
      if (mode.guard === "boom") throw new Error("boom");
      if (mode.guard === "limit") throw new Error("D1_ERROR: Exceeded free tier daily row write limit");
      return actual.readTeamParam(raw, identity, layer);
    },
  };
});

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;
const ADMIN = "test-token";
const TEAM_B = "ws-team-b";
const FOREIGN = "ws-not-mine";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let dana: { userId: string; personalWorkspaceId: string; token: string };
let bob: { userId: string; token: string };

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, Host: "localhost" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const share = (body: unknown) => call("POST", "/share", dana.token, body);

function join(userId: string, workspaceId: string) {
  return sqlite.db.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(userId, workspaceId, Date.now()).run();
}

const wsOf = async (id: string) =>
  ((await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first()) as { workspace_id: string } | null)?.workspace_id;
const count = async (table: string) =>
  ((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as { n: number }).n;

async function withClient<T>(identity: Identity, run: (c: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { return await run(client); } finally { await client.close(); }
}

const callTool = async (name: string, args: Record<string, unknown>) => {
  const identity = (await resolveIdentityFromToken(dana.token, env))!;
  return withClient(identity, (c) => c.callTool({ name, arguments: args })) as Promise<{ isError?: boolean; content: { text: string }[] }>;
};

function expectActionable(text: string) {
  expect(text).toContain("team must be one of your teams");
  expect(text).toContain("list_teams");
  expect(text).toContain("GET /team/workspaces");
}

beforeEach(async () => {
  mode.guard = "real";
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const d = await createMember(env, { name: "Dana" });
  dana = { userId: d.member.userId, personalWorkspaceId: d.member.personalWorkspaceId, token: d.token };
  const b = await createMember(env, { name: "Bob" });
  bob = { userId: b.member.userId, token: b.token };
  await sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`).bind(TEAM_B, Date.now() + 1000).run();
  await join(bob.userId, TEAM_B);
  const now = Date.now() - 3600_000;
  await sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES ('e1', 'a note', '[]', 'test', ?, ?, '[]', ?, ?)`)
    .bind(now, now, dana.personalWorkspaceId, dana.userId)
    .run();
  await sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES ('e-owner', 'owner note', '[]', 'test', ?, ?, '[]', ?, ?)`)
    .bind(now, now, roots.ownerPersonalWorkspaceId, roots.ownerUserId)
    .run();
});

afterEach(() => sqlite?.close());

describe("REST foreign-team writes", () => {
  it("[CP2-T01] POST /share to a foreign team answers 400 JSON", async () => {
    mode.guard = "bypass";
    const res = await share({ id: "e1", workspace: "company", team: FOREIGN });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expectActionable(body.error);
  });

  it("[CP2-T02] a refused foreign-team share changes nothing", async () => {
    mode.guard = "bypass";
    const events = await count("entry_events");
    const res = await share({ id: "e1", workspace: "company", team: FOREIGN });
    expect(res.status).toBe(400);
    expect(await wsOf("e1")).toBe(dana.personalWorkspaceId);
    expect(await count("entry_events")).toBe(events);
  });

  it("[CP2-T03] the live route guard answers the same 400", async () => {
    const res = await share({ id: "e1", workspace: "company", team: FOREIGN });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expectActionable(((await res.json()) as { error: string }).error);
  });

  it("[CP2-T04] a plain Error still rejects out of worker.fetch", async () => {
    mode.guard = "boom";
    await expect(share({ id: "e1", workspace: "company", team: FOREIGN })).rejects.toThrow("boom");
  });

  it("[CP2-T05] the D1 daily-limit 429 path is unchanged", async () => {
    mode.guard = "limit";
    const res = await share({ id: "e1", workspace: "company", team: FOREIGN });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("daily_limit");
  });

  it("[CP2-T09] valid writes still succeed (personal, default team, named own team)", async () => {
    await join(dana.userId, TEAM_B);
    let res = await share({ id: "e1", workspace: "company" });
    expect(res.status).toBe(200);
    expect(await wsOf("e1")).toBe(roots.companyWorkspaceId);
    res = await share({ id: "e1", workspace: "personal" });
    expect(res.status).toBe(200);
    expect(await wsOf("e1")).toBe(dana.personalWorkspaceId);
    res = await share({ id: "e1", workspace: "company", team: TEAM_B });
    expect(res.status).toBe(200);
    expect(await wsOf("e1")).toBe(TEAM_B);
  });

  it("[CP2-T10] one member cannot reach another's team by naming it", async () => {
    mode.guard = "bypass";
    const res = await share({ id: "e1", workspace: "company", team: TEAM_B });
    expect(res.status).toBe(400);
    expectActionable(((await res.json()) as { error: string }).error);
    expect(await wsOf("e1")).toBe(dana.personalWorkspaceId);
  });
});

describe("MCP foreign-team writes", () => {
  it("[CP2-T06] MCP share to a foreign team returns a clean tool error", async () => {
    mode.guard = "bypass";
    const res = await callTool("share", { id: "e1", workspace: "company", team: FOREIGN });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expectActionable(text);
    expect(text).not.toContain("Internal");
    expect(text).not.toContain(" at ");
    expect(await wsOf("e1")).toBe(dana.personalWorkspaceId);
  });

  it("[CP2-T07] MCP remember to a foreign team stores nothing and says why", async () => {
    mode.guard = "bypass";
    await sqlite.db.prepare(`DELETE FROM entries`).run();
    const res = await callTool("remember", { content: "x", workspace: "company", team: FOREIGN });
    expect(res.isError).toBe(true);
    expectActionable(res.content[0].text);
    expect(await count("entries")).toBe(0);
  });

  it("[CP2-T08] real /mcp answers HTTP 200 with isError, not 500", async () => {
    mode.guard = "bypass";
    const res = await call("POST", "/mcp", ADMIN, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "share", arguments: { id: "e-owner", workspace: "company", team: FOREIGN } },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const data = raw.includes("data:") ? raw.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : raw;
    const result = (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expectActionable(result.content[0].text);
    expect(result.content[0].text).not.toContain("daily");
    expect(await wsOf("e-owner")).toBe(roots.ownerPersonalWorkspaceId);
  });
});

describe("MCP foreign-team writes (real mode)", () => {
  // In production readTeamParam runs first on every live write, so the MCP tools return
  // the actionable message as a plain content result (isError falsy), not an SDK-wrapped
  // isError throw. This documents that real shape so the suite matches reality.
  it("[CP2-T11] MCP foreign-team write returns the actionable message in real mode", async () => {
    mode.guard = "real";
    const shareRes = await callTool("share", { id: "e1", workspace: "company", team: FOREIGN });
    expectActionable(shareRes.content[0].text);
    expect(shareRes.content[0].text).not.toContain("Internal");
    expect(shareRes.content[0].text).not.toContain(" at ");
    expect(shareRes.isError).toBeFalsy();
    expect(await wsOf("e1")).toBe(dana.personalWorkspaceId);

    await sqlite.db.prepare(`DELETE FROM entries`).run();
    const rememberRes = await callTool("remember", { content: "x", workspace: "company", team: FOREIGN });
    expectActionable(rememberRes.content[0].text);
    expect(rememberRes.isError).toBeFalsy();
    expect(await count("entries")).toBe(0);
  });
});
