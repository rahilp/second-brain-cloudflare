import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

// Clients such as OpenDots run a tool without asking the user only when the server marks it
// readOnlyHint; everything else lands behind an approval card. recall bumps recall_count on the
// rows it shows, which is ranking telemetry, not a change the caller can observe, so it is read-only.
const READ_TOOLS = ["list_teams", "list_projects", "brief", "digest", "history", "get_prompt_capsule", "recall", "list_recent", "get", "connections"];
const WRITE_TOOLS = ["remember", "append", "update", "set_status", "share", "resolve", "forget", "undo", "link", "unlink"];

async function listTools() {
  const env = makeTestEnv(makeTestDb());
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t]));
  } finally {
    await client.close();
  }
}

describe("tool annotations", () => {
  it("marks every read tool readOnlyHint so approval-gating clients run it unprompted", async () => {
    const tools = await listTools();
    for (const name of READ_TOOLS) {
      expect(tools.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it("never marks a tool that writes as read-only", async () => {
    const tools = await listTools();
    for (const name of WRITE_TOOLS) {
      expect(tools.has(name), name).toBe(true);
      expect(tools.get(name)?.annotations?.readOnlyHint, name).not.toBe(true);
    }
  });

  it("covers every registered tool in one of the two lists", async () => {
    const tools = await listTools();
    expect([...tools.keys()].sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });
});
