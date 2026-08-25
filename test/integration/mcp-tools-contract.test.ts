import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

const EXPECTED_TOOLS = [
  "remember",
  "recall",
  "list_recent",
  "get",
  "append",
  "update",
  "set_status",
  "forget",
  "share",
  "link",
  "unlink",
  "connections",
];

async function withMcpClient(env: Env, run: (client: Client) => Promise<void>) {
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe("MCP tools contract (InMemoryTransport)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("listTools exposes all second brain tools", async () => {
    await withMcpClient(env, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const name of EXPECTED_TOOLS) {
        expect(names).toContain(name);
      }
    });
  });

  it("exposes exactly the expected tools, each registered once", async () => {
    await withMcpClient(env, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
    });
  });

  it("remember and recall round-trip through the MCP transport", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockImplementation(async () => {
          const entry = db.entries[db.entries.length - 1];
          if (!entry) return { matches: [] };
          return {
            matches: [{
              id: entry.id,
              score: 0.95,
              metadata: { parentId: entry.id, isUpdate: false },
            }],
          };
        }),
      }),
    });

    await withMcpClient(env, async (client) => {
      const remember = await client.callTool({
        name: "remember",
        arguments: { content: "project-alpha kickoff note", tags: ["project-alpha"] },
      });
      expect(remember.isError).toBeFalsy();
      const rememberText = (remember.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(rememberText.length).toBeGreaterThan(0);

      const recall = await client.callTool({
        name: "recall",
        arguments: { query: "User wants to verify MCP recall works — what was stored?" },
      });
      expect(recall.isError).toBeFalsy();
      const text = (recall.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toMatch(/project-alpha kickoff note/i);
    });
  });
});

