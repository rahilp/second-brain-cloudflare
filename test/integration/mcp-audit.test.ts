/**
 * MCP mutations must write the same entry_events trail as REST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (p: Promise<unknown>) => { void p; } } as ExecutionContext;

async function withClient(env: Env, identity: Awaited<ReturnType<typeof resolveIdentityFromToken>>, run: (c: Client) => Promise<void>) {
  const server = buildMcpServer(env, ctx, identity ?? undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "audit-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe("MCP audit trail", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let identity: NonNullable<Awaited<ReturnType<typeof resolveIdentityFromToken>>>;

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
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          return { response: '{"importance":2,"canonical":false,"kind":"semantic"}' };
        }),
      } as unknown as Ai,
    });
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    identity = (await resolveIdentityFromToken("test-token", env))!;
  });

  afterEach(() => sqlite.close());

  async function events() {
    await new Promise(r => setTimeout(r, 10));
    const { results } = await env.DB.prepare(
      `SELECT entry_id, actor_id, event FROM entry_events ORDER BY created_at ASC`,
    ).all();
    return results as { entry_id: string; actor_id: string; event: string }[];
  }

  it("records created on remember", async () => {
    await withClient(env, identity, async (client) => {
      await client.callTool({ name: "remember", arguments: { content: "Audit me on MCP" } });
    });
    const trail = await events();
    expect(trail.some(e => e.event === "created" && e.actor_id === identity.userId)).toBe(true);
  });

  it("records appended on append", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Base memory for append audit" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await client.callTool({ name: "append", arguments: { id, addition: "follow-up detail" } });
    });
    expect(id).toBeTruthy();
    const trail = await events();
    expect(trail.some(e => e.entry_id === id && e.event === "appended")).toBe(true);
  });

  it("records updated on update", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Base memory for update audit" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await client.callTool({ name: "update", arguments: { id, content: "Replaced body for audit" } });
    });
    const trail = await events();
    expect(trail.some(e => e.entry_id === id && e.event === "updated")).toBe(true);
  });

  it("records status_changed on set_status", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Memory to canonicalize" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await client.callTool({ name: "set_status", arguments: { id, status: "canonical" } });
    });
    const trail = await events();
    expect(trail.some(e => e.entry_id === id && e.event === "status_changed")).toBe(true);
  });

  it("records deleted on forget", async () => {
    let id = "";
    await withClient(env, identity, async (client) => {
      const stored = await client.callTool({ name: "remember", arguments: { content: "Memory to delete via MCP" } });
      id = /ID: ([^\s]+)/.exec((stored.content as { text: string }[])[0].text)?.[1] ?? "";
      await client.callTool({ name: "forget", arguments: { id } });
    });
    const trail = await events();
    expect(trail.some(e => e.entry_id === id && e.event === "deleted")).toBe(true);
  });
});
