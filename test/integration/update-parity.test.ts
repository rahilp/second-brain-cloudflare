/**
 * POST /update and the MCP `update` tool must leave the database in the SAME state.
 *
 * They were two implementations of one operation, and the MCP copy — the path every
 * assistant client actually calls — quietly drifted (#289): it committed content against
 * stale vectors when an embed failed, never moved updated_at, never reset the staleness
 * tags, and never extracted hashtags. Every one of those is invisible from the
 * MCP side alone; each only reads as a bug next to what the route does with the same
 * input. Nothing compared them, so nothing failed.
 *
 * So this suite does not assert what update *should* write. It runs each scenario through
 * both callers against the same starting row and asserts the resulting rows and vectors are
 * identical — then, separately, pins the handful of facts that both must satisfy so a
 * change that breaks them in both places is still caught. Add a scenario to CASES and both
 * callers are covered by construction.
 *
 * Real workerd D1 through Miniflare, not test/helpers/d1-mock. The mock matches query
 * strings, so it cannot tell a row that was written from one that was not — which is
 * exactly the distinction the fail-closed path turns on — and it has diverged from
 * production in this repo before, in both directions.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeAIMock, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

const ENTRY_ID = "x1";
/** Fixed, so the two runs of a scenario are byte-identical everywhere the code does not write. */
const SEEDED_AT = Date.parse("2024-01-17T00:00:00Z");

// ── The world both callers run against ──────────────────────────────────────────────────

/** Vectorize with real insert/upsert/delete semantics, so "what is indexed" is observable. */
function makeStatefulVectorize(seed: { id: string; content: string }[], overrides: Partial<VectorizeIndex> = {}) {
  const store = new Map<string, any>();
  for (const v of seed) store.set(v.id, { id: v.id, values: [], metadata: { content: v.content } });
  const index = makeVectorizeMock({
    insert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) if (!store.has(v.id)) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    upsert: vi.fn(async (vectors: any[]): Promise<any> => {
      for (const v of vectors) store.set(v.id, v);
      return { mutationId: "m" };
    }),
    deleteByIds: vi.fn(async (ids: string[]): Promise<any> => {
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    }),
    ...overrides,
  });
  return { store, index };
}

/** Workers AI that embeds normally, or refuses — a transient embed failure is one of these. */
function makeAI({ embedFails }: { embedFails: boolean }): Ai {
  if (!embedFails) return makeAIMock();
  return {
    run: vi.fn(async () => { throw new Error("AI binding overloaded"); }),
  } as unknown as Ai;
}

type World = {
  /** The entry as it exists before the update. */
  seed: {
    content: string;
    tags: string[];
    source?: string;
    vectorIds?: string[];
    createdAt?: number;
    updatedAt?: number | null;
  };
  /** What is in Vectorize before the update, keyed by vector id. */
  vectors?: { id: string; content: string }[];
  /** A single embed call fails, with the index itself healthy — #212's transient case. */
  embedFails?: boolean;
  /** describe() throws: Vectorize is not reachable at all — #270's keyword-only deployment. */
  vectorizeDown?: boolean;
  /** Retiring the orphaned vectors fails. Non-fatal: the content is already committed. */
  deleteFails?: boolean;
  /** A connected integration owns entries with this source, making them read-only. */
  connectedIntegration?: string;
};

// ── State capture ───────────────────────────────────────────────────────────────────────

type Snapshot = {
  row: Record<string, unknown> | null;
  vectors: { id: string; content: unknown }[];
};

/**
 * updated_at is Date.now(), so the two runs cannot produce the same number. Collapsing it
 * to a marker keeps the comparison meaningful while still failing when one caller writes it
 * and the other leaves it NULL — which is divergence (b), and the whole reason it is here.
 * Freshness is asserted separately, against the clock.
 */
function normalize(snapshot: Snapshot): Snapshot {
  if (!snapshot.row) return snapshot;
  const row = { ...snapshot.row };
  if (typeof row.updated_at === "number") row.updated_at = "<written>";
  return { ...snapshot, row };
}

