import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { buildMcpServer, recallEntries } from "../../src/index";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeMatch(id: string, score: number) {
  return { id, score, metadata: { parentId: id, isUpdate: false } };
}

// Every LLM call the insight synthesizer makes carries this prompt fragment,
// so filtering AI.run calls on it isolates the insight call from the other
// LLM users on the recall path (tag inference, classification).
const INSIGHT_PROMPT_MARKER = "Write a brief insight";

function insightCalls(env: Env): any[] {
  return (env.AI.run as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([, args]) => args?.messages?.[0]?.content?.includes?.(INSIGHT_PROMPT_MARKER)
  );
}

// Seeds two entries that both dense-match the query so matches.length > 1 —
// the precondition for insight synthesis to be considered at all.
function makeTwoMatchEnv(db: D1Mock): Env {
  db.entries.push(
    { id: "entry-1", content: "First memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    { id: "entry-2", content: "Second memory", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
  );
  return makeTestEnv(db, {
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [makeMatch("entry-1", 0.9), makeMatch("entry-2", 0.8)],
      }),
    }),
  });
}

// Drives the real MCP recall tool closure over an in-memory transport, so the
// call-site contract (synthesize: false) is pinned by an actual tool call
// rather than inferred from unit-level behavior.
async function callMcpRecall(env: Env, query: string) {
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name: "recall", arguments: { query } });
  } finally {
    await client.close();
  }
}

describe("recall insight synthesis: MCP skips it, HTTP keeps it", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTwoMatchEnv(db);
  });

  it("MCP recall returns matches without an insight and never invokes the insight LLM", async () => {
    const result = await callMcpRecall(env, "memory");

    const text = (result.content as any[])[0].text as string;
    // The matches themselves still come through untouched.
    expect(text).toContain("First memory");
    expect(text).toContain("Second memory");
    // No server-side insight: the MCP client synthesizes with its own model.
    expect(text).not.toContain("**Insight:**");
    expect(insightCalls(env)).toHaveLength(0);
  });

  it("recallEntries with synthesize:false returns an empty insight without calling the LLM", async () => {
    const res = await recallEntries({ query: "memory", topK: 5, synthesize: false }, env, ctx);

    expect(res.matches).toHaveLength(2);
    expect(res.insight).toBe("");
    expect(insightCalls(env)).toHaveLength(0);
  });

  it("recallEntries defaults to synthesizing when the flag is omitted", async () => {
    // Guards the HTTP path: callers that don't opt out must keep today's behavior.
    const res = await recallEntries({ query: "memory", topK: 5 }, env, ctx);

    expect(res.matches).toHaveLength(2);
    expect(insightCalls(env)).toHaveLength(1);
    expect(res.insight).not.toBe("");
  });

  it("GET /recall still synthesizes an insight (web path unchanged)", async () => {
    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(2);
    expect(insightCalls(env)).toHaveLength(1);
    expect(data.insight).toBeTruthy();
  });
});
