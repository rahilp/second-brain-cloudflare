/**
 * MCP list_teams exposes the same teams as GET /team/workspaces for AI clients.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const TEAM_B = "ws-team-b";

describe("MCP list_teams", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let danaToken = "";
  let roots: { companyWorkspaceId: string };

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
    });
    await initializeDatabase(env);
    roots = await ensureTenantBootstrap(env);
    const dana = await createMember(env, { name: "Dana" });
    danaToken = dana.token;
    await sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`)
      .bind(TEAM_B, Date.now() + 1000).run();
    await sqlite.db.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
      .bind(dana.member.userId, TEAM_B, Date.now()).run();
  });

  afterEach(() => sqlite.close());

  it("returns both team names and ids for a multi-team member", async () => {
    const identity = await resolveIdentityFromToken(danaToken, env);
    const server = buildMcpServer(env, ctx, identity ?? undefined);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "list_teams", arguments: {} });
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      expect(text).toContain("Platform");
      expect(text).toContain(TEAM_B);
      expect(text).toContain(roots.companyWorkspaceId);
      expect(text).toContain("[primary");
    } finally {
      await client.close();
    }
  });
});