describe("POST /update and the MCP update tool write identical state (#289)", () => {
  let mf: Miniflare;
  let d1: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "update-parity" },
    });
    d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    // The real migration, so the columns under test are the ones production has —
    // updated_at in particular is a runtime ALTER that db/schema.sql does not carry.
    resetDatabaseInit();
    await initializeDatabase({ DB: d1 } as Env);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  function makeEnv(world: World) {
    const { store, index } = makeStatefulVectorize(world.vectors ?? [], {
      ...(world.vectorizeDown ? { describe: vi.fn(async () => { throw new Error("no such index"); }) } : {}),
      ...(world.deleteFails ? { deleteByIds: vi.fn(async () => { throw new Error("delete failed"); }) } : {}),
    });
    const OAUTH_KV = makeMemoryKV();
    const env = {
      DB: d1,
      VECTORIZE: index,
      AI: makeAI({ embedFails: world.embedFails ?? world.vectorizeDown ?? false }),
      AUTH_TOKEN: "test-token",
      OAUTH_KV,
    } as unknown as Env;
    return { env, store, OAUTH_KV };
  }

  /**
   * A world, from scratch. Called once per caller, so the second run starts from exactly
   * the row the first one did rather than from what the first one left behind.
   */
  async function setUp(world: World) {
    await d1.prepare(`DELETE FROM entries`).run();
    const { env, store, OAUTH_KV } = makeEnv(world);
    if (world.connectedIntegration) {
      await OAUTH_KV.put(
        `integrations:${world.connectedIntegration}`,
        JSON.stringify({ provider: world.connectedIntegration, status: "connected", itemMap: {} }),
      );
    }
    const s = world.seed;
    await d1.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 3)`,
    ).bind(
      ENTRY_ID,
      s.content,
      JSON.stringify(s.tags),
      s.source ?? "claude",
      s.createdAt ?? SEEDED_AT,
      s.updatedAt ?? null,
      JSON.stringify(s.vectorIds ?? [ENTRY_ID]),
    ).run();
    return { env, store };
  }

  async function capture(store: Map<string, any>): Promise<Snapshot> {
    const row = await d1.prepare(`SELECT * FROM entries WHERE id = ?`).bind(ENTRY_ID).first();
    return {
      row: (row as Record<string, unknown> | null) ?? null,
      vectors: [...store.values()]
        .map(v => ({ id: v.id as string, content: v.metadata?.content }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /** POST /update, through the whole Worker. */
  async function viaHttp(world: World, content: string) {
    const { env, store } = await setUp(world);
    const res = await worker.fetch(req("POST", "/update", { body: { id: ENTRY_ID, content } }), env, ctx);
    const body = await res.json() as any;
    return { snapshot: await capture(store), status: res.status, reply: body.message ?? body.error ?? "" };
  }

  /** The MCP `update` tool, through a real MCP client and transport. */
  async function viaMcp(world: World, content: string) {
    const { env, store } = await setUp(world);
    const server = buildMcpServer(env, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: "update", arguments: { id: ENTRY_ID, content } });
      const reply = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      return { snapshot: await capture(store), reply };
    } finally {
      await client.close();
    }
  }

  // ── The scenarios ─────────────────────────────────────────────────────────────────────

  type Case = {
    name: string;
    world: World;
    content: string;
    /** Facts both callers must satisfy. Parity alone would pass if both were wrong. */
    expect: (snapshot: Snapshot) => void;
  };

  const tagsOf = (snapshot: Snapshot) => JSON.parse((snapshot.row!.tags as string) ?? "[]") as string[];

  const CASES: Case[] = [
    {
      name: "healthy re-index",
      world: { seed: { content: "I live in Berlin", tags: ["home"] }, vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }] },
      content: "I live in Lisbon",
      expect: (s) => {
        expect(s.row!.content).toBe("I live in Lisbon");
        // The vector the entry is keyed by holds the new text, not the old.
        expect(s.vectors).toEqual([{ id: ENTRY_ID, content: "I live in Lisbon" }]);
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([ENTRY_ID]);
      },
    },
    {
      name: "(b) staleness verdicts are cleared and updated_at moves",
      world: {
        seed: {
          content: "I live in Berlin",
          tags: ["home", "volatility:state", "stale:as-of"],
          updatedAt: SEEDED_AT,
        },
      },
      content: "I live in Lisbon",
      expect: (s) => {
        // The verdicts described the content that was just replaced. Left behind, recall
        // reports a seconds-old correction as years stale and hedges the answer built on it.
        expect(tagsOf(s)).toEqual(["home"]);
        // And a stationary updated_at leaves the row a permanent staleness-pass candidate,
        // so the tag comes straight back on the next nightly run.
        expect(s.row!.updated_at as number).toBeGreaterThan(Date.parse("2025-01-01T00:00:00Z"));
      },
    },
    {
      name: "(c) hashtags are extracted from the new content",
      world: { seed: { content: "I live in Berlin", tags: ["home"] } },
      content: "Moving to Lisbon #relocation",
      expect: (s) => {
        expect(s.row!.content).toBe("Moving to Lisbon");
        expect(tagsOf(s)).toEqual(["home", "relocation"]);
      },
    },
    {
      name: "(c) extraction flattens whitespace, including inside a fenced code block",
      world: { seed: { content: "old runbook", tags: ["ops"] } },
      content: "Runbook:\n\n1. drain\n2. deploy\n\n```sh\nnpm run deploy\n```\n\nTicket #4821",
      expect: (s) => {
        // Spelled out because it is destructive and, for the MCP path, new: the private copy
        // stored content verbatim. extractHashtags collapses every whitespace run to one
        // space and removes every #token unconditionally, so line breaks, list structure and
        // code fences do not survive a replacement, and a bare issue reference becomes a tag.
        // This is not a regression — captureEntry has always done it, so `remember` through
        // this same transport produces a byte-identical row, and POST /update already did it.
        // Divergence was the bug; this is what agreeing with the rest of the write path costs.
        //
        // `append` deliberately does NOT flatten: it embeds the addition verbatim after a
        // "[Update <date>]: " separator (src/capture/store.ts), so newlines survive there.
        // Reach for append, not update, when the text's shape matters.
        expect(s.row!.content).toBe("Runbook: 1. drain 2. deploy ```sh npm run deploy ``` Ticket");
        expect(tagsOf(s)).toEqual(["ops", "4821"]);
      },
    },
    {
      name: "a hashtag already held as a tag is not duplicated",
      world: { seed: { content: "Berlin flat", tags: ["home"] } },
      content: "Lisbon flat #home",
      expect: (s) => expect(tagsOf(s)).toEqual(["home"]),
    },
    {
      name: "content that is nothing but hashtags is kept verbatim",
      world: { seed: { content: "Berlin flat", tags: ["home"] } },
      content: "#lisbon",
      expect: (s) => {
        expect(s.row!.content).toBe("#lisbon");
        expect(tagsOf(s)).toEqual(["home", "lisbon"]);
      },
    },
    {
      name: "rolled-up is dropped: the digest marker it annotated is gone with the old content",
      world: { seed: { content: "Berlin flat\n\n[Digest: d9]", tags: ["home", "rolled-up"] } },
      content: "Lisbon flat",
      expect: (s) => {
        expect(tagsOf(s)).toEqual(["home"]);
        expect(s.row!.content).toBe("Lisbon flat");
      },
    },
    {
      name: "(a) a transient embed failure against a healthy index fails closed",
      world: {
        seed: { content: "I live in Berlin", tags: ["home"] },
        vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }],
        embedFails: true,
      },
      content: "I live in Lisbon",
      expect: (s) => {
        // Committing here would leave D1 saying Lisbon and Vectorize saying Berlin, with a
        // non-empty vector_ids — so /vectorize-pending and /stats.unvectorized, which both
        // select vector_ids = '[]', would never see it and recall would answer Berlin forever.
        expect(s.row!.content).toBe("I live in Berlin");
        expect(s.row!.updated_at).toBeNull();
        expect(s.vectors).toEqual([{ id: ENTRY_ID, content: "I live in Berlin" }]);
      },
    },
    {
      name: "Vectorize unreachable commits keyword-only and keeps the old index",
      world: {
        seed: { content: "I live in Berlin", tags: ["home"] },
        vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }],
        vectorizeDown: true,
      },
      content: "I live in Lisbon",
      expect: (s) => {
        // Keyword search reads entries.content, so the correction is still findable.
        expect(s.row!.content).toBe("I live in Lisbon");
        // The old vectors are the entry's only remaining semantic index — retiring them
        // would make it unsearchable rather than merely stale.
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([ENTRY_ID]);
        expect(s.vectors).toEqual([{ id: ENTRY_ID, content: "I live in Berlin" }]);
      },
    },
    {
      name: "a multi-chunk entry shrinking to one chunk retires only the orphan",
      world: {
        seed: { content: "long original", tags: ["work"], vectorIds: [ENTRY_ID, `${ENTRY_ID}-chunk-1`] },
        vectors: [
          { id: ENTRY_ID, content: "long original" },
          { id: `${ENTRY_ID}-chunk-1`, content: "long original tail" },
        ],
      },
      content: "short replacement",
      expect: (s) => {
        // The re-embed reuses the entry id, so that vector must survive its own cleanup.
        expect(s.vectors).toEqual([{ id: ENTRY_ID, content: "short replacement" }]);
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([ENTRY_ID]);
      },
    },
    {
      name: "a failed retirement of the orphaned vector does not undo the update",
      world: {
        seed: { content: "long original", tags: ["work"], vectorIds: [ENTRY_ID, `${ENTRY_ID}-chunk-1`] },
        vectors: [
          { id: ENTRY_ID, content: "long original" },
          { id: `${ENTRY_ID}-chunk-1`, content: "long original tail" },
        ],
        deleteFails: true,
      },
      content: "short replacement",
      expect: (s) => {
        // The new vectors are already in place, so the leftover orphan is a tidiness
        // problem, not a correctness one — rolling the content back would be worse.
        expect(s.row!.content).toBe("short replacement");
        expect(JSON.parse(s.row!.vector_ids as string)).toEqual([ENTRY_ID]);
      },
    },
    {
      name: "an entry owned by a connected integration is refused before anything is written",
      world: { seed: { content: "Synced page", tags: ["notion"], source: "notion" }, connectedIntegration: "notion" },
      content: "Hand-edited",
      expect: (s) => {
        expect(s.row!.content).toBe("Synced page");
        expect(s.row!.updated_at).toBeNull();
      },
    },
  ];

  it.each(CASES)("$name — both callers agree", async ({ world, content, expect: assertFacts }) => {
    const http = await viaHttp(world, content);
    const mcp = await viaMcp(world, content);

    expect(normalize(mcp.snapshot)).toEqual(normalize(http.snapshot));
    assertFacts(http.snapshot);
    assertFacts(mcp.snapshot);
  });

  it("a missing entry leaves both callers with nothing to write", async () => {
    const world: World = { seed: { content: "present", tags: [] } };

    const { env: httpEnv, store: httpStore } = await setUp(world);
    const res = await worker.fetch(req("POST", "/update", { body: { id: "nope", content: "x" } }), httpEnv, ctx);
    expect(res.status).toBe(404);
    const httpSnapshot = await capture(httpStore);

    const { env: mcpEnv, store: mcpStore } = await setUp(world);
    const server = buildMcpServer(mcpEnv, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    let reply = "";
    try {
      const result = await client.callTool({ name: "update", arguments: { id: "nope", content: "x" } });
      reply = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    } finally {
      await client.close();
    }

    expect(reply).toMatch(/No entry found with ID: nope/);
    expect(normalize(await capture(mcpStore))).toEqual(normalize(httpSnapshot));
  });

  // ── The replies, which are the one thing that legitimately differs ─────────────────────

  it("the MCP tool reports a failed re-index as a failure, not as a success", async () => {
    // It used to answer "Updated entry x1. Re-embedded as 0 vector(s)." on this path, which
    // reads as success and is what let a mis-indexed entry go unnoticed. The route already
    // 500s here; the tool now says the same thing in its own voice.
    const world: World = {
      seed: { content: "I live in Berlin", tags: ["home"] },
      vectors: [{ id: ENTRY_ID, content: "I live in Berlin" }],
      embedFails: true,
    };

    const http = await viaHttp(world, "I live in Lisbon");
    expect(http.status).toBe(500);
    expect(http.reply).toMatch(/Your memory is unchanged/);

    const mcp = await viaMcp(world, "I live in Lisbon");
    expect(mcp.reply).not.toMatch(/^Updated entry/);
    expect(mcp.reply).toMatch(/Your memory is unchanged/);
  });

  it("the MCP tool flags the keyword-only degrade instead of claiming a re-index", async () => {
    const mcp = await viaMcp(
      { seed: { content: "I live in Berlin", tags: ["home"] }, vectorizeDown: true },
      "I live in Lisbon",
    );
    expect(mcp.reply).toMatch(/Updated entry x1/);
    expect(mcp.reply).toMatch(/not re-indexed for semantic search/);
    expect(mcp.reply).toMatch(/wrangler vectorize create/);
  });

  it("the MCP tool still reports the vector count on the healthy path", async () => {
    const mcp = await viaMcp({ seed: { content: "I live in Berlin", tags: ["home"] } }, "I live in Lisbon");
    expect(mcp.reply).toBe("Updated entry x1. Re-embedded as 1 vector(s).");
  });
});
