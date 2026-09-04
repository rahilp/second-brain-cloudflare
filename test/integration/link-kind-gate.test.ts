/**
 * One kind gate, applied by every writer of a kind-constrained edge.
 *
 * `decided` and `follows` are episodic-only in EDGE_TYPES. Capture-time
 * inference and the weekly insight pass both check that through
 * `kindsAllowEdge`, but the two EXPLICIT surfaces — POST /link and the MCP
 * `link` tool — went straight to createEdge, so a caller could hand-link two
 * semantic memories as `follows` and produce exactly the edge the type is
 * defined to exclude. An invariant only one writer honours is not an invariant.
 *
 * Both surfaces already read each endpoint to check readability and workspace,
 * so the gate costs nothing: the kind rides along on those reads.
 *
 * The two are tested together on purpose — the repo's parity convention is that
 * POST /link and MCP `link` are one operation and must not drift.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

describe("the kind gate on explicit links", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
    });
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
  });

  afterEach(() => sqlite.close());

  function seed(id: string, tags: string[]): void {
    sqlite.seed({ id, content: `memory ${id}`, createdAt: 1000, tags });
  }

  async function postLink(source: string, target: string, type: string): Promise<{ status: number; body: any }> {
    const res = await worker.fetch(
      new Request("http://localhost/link", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ source_id: source, target_id: target, type }),
      }),
      env,
      ctx,
    );
    return { status: res.status, body: await res.json() };
  }

  async function mcpLink(source: string, target: string, type: string): Promise<string> {
    const server = buildMcpServer(env, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const out: any = await client.callTool({
        name: "link",
        arguments: { source_id: source, target_id: target, type },
      });
      return String(out.content?.[0]?.text ?? "");
    } finally {
      await client.close();
    }
  }

  const edgeCount = async () =>
    ((await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM edges`).first()) as any).n as number;

  describe("POST /link", () => {
    it("refuses follows between two semantic memories", async () => {
      seed("a", ["kind:semantic"]);
      seed("b", ["kind:semantic"]);

      const { status, body } = await postLink("a", "b", "follows");
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(await edgeCount()).toBe(0);
    });

    it("refuses decided when a memory has no kind yet", async () => {
      seed("a", []);
      seed("b", ["kind:episodic"]);

      // Unclassified is not permission: the classifier simply has not spoken.
      expect((await postLink("a", "b", "decided")).status).toBe(400);
      expect(await edgeCount()).toBe(0);
    });

    it("allows follows between two episodic memories", async () => {
      seed("a", ["kind:episodic"]);
      seed("b", ["kind:episodic"]);

      expect((await postLink("a", "b", "follows")).status).toBe(200);
      expect(await edgeCount()).toBe(1);
    });

    it("still allows relates_to between anything, which it does not constrain", async () => {
      seed("a", ["kind:semantic"]);
      seed("b", []);

      expect((await postLink("a", "b", "relates_to")).status).toBe(200);
      expect(await edgeCount()).toBe(1);
    });
  });

  describe("MCP link", () => {
    it("refuses follows between two semantic memories", async () => {
      seed("a", ["kind:semantic"]);
      seed("b", ["kind:semantic"]);

      expect(await mcpLink("a", "b", "follows")).toMatch(/episodic/i);
      expect(await edgeCount()).toBe(0);
    });

    it("allows follows between two episodic memories", async () => {
      seed("a", ["kind:episodic"]);
      seed("b", ["kind:episodic"]);

      expect(await mcpLink("a", "b", "follows")).toMatch(/Linked/);
      expect(await edgeCount()).toBe(1);
    });
  });
});
