/**
 * Strict MCP clients (src/mcp/sanitize.ts) budget the whole tools/list payload.
 *
 * History (measured with this same toolsListBytes(), by stashing each task's
 * changes and re-measuring against the tree as the prior task left it):
 *   - pre-Track-7 (Task 6, commit 490d944b): 28,454 bytes
 *   - Task 7 (standing/decision/commitment params on remember): 29,789 bytes,
 *     a growth of 1,335 — inside the spec's 1,600-byte budget for that task.
 *   - Task 8 (outcome/received/stop_standing on resolve): 30,423 bytes.
 *   - merge of release/v4 c0eed34b into v4/t2-b (T7-C's decisions/commitments
 *     tools/params plus lane B's own B4 as_of param and AS OF description
 *     section): 32,232 bytes, moved deliberately below.
 *   - S3 (T-0089.4.3, 5.9): undo's optional `group` param plus its own
 *     description sentence: 32,529 bytes, moved deliberately below.
 *   - readOnlyHint on the ten read tools (test/unit/mcp-tool-annotations.test.ts),
 *     so approval-gating MCP clients run them unprompted: 32,889 bytes, moved
 *     deliberately below.
 *
 * PINNED_MAX_BYTES is an absolute ceiling with headroom for further growth,
 * not a per-task delta budget (Task 7's own delta budget is satisfied and
 * recorded above; it does not re-apply to later tasks). A change that pushes
 * this past the ceiling should re-measure and move it deliberately, with a
 * comment naming why — the point is to catch a accidental regrowth (a
 * verbose description rewrite, a duplicated schema block), not to forbid
 * legitimate growth.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

async function toolsListBytes(): Promise<number> {
  const env = makeTestEnv(makeTestDb());
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return new TextEncoder().encode(JSON.stringify(tools)).length;
  } finally {
    await client.close();
  }
}

const PINNED_MAX_BYTES = 33000;

describe("tools/list size", () => {
  it("stays within the pinned byte ceiling", async () => {
    const bytes = await toolsListBytes();
    expect(bytes).toBeLessThanOrEqual(PINNED_MAX_BYTES);
  });
});
