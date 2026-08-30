/**
 * Exhaustive team/workspace permutations for every MCP tool and API route that
 * accepts them, plus id-based routes verified against multi-team rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => { void 0; } } as ExecutionContext;
const ADMIN = "test-token";
const TEAM_B = "ws-team-b";
const FOREIGN_TEAM = "ws-not-mine";
const TAG = "permtest";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let dana: { userId: string; personalWorkspaceId: string; token: string };

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

const jsonOf = (res: Response) => res.json() as Promise<any>;
const idsOf = (rows: { id: string }[]) => new Set(rows.map(r => r.id));

function join(userId: string, workspaceId: string) {
  return sqlite.db
    .prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
    .bind(userId, workspaceId, Date.now())
    .run();
}

function seed(
  id: string,
  workspaceId: string,
  actorId: string,
  content: string,
  tags: string[] = [],
  createdAt = Date.now() - 3600_000,
) {
  return sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, ?, 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, JSON.stringify(tags), createdAt, createdAt, workspaceId, actorId)
    .run();
}

function seedEdge(sourceId: string, targetId: string, workspaceId: string) {
  return sqlite.db
    .prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'relates_to', 0.9, 'explicit', '{}', 1, 1, ?)`,
    )
    .bind(`${sourceId}-${targetId}`, sourceId, targetId, workspaceId)
    .run();
}

async function mcpClient(token: string) {
  const identity = await resolveIdentityFromToken(token, env);
  const server = buildMcpServer(env, ctx, identity ?? undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "perm-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, identity, close: () => client.close() };
}

const textOf = (res: { content: { text: string }[] }) => res.content[0]?.text ?? "";

function seedTriangle() {
  seed("mem-primary", roots.companyWorkspaceId, roots.ownerUserId, "ZETA primary team policy document", [TAG]);
  seed("mem-platform", TEAM_B, roots.ownerUserId, "ZETA platform team runbook document", [TAG]);
  seed("mem-private", dana.personalWorkspaceId, dana.userId, "ZETA dana private diary entry", [TAG]);
  seedEdge("mem-primary", "mem-platform", roots.companyWorkspaceId);
  seedEdge("mem-platform", "mem-primary", TEAM_B);
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [] }),
      upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
      insert: vi.fn().mockResolvedValue({ mutationId: "m" }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: "m" }),
    }),
    AI: {
      run: vi.fn().mockImplementation(async (model: string, opts?: { stream?: boolean }) => {
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        if (opts?.stream) {
          const sse = (text: string) => new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
          return sse("Platform-only digest rollup.");
        }
        return { response: '{"importance":2,"canonical":false,"kind":"semantic"}' };
      }),
    } as unknown as Ai,
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const created = await createMember(env, { name: "Dana" });
  dana = {
    userId: created.member.userId,
    personalWorkspaceId: created.member.personalWorkspaceId,
    token: created.token,
  };
  await sqlite.db
    .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`)
    .bind(TEAM_B, Date.now() + 1000)
    .run();
  await join(dana.userId, TEAM_B);
  seedTriangle();
});

afterEach(() => sqlite?.close());

describe("REST read routes — workspace/team permutations", () => {
  type Case = {
    label: string;
    qs: () => string;
    expect: string[];
    reject: string[];
    status?: number;
  };

  function listCases(): Case[] {
    return [
      { label: "unscoped", qs: () => "?n=50", expect: ["mem-primary", "mem-platform", "mem-private"], reject: [] },
      { label: "workspace=personal", qs: () => "?n=50&workspace=personal", expect: ["mem-private"], reject: ["mem-primary", "mem-platform"] },
      { label: "workspace=company", qs: () => "?n=50&workspace=company", expect: ["mem-primary", "mem-platform"], reject: ["mem-private"] },
      { label: "workspace=company&team=primary", qs: () => `?n=50&workspace=company&team=${encodeURIComponent(roots.companyWorkspaceId)}`, expect: ["mem-primary"], reject: ["mem-platform", "mem-private"] },
      { label: "workspace=company&team=platform", qs: () => `?n=50&workspace=company&team=${TEAM_B}`, expect: ["mem-platform"], reject: ["mem-primary", "mem-private"] },
    ];
  }

  function recallCases(): Case[] {
    return [
      { label: "unscoped", qs: () => "?query=ZETA&topK=20&synthesize=false", expect: ["mem-primary", "mem-platform", "mem-private"], reject: [] },
      { label: "workspace=personal", qs: () => "?query=ZETA&topK=20&synthesize=false&workspace=personal", expect: ["mem-private"], reject: ["mem-primary", "mem-platform"] },
      { label: "workspace=company", qs: () => "?query=ZETA&topK=20&synthesize=false&workspace=company", expect: ["mem-primary", "mem-platform"], reject: ["mem-private"] },
      { label: "workspace=company&team=platform", qs: () => `?query=ZETA&topK=20&synthesize=false&workspace=company&team=${TEAM_B}`, expect: ["mem-platform"], reject: ["mem-primary", "mem-private"] },
    ];
  }

  function graphCases(): Case[] {
    return [
      { label: "unscoped", qs: () => "", expect: ["mem-primary", "mem-platform"], reject: [] },
      { label: "workspace=personal", qs: () => "?workspace=personal", expect: [], reject: ["mem-primary", "mem-platform"] },
      { label: "workspace=company", qs: () => "?workspace=company", expect: ["mem-primary", "mem-platform"], reject: [] },
      { label: "workspace=company&team=platform", qs: () => `?workspace=company&team=${TEAM_B}`, expect: ["mem-platform"], reject: ["mem-primary"] },
    ];
  }

  for (const c of listCases()) {
    it(`GET /list ${c.label}`, async () => {
      const res = await call("GET", `/list${c.qs()}`, dana.token);
      expect(res.status).toBe(c.status ?? 200);
      if (c.status) return;
      const rows = await jsonOf(res);
      const got = idsOf(rows);
      for (const id of c.expect) expect(got.has(id)).toBe(true);
      for (const id of c.reject) expect(got.has(id)).toBe(false);
    });
  }

  for (const c of recallCases()) {
    it(`GET /recall ${c.label}`, async () => {
      const res = await call("GET", `/recall${c.qs()}`, dana.token);
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      const got = idsOf(body.results ?? []);
      for (const id of c.expect) expect(got.has(id)).toBe(true);
      for (const id of c.reject) expect(got.has(id)).toBe(false);
    });
  }

  for (const c of graphCases()) {
    it(`GET /graph ${c.label}`, async () => {
      const res = await call("GET", `/graph${c.qs()}`, dana.token);
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      const got = new Set((body.nodes as { id: string }[]).map(n => n.id));
      for (const id of c.expect) expect(got.has(id)).toBe(true);
      for (const id of c.reject) expect(got.has(id)).toBe(false);
    });
  }

  it("GET /team/workspaces matches MCP list_teams ids", async () => {
    const rest = await jsonOf(await call("GET", "/team/workspaces", dana.token));
    const { client, close } = await mcpClient(dana.token);
    try {
      const mcp = textOf(await client.callTool({ name: "list_teams", arguments: {} }) as any);
      for (const t of rest.teams as { id: string; name: string }[]) {
        expect(mcp).toContain(t.id);
        expect(mcp).toContain(t.name);
      }
      expect(mcp).toContain("[primary");
    } finally {
      await close();
    }
  });

  const invalidCases = [
    { route: "/list?n=10&workspace=personal&team=x", label: "team with personal workspace" },
    { route: `/list?n=10&team=${FOREIGN_TEAM}`, label: "foreign team id" },
    { route: "/list?n=10&workspace=invalid", label: "bad workspace" },
    { route: `/recall?query=ZETA&team=${FOREIGN_TEAM}`, label: "recall foreign team" },
    { route: `/graph?team=${FOREIGN_TEAM}`, label: "graph foreign team" },
    { route: `/digest?tag=${TAG}&workspace=personal&team=${TEAM_B}`, label: "digest team with personal" },
    { route: `/digest?tag=${TAG}&team=${FOREIGN_TEAM}`, label: "digest foreign team" },
  ];

  for (const c of invalidCases) {
    it(`rejects ${c.label}`, async () => {
      const res = await call("GET", c.route, dana.token);
      expect(res.status).toBe(400);
    });
  }
});

describe("REST write routes — workspace/team permutations", () => {
  it("POST /capture personal", async () => {
    const body = await jsonOf(await call("POST", "/capture", dana.token, {
      content: "Captured to personal layer",
      workspace: "personal",
    }));
    expect(body.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(body.id).first() as { workspace_id: string };
    expect(row.workspace_id).toBe(dana.personalWorkspaceId);
  });

  it("POST /capture company primary (default team)", async () => {
    const body = await jsonOf(await call("POST", "/capture", dana.token, {
      content: "Captured to primary team",
      workspace: "company",
    }));
    expect(body.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(body.id).first() as { workspace_id: string };
    expect(row.workspace_id).toBe(roots.companyWorkspaceId);
  });

  it("POST /capture company named team", async () => {
    const body = await jsonOf(await call("POST", "/capture", dana.token, {
      content: "Captured to Platform team",
      workspace: "company",
      team: TEAM_B,
    }));
    expect(body.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(body.id).first() as { workspace_id: string };
    expect(row.workspace_id).toBe(TEAM_B);
  });

  it("POST /capture rejects foreign team", async () => {
    expect((await call("POST", "/capture", dana.token, {
      content: "Sneak",
      workspace: "company",
      team: FOREIGN_TEAM,
    })).status).toBe(400);
  });

  it("POST /capture rejects team with personal workspace", async () => {
    expect((await call("POST", "/capture", dana.token, {
      content: "Mismatch",
      workspace: "personal",
      team: TEAM_B,
    })).status).toBe(400);
  });

  it("POST /share into named team", async () => {
    seed("share-me", dana.personalWorkspaceId, dana.userId, "Share into Platform");
    const body = await jsonOf(await call("POST", "/share", dana.token, {
      id: "share-me",
      workspace: "company",
      team: TEAM_B,
    }));
    expect(body.ok).toBe(true);
    expect(body.workspaceId).toBe(TEAM_B);
  });

  it("POST /share moves between team workspaces", async () => {
    seed("move-me", roots.companyWorkspaceId, dana.userId, "Move primary to Platform");
    const body = await jsonOf(await call("POST", "/share", dana.token, {
      id: "move-me",
      workspace: "company",
      team: TEAM_B,
    }));
    expect(body.ok).toBe(true);
    expect(body.workspaceId).toBe(TEAM_B);
  });

  it("POST /share rejects foreign team", async () => {
    seed("stay-private", dana.personalWorkspaceId, dana.userId, "Stay here");
    expect((await call("POST", "/share", dana.token, {
      id: "stay-private",
      workspace: "company",
      team: FOREIGN_TEAM,
    })).status).toBe(400);
  });
});

describe("REST id-based routes on a Platform-team row", () => {
  beforeEach(() => {
    seed("plat-a", TEAM_B, dana.userId, "Platform entry alpha");
    seed("plat-b", TEAM_B, dana.userId, "Platform entry beta");
    seedEdge("plat-a", "plat-b", TEAM_B);
  });

  it("GET /entry", async () => {
    const body = await jsonOf(await call("GET", "/entry?id=plat-a", dana.token));
    expect(body.ok).toBe(true);
    expect(body.entry.id).toBe("plat-a");
    expect(body.entry.workspace).toBe("company");
  });

  it("POST /append", async () => {
    const body = await jsonOf(await call("POST", "/append", dana.token, { id: "plat-a", addition: "more platform detail" }));
    expect(body.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT content, workspace_id FROM entries WHERE id = ?`).bind("plat-a").first() as { content: string; workspace_id: string };
    expect(row.workspace_id).toBe(TEAM_B);
    expect(row.content).toContain("more platform detail");
  });

  it("POST /update", async () => {
    const body = await jsonOf(await call("POST", "/update", dana.token, { id: "plat-a", content: "Replaced platform content" }));
    expect(body.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT content, workspace_id FROM entries WHERE id = ?`).bind("plat-a").first() as { content: string; workspace_id: string };
    expect(row.workspace_id).toBe(TEAM_B);
    expect(row.content).toBe("Replaced platform content");
  });

  it("POST /status", async () => {
    const body = await jsonOf(await call("POST", "/status", dana.token, { id: "plat-a", status: "canonical" }));
    expect(body.ok).toBe(true);
    const row = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind("plat-a").first() as { tags: string };
    expect(JSON.parse(row.tags)).toContain("status:canonical");
  });

  it("GET /connections", async () => {
    const body = await jsonOf(await call("GET", "/connections?id=plat-a", dana.token));
    expect(body.ok).toBe(true);
    expect(body.connections.some((r: { id: string }) => r.id === "plat-b")).toBe(true);
  });

  it("POST /link and POST /unlink", async () => {
    seed("plat-c", TEAM_B, dana.userId, "Platform entry gamma");
    expect((await call("POST", "/link", dana.token, { source_id: "plat-a", target_id: "plat-c" })).status).toBe(200);
    const linked = await sqlite.db.prepare(
      `SELECT id FROM edges WHERE source_id = ? AND target_id = ?`,
    ).bind("plat-a", "plat-c").first();
    expect(linked).toBeTruthy();
    expect((await call("POST", "/unlink", dana.token, { source_id: "plat-a", target_id: "plat-c" })).status).toBe(200);
    const gone = await sqlite.db.prepare(
      `SELECT id FROM edges WHERE source_id = ? AND target_id = ?`,
    ).bind("plat-a", "plat-c").first();
    expect(gone).toBeFalsy();
  });
});

describe("MCP tools — workspace/team permutations", () => {
  it("list_teams", async () => {
    const { client, close } = await mcpClient(dana.token);
    try {
      const text = textOf(await client.callTool({ name: "list_teams", arguments: {} }) as any);
      expect(text).toContain("Platform");
      expect(text).toContain(TEAM_B);
      expect(text).toContain(roots.companyWorkspaceId);
    } finally {
      await close();
    }
  });

  function rememberCases() {
    return [
      { label: "personal", args: { content: "MCP personal capture", workspace: "personal" as const }, workspaceId: () => dana.personalWorkspaceId },
      { label: "company primary", args: { content: "MCP primary team capture", workspace: "company" as const }, workspaceId: () => roots.companyWorkspaceId },
      { label: "company named team", args: { content: "MCP platform team capture", workspace: "company" as const, team: TEAM_B }, workspaceId: () => TEAM_B },
    ];
  }

  for (const c of rememberCases()) {
    it(`remember ${c.label}`, async () => {
      const { client, close } = await mcpClient(dana.token);
      try {
        const res = await client.callTool({ name: "remember", arguments: c.args }) as any;
        const id = /ID: ([^\s]+)/.exec(textOf(res))?.[1];
        expect(id).toBeTruthy();
        const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id).first() as { workspace_id: string };
        expect(row.workspace_id).toBe(c.workspaceId());
      } finally {
        await close();
      }
    });
  }

  it("remember rejects foreign team", async () => {
    const { client, close } = await mcpClient(dana.token);
    try {
      const res = await client.callTool({
        name: "remember",
        arguments: { content: "nope", workspace: "company", team: FOREIGN_TEAM },
      }) as any;
      expect(textOf(res)).toMatch(/team/i);
    } finally {
      await close();
    }
  });

  function mcpRecallCases() {
    return [
      { label: "unscoped", args: { query: "User wants ZETA team docs — what is stored?", topK: 20 }, expect: ["mem-primary", "mem-platform", "mem-private"], reject: [] as string[] },
      { label: "workspace=personal", args: { query: "User wants ZETA private notes — what is stored?", topK: 20, workspace: "personal" as const }, expect: ["mem-private"], reject: ["mem-primary", "mem-platform"] },
      { label: "workspace=company&team=platform", args: { query: "User wants ZETA platform runbook — what is stored?", topK: 20, workspace: "company" as const, team: TEAM_B }, expect: ["mem-platform"], reject: ["mem-primary", "mem-private"] },
    ];
  }

  for (const c of mcpRecallCases()) {
    it(`recall ${c.label}`, async () => {
      const { client, close } = await mcpClient(dana.token);
      try {
        const text = textOf(await client.callTool({ name: "recall", arguments: c.args }) as any);
        for (const id of c.expect) expect(text).toContain(id);
        for (const id of c.reject) expect(text).not.toContain(`ID: ${id}`);
      } finally {
        await close();
      }
    });
  }

  const listRecentCases = [
    { label: "unscoped", args: { n: 50 }, expect: ["mem-primary", "mem-platform", "mem-private"], reject: [] as string[] },
    { label: "workspace=company&team=platform", args: { n: 50, workspace: "company" as const, team: TEAM_B }, expect: ["mem-platform"], reject: ["mem-primary", "mem-private"] },
  ];

  for (const c of listRecentCases) {
    it(`list_recent ${c.label}`, async () => {
      const { client, close } = await mcpClient(dana.token);
      try {
        const text = textOf(await client.callTool({ name: "list_recent", arguments: c.args }) as any);
        for (const id of c.expect) expect(text).toContain(id);
        for (const id of c.reject) expect(text).not.toContain(`ID: ${id}`);
      } finally {
        await close();
      }
    });
  }

  it("share into named team", async () => {
    seed("mcp-share", dana.personalWorkspaceId, dana.userId, "MCP share to Platform");
    const { client, close } = await mcpClient(dana.token);
    try {
      const res = await client.callTool({
        name: "share",
        arguments: { id: "mcp-share", workspace: "company", team: TEAM_B },
      }) as any;
      expect(textOf(res)).toMatch(/shared|moved/i);
      const row = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind("mcp-share").first() as { workspace_id: string };
      expect(row.workspace_id).toBe(TEAM_B);
    } finally {
      await close();
    }
  });

  it("share rejects foreign team", async () => {
    seed("mcp-stay", dana.personalWorkspaceId, dana.userId, "MCP stay private");
    const { client, close } = await mcpClient(dana.token);
    try {
      const res = await client.callTool({
        name: "share",
        arguments: { id: "mcp-stay", workspace: "company", team: FOREIGN_TEAM },
      }) as any;
      expect(textOf(res)).toMatch(/team/i);
    } finally {
      await close();
    }
  });
});

describe("MCP id-based tools on a Platform-team row", () => {
  let entryId = "mcp-plat";

  beforeEach(async () => {
    seed(entryId, TEAM_B, dana.userId, "MCP platform row for mutations");
    seed("mcp-plat-neighbor", TEAM_B, dana.userId, "MCP platform neighbor");
    seedEdge(entryId, "mcp-plat-neighbor", TEAM_B);
  });

  it("get", async () => {
    const { client, close } = await mcpClient(dana.token);
    try {
      const text = textOf(await client.callTool({ name: "get", arguments: { id: entryId } }) as any);
      expect(text).toContain(entryId);
      expect(text).toContain("shared");
    } finally {
      await close();
    }
  });

  it("append and update keep workspace_id", async () => {
    const { client, close } = await mcpClient(dana.token);
    try {
      await client.callTool({ name: "append", arguments: { id: entryId, addition: "appended on platform" } });
      await client.callTool({ name: "update", arguments: { id: entryId, content: "Updated platform row in full" } });
      const row = await sqlite.db.prepare(`SELECT content, workspace_id FROM entries WHERE id = ?`).bind(entryId).first() as { content: string; workspace_id: string };
      expect(row.workspace_id).toBe(TEAM_B);
      expect(row.content).toBe("Updated platform row in full");
    } finally {
      await close();
    }
  });

  it("set_status", async () => {
    const { client, close } = await mcpClient(dana.token);
    try {
      await client.callTool({ name: "set_status", arguments: { id: entryId, status: "draft" } });
      const row = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(entryId).first() as { tags: string };
      expect(JSON.parse(row.tags)).toContain("status:draft");
    } finally {
      await close();
    }
  });

  it("connections, link, unlink", async () => {
    seed("mcp-plat-target", TEAM_B, dana.userId, "MCP link target on platform");
    const { client, close } = await mcpClient(dana.token);
    try {
      const conn = textOf(await client.callTool({ name: "connections", arguments: { id: entryId } }) as any);
      expect(conn).toContain("mcp-plat-neighbor");
      await client.callTool({ name: "link", arguments: { source_id: entryId, target_id: "mcp-plat-target" } });
      const linked = await sqlite.db.prepare(
        `SELECT id FROM edges WHERE source_id = ? AND target_id = ?`,
      ).bind(entryId, "mcp-plat-target").first();
      expect(linked).toBeTruthy();
      await client.callTool({ name: "unlink", arguments: { source_id: entryId, target_id: "mcp-plat-target" } });
      const gone = await sqlite.db.prepare(
        `SELECT id FROM edges WHERE source_id = ? AND target_id = ?`,
      ).bind(entryId, "mcp-plat-target").first();
      expect(gone).toBeFalsy();
    } finally {
      await close();
    }
  });

  it("forget", async () => {
    seed("mcp-forget", TEAM_B, dana.userId, "MCP row to forget");
    const { client, close } = await mcpClient(dana.token);
    try {
      const res = await client.callTool({ name: "forget", arguments: { id: "mcp-forget" } }) as any;
      expect(textOf(res)).toMatch(/forgot|deleted|removed/i);
      const row = await sqlite.db.prepare(`SELECT id FROM entries WHERE id = ?`).bind("mcp-forget").first();
      expect(row).toBeFalsy();
    } finally {
      await close();
    }
  });
});

describe("GET /digest — team scoping", () => {
  const old = Date.now() - 200 * 24 * 3600 * 1000;
  const prompts: string[] = [];

  beforeEach(() => {
    prompts.length = 0;
    env.AI = {
      run: vi.fn().mockImplementation(async (model: string, opts?: { stream?: boolean; messages?: { content: string }[] }) => {
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        if (opts?.stream) {
          prompts.push(String(opts?.messages?.[0]?.content ?? ""));
          const sse = (text: string) => new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
          return sse("Platform-scoped digest only.");
        }
        return { response: "3" };
      }),
    } as unknown as Ai;
    for (let i = 0; i < 12; i++) {
      seed(`dig-primary-${i}`, roots.companyWorkspaceId, dana.userId, `PRIMARY digest seed ${i}`, [TAG], old);
      seed(`dig-platform-${i}`, TEAM_B, dana.userId, `PLATFORM digest seed ${i}`, [TAG], old);
    }
  });

  it("workspace=company&team scopes rollup to one team", async () => {
    const res = await call("GET", `/digest?tag=${TAG}&workspace=company&team=${TEAM_B}`, dana.token);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.entry_id).toBeTruthy();
    for (const p of prompts) {
      if (p.includes("Memories:")) {
        expect(p).not.toContain("PRIMARY digest");
        expect(p).toContain("PLATFORM digest");
      }
    }
    const digestRow = await sqlite.db.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(body.entry_id).first() as { workspace_id: string };
    expect(digestRow.workspace_id).toBe(TEAM_B);
  });
});
