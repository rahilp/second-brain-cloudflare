import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
// The layer-parameter pin at the foot of this file drives the real Worker over
// HTTP, because `POST /capture` and `GET /list` are two of the four surfaces it
// exists to hold still and neither is reachable through the MCP transport.
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";

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

    it("list_recent offers the author filter, in the vocabulary it prints", async () => {
      // The schema IS the discovery mechanism: a client only learns it can ask
      // for one person's memories by reading this. The three spellings have to
      // be discoverable together, because a name lifted from a printed header
      // and a user id and "me" all go in the same parameter.
      const listRecent = (await descriptions()).list_recent;
      expect(listRecent).toMatch(/actor/i);
      expect(listRecent).toMatch(/"me"/);

      const actor = (await schemaFor("list_recent")).actor;
      expect(actor?.description).toMatch(/display name/i);
      expect(actor?.description).toMatch(/user id/i);
      expect(actor?.description).toMatch(/"me"/);
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

/**
 * The README's "Memory tools" table is the first thing a new user reads, and it
 * is the one place the tool list is written out by hand. It described six tools
 * for the whole of v3's development while the server exposed twelve — `share`,
 * the tool the team edition is built around, was never mentioned. Nothing failed,
 * because nothing was looking.
 */
describe("README's memory-tools table matches the server", () => {
  const README = resolve(import.meta.dirname, "../../README.md");

  it("names every tool the MCP server exposes, and no others", () => {
    const readme = readFileSync(README, "utf8");
    const table = readme.slice(readme.indexOf("### Memory tools"));
    const documented = [...table.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map(m => m[1]);

    expect(documented.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

/**
 * The surfaces every non-browser client reaches for, pinned by name.
 *
 * `second-brain-cf-cli` — the `brain` binary — lives in a SEPARATE git
 * repository (`~/Projects/second-brain/second-brain-cli`). It is not a
 * submodule, nothing here builds it, and CI never sees it. Its `src/client.ts`
 * posts to `/capture`, reads `GET /list`, and reaches `recall` through the MCP
 * transport, and its `--workspace` flag is nothing but the parameter below
 * passed through. The Worker already accepts all of it, so the flag needed no
 * server change — what it needs is for these surfaces to stop being able to
 * change silently underneath a client this repository cannot see.
 *
 * ## What this block covers
 *
 * Every request name and response key `~/Projects/second-brain/second-brain-cli`
 * reads, taken from its `src/{client,mcpClient,config}.ts` and `src/commands/*`:
 *
 *   - `POST /capture` — body `content`, `tags`, `source`, `workspace`; response
 *     `ok`, `id`, and the `duplicate` / `matchId` pair `runRemember` branches on;
 *     the 400 string a wrong layer name produces.
 *   - `GET /list` — the `n` limit parameter and the `workspace` filter; the row
 *     fields `id`, `content`, `tags`, `source`, `created_at`, `workspace`.
 *   - `POST /append` — body `{ id, addition }`, including that `addition` is the
 *     name and a differently-named field is refused rather than ignored.
 *   - `GET /count` — `{ count }`, which `brain setup` uses to validate a
 *     connection before it writes the config file.
 *   - `GET /stats` — `count`, `avg_importance`, `top_tags`, all snake_case.
 *   - MCP tool schemas: `workspace` on remember/recall/list_recent, `tag` and
 *     `topK` on recall, `id` on forget.
 *   - `~/.config/second-brain/config.json` — the `workerUrl` / `authToken` keys
 *     the desktop app writes and the CLI reads, asserted against the writer.
 *
 * ## What this block does NOT cover — read this before trusting it
 *
 * **The `/mcp` HTTP edge.** `mcpClient.ts` POSTs a JSON-RPC `initialize` with
 * `protocolVersion: '2024-11-05'`, reads the `mcp-session-id` response header,
 * replays it on `tools/call`, and parses a `text/event-stream` body line by
 * line looking for `data: `. The MCP cases here drive `buildMcpServer` over
 * `InMemoryTransport`, so **none** of the session-header or SSE framing is
 * exercised: a change to the transport edge breaks `brain recall` and
 * `brain forget` with every assertion in this file still green. Pinning it
 * needs a test that speaks JSON-RPC over `worker.fetch` against `/mcp`; that is
 * a separate piece of work and it has not been done.
 *
 * Also unpinned, and smaller: the CLI's offline queue file format; `/list`'s
 * `tag`, `after`, `before` and `actor` parameters (the CLI sends none of them);
 * the exact wording of any error other than the layer 400 — `client.ts`'s
 * `request()` prints the whole body and parses nothing out of it.
 *
 * **This is a pin, not a behavioural change, and it did not fail before it was
 * written.** Every assertion below passed against the commit that introduced
 * it. The usual fails-before rule is satisfied by saying so here rather than by
 * inventing a change to make it red: the value of this block is entirely in the
 * future tense — it is the only thing in this tree that breaks when someone
 * renames `workspace`, narrows its enum, or rewords the 400, which is the one
 * failure mode a client in another repository cannot protect itself from.
 */
describe("the layer parameter every non-browser client depends on", () => {
  const LAYERS = ["personal", "company"];
  const WRONG_LAYER_ERROR = 'workspace must be "personal" or "company"';
  /** Every MCP tool the CLI's client.ts can pass a layer to. */
  const LAYERED_TOOLS = ["remember", "recall", "list_recent"];

  const mcpEnv = makeTestEnv(makeTestDb());

  async function inputSchemaFor(name: string): Promise<any> {
    let schema: any = {};
    await withMcpClient(mcpEnv, async (client) => {
      const { tools } = await client.listTools();
      schema = tools.find((t) => t.name === name)?.inputSchema ?? {};
    });
    return schema;
  }

  for (const tool of LAYERED_TOOLS) {
    it(`${tool} takes an optional workspace of exactly personal or company`, async () => {
      const schema = await inputSchemaFor(tool);
      const workspace = schema.properties?.workspace;
      expect(workspace, `${tool} has no workspace parameter`).toBeTruthy();
      // Sorted, so the pin is on the SET of accepted values: adding a third
      // layer here is a client-visible change and has to be a deliberate edit.
      expect([...(workspace.enum ?? [])].sort()).toEqual([...LAYERS].sort());
      // Optional, because omitting it is what every CLI installed before the
      // flag existed does, and that has to keep meaning "you decide".
      expect(schema.required ?? []).not.toContain("workspace");
    });
  }

  it("recall keeps the argument names the CLI sends alongside the layer", async () => {
    // `client.ts:recall()` builds `{ query, topK }` and adds `tag` — SINGULAR,
    // and only the first of the user's `-t` values. Both are pinned as SCHEMA
    // KEYS here: `topK`'s default was already pinned above, and `tag` was only
    // ever pinned as a word inside the tool's description, which a rename would
    // sail straight past.
    const schema = await inputSchemaFor("recall");
    expect(schema.properties?.query, "recall has no query").toBeTruthy();
    expect(schema.properties?.topK, "recall has no topK").toBeTruthy();
    expect(schema.properties?.tag, "recall has no `tag` — plural would break the CLI").toBeTruthy();
    expect(schema.required ?? []).toEqual(["query"]);
  });

  it("forget still takes the argument name the CLI passes an id under", async () => {
    // `client.ts:forget()` calls `mcpToolCall('forget', { id })`. Renaming this
    // to `entryId` reddens nothing else in this tree.
    const schema = await inputSchemaFor("forget");
    expect(schema.properties?.id, "forget has no `id`").toBeTruthy();
    expect(schema.required ?? []).toContain("id");
  });

  it("refuses a third layer name at the MCP boundary", async () => {
    await withMcpClient(mcpEnv, async (client) => {
      const outcome = await client
        .callTool({ name: "remember", arguments: { content: "x", workspace: "team" } })
        .then((r) => r, (e: unknown) => e);
      const text =
        outcome instanceof Error
          ? outcome.message
          : JSON.stringify((outcome as { content?: unknown }).content ?? outcome);
      // Either shape is a refusal; what must not happen is a silent accept.
      const refused = outcome instanceof Error || (outcome as { isError?: boolean }).isError === true;
      expect(refused, `workspace:"team" was accepted — ${text}`).toBe(true);
      expect(text).toMatch(/workspace/i);
    });
  });

  it("hands the CLI its address and token under the two key names it reads", () => {
    // The one cross-repo contract entirely inside this repository's control:
    // the desktop app WRITES ~/.config/second-brain/config.json and the CLI
    // READS it, and neither half can see the other. `config.ts:loadConfig()`
    // destructures `{ workerUrl, authToken }` and does no validation at all —
    // a rename here leaves `brain` fetching `undefined/capture` with
    // `Bearer undefined`, which is a 401 with no clue in it.
    //
    // Asserted against the writer's source because the writer is Rust and this
    // suite cannot run it. The Rust crate has its own round-trip test
    // (cli_config.rs), but that test lives on the other side of the same fence
    // as the CLI does, so this is the copy a person renaming things in this
    // repository will actually run.
    const writer = readFileSync(
      resolve(import.meta.dirname, "../../installer/src-tauri/src/cli_config.rs"),
      "utf8",
    );
    for (const key of ["workerUrl", "authToken"]) {
      expect(writer, `cli_config.rs no longer writes "${key}"`).toContain(`"${key}".to_string()`);
    }
  });

  describe("over HTTP, where the CLI actually writes and reads", () => {
    let sqlite: SqliteD1;
    let httpEnv: Env;
    let token = "";

    /** The member's token unless one is named — `/stats` is admin-gated. */
    const call = (method: string, path: string, body?: unknown, as?: string) =>
      worker.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${as ?? token}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        httpEnv,
        ctx,
      );

    /** `GET /list`, as the CLI reads it: a bare array of rows. */
    async function listRows(query: string): Promise<Record<string, any>[]> {
      const res = await call("GET", `/list${query}`);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as Record<string, any>[];
    }

    async function listLayers(query: string): Promise<{ id: string; workspace: string }[]> {
      return (await listRows(query)) as { id: string; workspace: string }[];
    }

    beforeEach(async () => {
      resetDatabaseInit();
      sqlite = makeSqliteD1();
      httpEnv = makeTestEnv(undefined, {
        DB: sqlite.db as unknown as Env["DB"],
        OAUTH_KV: makeMemoryKV(),
      });
      await initializeDatabase(httpEnv);
      await ensureTenantBootstrap(httpEnv);
      token = (await createMember(httpEnv, { name: "Cli User" })).token;
    });

    afterEach(() => sqlite?.close());

    it("stores a capture in the company layer when asked for it by name", async () => {
      const res = await call("POST", "/capture", {
        content: "Company: the release train leaves on Thursdays",
        tags: ["work"],
        source: "cli",
        workspace: "company",
      });
      const body = (await res.json()) as { ok: boolean; id: string };
      expect(res.status, JSON.stringify(body)).toBe(200);

      const company = await listLayers("?workspace=company");
      expect(company.map((r) => r.id)).toContain(body.id);
      expect(company.every((r) => r.workspace === "company")).toBe(true);
      // And it is genuinely elsewhere, not merely also here.
      expect((await listLayers("?workspace=personal")).map((r) => r.id)).not.toContain(body.id);
    });

    it("rejects any other layer name with the exact string the CLI prints", async () => {
      const res = await call("POST", "/capture", { content: "nope", workspace: "team" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(WRONG_LAYER_ERROR);
    });

    it("filters a listing to one layer and returns nothing from the other", async () => {
      const priv = (await (await call("POST", "/capture", { content: "Private: dentist Tuesday" })).json()) as { id: string };
      const shared = (await (await call("POST", "/capture", {
        content: "Company: on-call rota is weekly",
        workspace: "company",
      })).json()) as { id: string };

      expect((await listLayers("?workspace=company")).map((r) => r.id)).toEqual([shared.id]);
      expect((await listLayers("?workspace=personal")).map((r) => r.id)).toEqual([priv.id]);
      // Omitted, the parameter narrows nothing — which is the request every
      // already-installed CLI makes, and it has to keep returning both layers.
      expect(new Set((await listLayers("")).map((r) => r.id))).toEqual(new Set([priv.id, shared.id]));
    });

    it("gives back every field the CLI's Memory type declares", async () => {
      // `Memory` in client.ts is { id, content, tags, source, created_at }, and
      // `runList` prints all of them. snake_case on `created_at` specifically:
      // it is the one field name in the whole shape that a camelCase pass over
      // this repository would "tidy" without noticing anything downstream.
      const posted = (await (await call("POST", "/capture", {
        content: "Release train leaves Thursdays",
        tags: ["work", "process"],
        source: "cli",
      })).json()) as { id: string };

      const [row] = await listRows("");
      // `runList` prints id, content and created_at; `tags` and `source` are on
      // the declared type and are what `POST /capture` sent, so a rename of
      // either end silently drops them.
      for (const key of ["id", "content", "tags", "source", "created_at", "workspace"]) {
        expect(row, `/list rows no longer carry ${key}`).toHaveProperty(key);
      }
      expect(row.id).toBe(posted.id);
      expect(row.content).toBe("Release train leaves Thursdays");
      expect(row.source).toBe("cli");
      expect(row.workspace).toBe("personal");
      // The two capture body fields, read back off the row: without this they
      // are merely accepted, not honoured. `tags` arrives as the raw JSON
      // column rather than an array — the CLI's `Memory` type says `string[]`
      // and is wrong about it, which is harmless only because `runList` never
      // prints them. Pinned as it actually is, not as the type claims.
      expect(typeof row.tags, "tags is the raw JSON column").toBe("string");
      expect(JSON.parse(row.tags)).toEqual(expect.arrayContaining(["work", "process"]));
      // snake_case, and a real timestamp: `formatDate` does `new Date(…)` on it.
      expect(Number.isFinite(new Date(row.created_at).getTime())).toBe(true);
    });

    it("still narrows a listing with `n`, the parameter name the CLI builds", async () => {
      // `client.ts:list()` builds `/list?n=${limit}` — that is the whole of
      // `brain list --limit`. A rename to `limit` or `count` would leave this
      // route answering with its own default of 20 and nothing would look
      // broken until someone with more than 20 memories complained.
      for (const n of [1, 2, 3]) {
        await call("POST", "/capture", { content: `Memory number ${n}`, source: "cli" });
      }
      expect(await listRows("?n=2")).toHaveLength(2);
      expect(await listRows("?n=1")).toHaveLength(1);
      // And omitted, it does not narrow to one.
      expect((await listRows("")).length).toBe(3);
    });

    it("answers a duplicate with the two keys `brain remember` prints", async () => {
      // `runRemember` branches on `result.duplicate` and prints
      // `result.matchId`. Neither is on the success path, so nothing else in
      // this tree pins them for the CLI.
      const first = (await (await call("POST", "/capture", {
        content: "The on-call rota is weekly",
        source: "cli",
      })).json()) as { ok: boolean; id: string };
      expect(first.ok).toBe(true);
      expect(typeof first.id).toBe("string");

      // A near-exact match, which is the only thing that produces the blocked
      // shape. Swapped in after the first capture so the match points at a row
      // that really exists.
      httpEnv.VECTORIZE = makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: first.id, score: 0.97, metadata: { parentId: first.id } }],
        }),
      });
      const dup = (await (await call("POST", "/capture", {
        content: "The on-call rota is weekly",
        source: "cli",
      })).json()) as { ok: boolean; duplicate: boolean; matchId: string };
      expect(dup.ok).toBe(false);
      expect(dup.duplicate).toBe(true);
      expect(dup.matchId).toBe(first.id);
    });

    it("appends under the field name `addition`, and refuses any other", async () => {
      // `client.ts:append()` sends `{ id, addition: content }`. `addition` is
      // an unusual enough name to be a rename candidate, and it is entirely
      // unpinned anywhere else.
      const posted = (await (await call("POST", "/capture", {
        content: "Standup is at 9",
        source: "cli",
      })).json()) as { id: string };

      const ok = await call("POST", "/append", { id: posted.id, addition: "— moved to 9:30" });
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(((await ok.json()) as { ok: boolean; id: string }).id).toBe(posted.id);
      expect((await listRows(""))[0].content).toContain("9:30");

      // Named anything else it is a 400, not a silent no-op: a CLI that sent
      // the wrong key would otherwise report success and append nothing.
      const wrong = await call("POST", "/append", { id: posted.id, content: "— ignored" });
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { error: string }).error).toMatch(/addition/);
    });

    it("counts through `/count` with the key `brain setup` validates on", async () => {
      // `apiCount` is the request `brain setup` makes to decide whether the
      // address and token it was just given work at all. It reads `.count`.
      await call("POST", "/capture", { content: "One", source: "cli" });
      await call("POST", "/capture", { content: "Two", source: "cli" });
      const res = await call("GET", "/count");
      expect(res.status).toBe(200);
      expect((await res.json()) as { count: number }).toEqual({ count: 2 });
    });

    it("reports `/stats` under the three snake_case keys `brain stats` prints", async () => {
      // Admin-gated (requireAdmin), so this is the deployment's own token
      // rather than the member's — which is itself part of the contract: a
      // member running `brain stats` gets a 403, and that is deliberate.
      await call("POST", "/capture", { content: "A memory about hiring", tags: ["hiring"], source: "cli" });
      const res = await call("GET", "/stats", undefined, httpEnv.AUTH_TOKEN);
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      for (const key of ["count", "avg_importance", "top_tags"]) {
        expect(body, `/stats has no ${key}`).toHaveProperty(key);
      }
      expect(Array.isArray(body.top_tags)).toBe(true);
      expect(typeof body.count).toBe("number");
    });

    it("puts a capture with no workspace exactly where it always went", async () => {
      // The absence axis. A `brain remember` with no --workspace sends a body
      // byte-identical to the one it sent before the flag existed, and this is
      // the assertion that says so: personal, not the org default's business.
      const res = await call("POST", "/capture", {
        content: "Unlabelled: buy milk",
        tags: [],
        source: "cli",
      });
      const body = (await res.json()) as { id: string };
      expect((await listLayers("?workspace=personal")).map((r) => r.id)).toEqual([body.id]);
      expect(await listLayers("?workspace=company")).toEqual([]);
    });
  });
});