// The tool descriptions are the whole recall-quality mechanism on the client
// side, so they are asserted on behaviour rather than on prose: each check names
// one thing a calling model must be told, and any rewording that keeps the
// meaning keeps passing. Nothing here may depend on what a particular brain
// contains — these run against an empty synthetic store.
describe("MCP tool descriptions teach generic recall behaviour", () => {
  const env = makeTestEnv(makeTestDb());

  async function descriptions(): Promise<Record<string, string>> {
    let map: Record<string, string> = {};
    await withMcpClient(env, async (client) => {
      const { tools } = await client.listTools();
      map = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    });
    return map;
  }

  async function schemaFor(name: string): Promise<Record<string, any>> {
    let props: Record<string, any> = {};
    await withMcpClient(env, async (client) => {
      const { tools } = await client.listTools();
      props = (tools.find((t) => t.name === name)?.inputSchema?.properties ?? {}) as Record<string, any>;
    });
    return props;
  }

  describe("recall", () => {
    it("tells the client to judge returned content rather than trust rank", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/rank 1 is a candidate, not a guarantee/i);
      expect(recall).toMatch(/read the returned content/i);
      // Rank 1 being unreliable must not read as rank 1 being usually wrong —
      // that would buy recovery calls the result set does not need.
      expect(recall).not.toMatch(/often not the right one/i);
    });

    it("says the match percentage is a retrieval signal, not answer confidence", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/retrieval signals?, not calibrated confidence/i);
    });

    it("asks for enough candidates to compare, defaulting to 5", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/enough candidates to compare/i);
      expect(recall).toMatch(/topK 5/i);

      const topK = (await schemaFor("recall")).topK;
      expect(topK?.default).toBe(5);
      expect(topK?.description).toMatch(/compare/i);
    });

    it("requires one targeted recovery search when the first is weak", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/empty, off-topic, ambiguous/i);
      expect(recall).toMatch(/one more targeted recall/i);
      expect(recall).toMatch(/before concluding/i);
    });

    it("names the deterministic filters available for recovery", async () => {
      const recall = (await descriptions()).recall;
      for (const control of ["tag", "kind", "after", "before", "hops"]) {
        expect(recall).toMatch(new RegExp(`\\b${control}\\b`));
      }
      expect(recall).toMatch(/more specific query/i);
    });

    it("tells the client to resolve conversational references before querying", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/subject named explicitly instead of a pronoun/i);
      expect((await schemaFor("recall")).query?.description).toMatch(/resolve references/i);
    });

    it("chooses on fit rather than on recency, score, or length", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/most directly answers the question/i);
      expect(recall).toMatch(/not automatically the newest/i);
      expect(recall).toMatch(/highest-scoring/i);
      expect(recall).toMatch(/longest/i);
      expect(recall).toMatch(/semantic memories are better for/i);
      expect(recall).toMatch(/episodic memories are better for/i);
    });

    it("treats lifecycle status as a dimension separate from kind", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/kind and lifecycle status are separate dimensions/i);
      expect(recall).toMatch(/canonical one outranks a draft/i);
      // Canonical wins for settled information, not unconditionally: a question
      // about what is still tentative wants the draft.
      expect(recall).toMatch(/but not when the question is precisely about what is tentative/i);
    });

    it("scopes graph expansion to history-shaped questions only", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/hops to 1-2/i);
      expect(recall).toMatch(/why something happened/i);
      expect(recall).toMatch(/Leave it at 0 when direct matches already answer/i);
    });

    it("keeps the truncation contract", async () => {
      const recall = (await descriptions()).recall;
      expect(recall).toMatch(/\[truncated …\] marker is PARTIAL/);
      expect(recall).toMatch(/call get\(id\)/);
    });

    it("stays short enough to work as a tool contract", async () => {
      expect((await descriptions()).recall.length).toBeLessThan(2200);
    });
  });

  describe("get", () => {
    it("fetches a truncated result when the omitted part could change the answer", async () => {
      const get = (await descriptions()).get;
      expect(get).toMatch(/\[truncated …\] marker is partial/i);
      expect(get).toMatch(/materially change the answer/i);
      expect(get).toMatch(/do not have to fetch every truncated result/i);
    });
  });

  describe("connections", () => {
    it("is scoped to relationship exploration after a memory is identified", async () => {
      const connections = (await descriptions()).connections;
      expect(connections).toMatch(/once recall has already identified a relevant memory/i);
      expect(connections).toMatch(/causal history|decision lineage/i);
      expect(connections).toMatch(/skip it when direct recall already answers/i);
    });
  });

  describe("remember", () => {
    it("still asks for automatic capture without permission", async () => {
      const remember = (await descriptions()).remember;
      expect(remember).toMatch(/automatically, without asking permission/i);
    });

    it("scopes automatic capture to durable, later-retrievable information", async () => {
      const remember = (await descriptions()).remember;
      expect(remember).toMatch(/durable enough to be worth retrieving in a later conversation/i);
      expect(remember).toMatch(/passing conversational detail that will not matter later/i);
    });

    it("points a continuing thread at append instead of a near-duplicate", async () => {
      const remember = (await descriptions()).remember;
      expect(remember).toMatch(/call append on the existing entry/i);
      expect(remember).toMatch(/near-duplicate/i);
    });

    it("rejects repeated no-op observations as new durable memories", async () => {
      const remember = (await descriptions()).remember;
      expect(remember).toMatch(/repeated no-op observation/i);
      expect(remember).toMatch(/unchanged status/i);
    });

    it("keeps a genuinely distinct item as its own retrieval target", async () => {
      const remember = (await descriptions()).remember;
      expect(remember).toMatch(/its own retrieval target/i);
      expect(remember).toMatch(/distinct event|new decision|reusable insight/i);
    });
  });

  describe("append", () => {
    it("is preferred over remember for continuing updates", async () => {
      const append = (await descriptions()).append;
      expect(append).toMatch(/Prefer append over remember/i);
      expect(append).toMatch(/substantially duplicate/i);
      expect(append).toMatch(/continuing thread/i);
    });

    it("refuses unrelated additions and defers replacement to update", async () => {
      const append = (await descriptions()).append;
      expect(append).toMatch(/not append unrelated information/i);
      expect(append).toMatch(/use update/i);
    });
  });

  describe("preserved distinctions", () => {
    it("list_recent is recency, not relevance", async () => {
      const listRecent = (await descriptions()).list_recent;
      expect(listRecent).toMatch(/recency, not by semantic relevance/i);
      expect(listRecent).toMatch(/use recall/i);
    });

    it("update replaces, and is not the incremental-history mechanism", async () => {
      const update = (await descriptions()).update;
      expect(update).toMatch(/no longer the correct representation/i);
      expect(update).toMatch(/not the mechanism for incremental history/i);
      expect(update).toMatch(/use append/i);
    });

    it("set_status still defines the lifecycle states", async () => {
      const setStatus = (await descriptions()).set_status;
      for (const state of ["canonical", "draft", "deprecated"]) {
        expect(setStatus).toMatch(new RegExp(state, "i"));
      }
    });

    it("forget is still explicit about permanent deletion", async () => {
      const forget = (await descriptions()).forget;
      expect(forget).toMatch(/permanently delete/i);
      expect(forget).toMatch(/only call when the user explicitly asks/i);
      expect(forget).toMatch(/cannot be undone/i);
    });
  });

  it("keeps every description free of brain-specific vocabulary", async () => {
    // A description that names a real tag, project, or person would quietly tune
    // this shared server to one person's corpus. Guard the shape instead of a
    // blocklist: no tag: / status: / kind: literals, no bare @handles or emails.
    for (const [name, text] of Object.entries(await descriptions())) {
      expect(text, name).not.toMatch(/\b(?:tag|status|kind):[a-z0-9-]+/i);
      expect(text, name).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(text, name).not.toMatch(/\btags?\s*[:=]\s*\[/i);
    }
  });
});

describe("tool definitions have a single source of truth", () => {
  const SRC = resolve(import.meta.dirname, "../../src");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  }

  it("registers tools only in src/mcp/server.ts", () => {
    const registrars = walk(SRC)
      .filter((file) => readFileSync(file, "utf8").includes("registerTool("))
      .map((file) => relative(SRC, file));
    expect(registrars).toEqual(["mcp/server.ts"]);
  });

  it("registers each exposed tool exactly once", () => {
    const source = readFileSync(join(SRC, "mcp/server.ts"), "utf8");
    for (const name of EXPECTED_TOOLS) {
      const matches = source.match(new RegExp(`registerTool\\(\\s*"${name}"`, "g")) ?? [];
      expect(matches, name).toHaveLength(1);
    }
    expect(source.match(/registerTool\(/g) ?? []).toHaveLength(EXPECTED_TOOLS.length);
  });
});
