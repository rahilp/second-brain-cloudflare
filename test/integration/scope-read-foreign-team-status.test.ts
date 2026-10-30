/**
 * A read naming a team the caller is not on must answer a clean 400 / tool error,
 * never that team's rows. readTeamParam is made switchable so the real read helpers
 * throw their real ScopeReadError inside the real routes and tools.
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
const OWN_TEAM = "ws-dana-team";

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

function join(userId: string, workspaceId: string) {
  return sqlite.db.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(userId, workspaceId, Date.now()).run();
}

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

const SECRET = "SECRET-foreign-row";
const SECRET_B = "SECRET-teamb-row";

function seed(id: string, workspaceId: string, actorId: string, content: string, tags: string[] = []) {
  const now = Date.now() - 3600_000;
  return sqlite.db
    .prepare(`INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, 'test', ?, ?, '[]', ?, ?)`)
    .bind(id, content, JSON.stringify(tags), now, now, workspaceId, actorId)
    .run();
}

async function workspace(id: string, name: string) {
  await sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', ?, ?)`).bind(id, name, Date.now() + 1000).run();
}

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

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
  await workspace(TEAM_B, "Platform");
  await workspace(FOREIGN, "Elsewhere");
  await workspace(OWN_TEAM, "Danas");
  await join(bob.userId, TEAM_B);
  await join(dana.userId, OWN_TEAM);
  await seed("dana-note", dana.personalWorkspaceId, dana.userId, "dana-note personal", ["standing:active"]);
  await seed("own-team-row", OWN_TEAM, dana.userId, "own-team-row shared");
  await seed("e-foreign", FOREIGN, bob.userId, `${SECRET} here`);
  await seed("e-teamb", TEAM_B, bob.userId, `${SECRET_B} here`, ["standing:active"]);
  await seed("e-owner", roots.ownerPersonalWorkspaceId, roots.ownerUserId, `${SECRET} owner`);
});

afterEach(() => sqlite?.close());

const get = (path: string) => call("GET", path, dana.token);

async function expectRest400(res: Response, ...forbidden: string[]) {
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("application/json");
  const raw = await res.text();
  const body = JSON.parse(raw) as { ok: boolean; error: string };
  expect(body.ok).toBe(false);
  expectActionable(body.error);
  for (const f of forbidden) expect(raw).not.toContain(f);
}

function expectCleanToolError(r: { isError?: boolean; content: { text: string }[] }, ...forbidden: string[]) {
  expect(r.isError).toBe(true);
  const t = text(r);
  expectActionable(t);
  expect(t).not.toContain("Internal");
  expect(t).not.toContain(" at ");
  for (const f of forbidden) expect(t).not.toContain(f);
}

describe("REST foreign-team reads", () => {
  it("[CP2-T01] REST list of a foreign team answers 400 with the actionable message", async () => {
    mode.guard = "bypass";
    await expectRest400(await get(`/list?workspace=company&team=${FOREIGN}`), SECRET);
  });

  it("[CP2-T02] REST standing read of a foreign team answers 400, not that team's rows", async () => {
    mode.guard = "bypass";
    await expectRest400(await get(`/standing?workspace=company&team=${TEAM_B}`), SECRET_B);
  });

  it("[CP2-T03] REST recall and graph reads of a foreign team also answer 400", async () => {
    mode.guard = "bypass";
    await expectRest400(await get(`/recall?query=SECRET&workspace=company&team=${FOREIGN}`), SECRET);
    await expectRest400(await get(`/graph?workspace=company&team=${FOREIGN}`), SECRET);
  });
});

describe("MCP foreign-team reads", () => {
  it("[CP2-T04] MCP recall of a foreign team returns a clean tool error with the message", async () => {
    mode.guard = "bypass";
    const r = await callTool("recall", { query: "SECRET", workspace: "company", team: FOREIGN });
    expectCleanToolError(r, SECRET);
  });

  it("[CP2-T05] MCP brief, list_projects and list_recent refuse a foreign team the same way", async () => {
    mode.guard = "bypass";
    // The MCP server registers no graph tool; these are its other team-scoped reads.
    for (const name of ["brief", "list_projects", "list_recent"]) {
      const r = await callTool(name, { workspace: "company", team: TEAM_B });
      expectCleanToolError(r, SECRET_B);
    }
  });

  it("[CP2-T06] real /mcp endpoint answers HTTP 200 carrying an isError tool result", async () => {
    mode.guard = "bypass";
    const res = await call("POST", "/mcp", ADMIN, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "recall", arguments: { query: "SECRET", workspace: "company", team: FOREIGN } },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const data = raw.includes("data:") ? raw.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : raw;
    const result = (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expectCleanToolError(result, SECRET);
  });
});

describe("guards", () => {
  it("[CP2-T07] a plain Error from a read still rejects instead of being masked as 400", async () => {
    mode.guard = "boom";
    await expect(get(`/list?workspace=company&team=${FOREIGN}`)).rejects.toThrow("boom");
  });

  it("[CP2-T08] the D1 daily-limit 429 path is unchanged for reads", async () => {
    mode.guard = "limit";
    const res = await get(`/list?team=${FOREIGN}`);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("daily_limit");
  });

  it("[CP2-T13] bypass mode with no team named still reads normally", async () => {
    mode.guard = "bypass";
    const res = await get(`/list?workspace=company`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain("own-team-row");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SECRET_B);
  });
});

describe("real mode (live edge guard)", () => {
  it("[CP2-T09] live edge validator gives a 400 over REST and the message over MCP", async () => {
    await expectRest400(await get(`/list?workspace=company&team=${FOREIGN}`), SECRET);
    const r = await callTool("recall", { query: "SECRET", workspace: "company", team: FOREIGN });
    expectActionable(text(r));
    expect(text(r)).not.toContain(SECRET);
    expect(text(r)).not.toContain("Internal");
  });

  it("[CP2-T10] a member cannot read another member's team by naming it", async () => {
    mode.guard = "bypass";
    await expectRest400(await get(`/list?workspace=company&team=${TEAM_B}`), SECRET_B);
    const r = await callTool("recall", { query: "SECRET", workspace: "company", team: TEAM_B });
    expectCleanToolError(r, SECRET_B);
  });

  it("[CP2-T11] valid REST reads return the same rows as before", async () => {
    const rows = async (path: string) => {
      const res = await get(path);
      expect(res.status).toBe(200);
      return res.text();
    };
    const all = await rows("/list");
    expect(all).toContain("dana-note");
    expect(all).toContain("own-team-row");
    expect(all).not.toContain("SECRET-");
    const personal = await rows("/list?workspace=personal");
    expect(personal).toContain("dana-note");
    expect(personal).not.toContain("own-team-row");
    expect(personal).not.toContain("SECRET-");
    const own = await rows(`/list?workspace=company&team=${OWN_TEAM}`);
    expect(own).toContain("own-team-row");
    expect(own).not.toContain("dana-note");
    expect(own).not.toContain("SECRET-");
    const standing = await rows("/standing");
    expect(standing).toContain("dana-note");
    expect(standing).not.toContain("SECRET-");
  });

  it("[CP2-T12] valid MCP reads return the same results as before", async () => {
    const none = await callTool("recall", { query: "dana-note" });
    expect(none.isError).toBeFalsy();
    expect(text(none)).toContain("dana-note");
    expect(text(none)).not.toContain("SECRET-");
    const personal = await callTool("recall", { query: "dana-note", workspace: "personal" });
    expect(personal.isError).toBeFalsy();
    expect(text(personal)).toContain("dana-note");
    expect(text(personal)).not.toContain("SECRET-");
    const own = await callTool("recall", { query: "own-team-row", workspace: "company", team: OWN_TEAM });
    expect(own.isError).toBeFalsy();
    expect(text(own)).toContain("own-team-row");
    expect(text(own)).not.toContain("SECRET-");
    const projects = await callTool("list_projects", {});
    expect(projects.isError).toBeFalsy();
    expect(text(projects)).not.toContain("SECRET-");
  });
});
