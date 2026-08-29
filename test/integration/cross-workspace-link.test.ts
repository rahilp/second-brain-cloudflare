/**
 * An explicit link joins two memories in ONE layer, and the edge it writes lands
 * in that layer.
 *
 * Two things were wrong at once, and they compound.
 *
 * (1) Both `/link` call sites — `src/routes/graph.ts` and the MCP `link` tool —
 * called `createEdge` without a `workspaceId`, so `edgeInsertStatement` bound the
 * `""` default. `readableWorkspaces` hands `""` to admins only, so every link a
 * *member* created was written into a workspace that member cannot read: the edge
 * existed, `POST /link` answered 200, and the link was absent from their own graph
 * for good. A solo brain never noticed, because its owner is the admin.
 *
 * (2) With that fixed, an edge has to copy *a* workspace, and `edges.workspace_id`
 * is a single denormalized column taken from the source entry — `moveEntry`
 * re-stamps it to follow whichever endpoint moved. A link whose endpoints sit in
 * different workspaces therefore has no correct value at all:
 * it is guaranteed to go inconsistent, not merely unusual. So the pair is refused
 * at creation, with an instruction the user can act on, rather than written into a
 * layer where one endpoint will stop being visible.
 *
 * Real SQLite via `test/helpers/sqlite-d1.ts`: whether a scope clause actually
 * hides an edge row is a property of the SQL, and the string-matching d1-mock
 * ignores workspace bindings entirely, so a green mock proves nothing here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { CROSS_WORKSPACE_LINK_MESSAGE } from "../../src/graph/edges";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";

let sqlite: SqliteD1;
let env: Env;
let companyWorkspaceId = "";
/**
 * Alice is a plain member, not the bootstrap owner. That is load-bearing: the
 * owner is an admin, `readableWorkspaces` gives admins the `""` legacy space, and
 * an admin would therefore still have seen the mis-filed edges of bug (1). The
 * bug only shows against someone who cannot read `""` — which is every member of
 * a real team.
 */
let alice: { token: string; userId: string; personalWorkspaceId: string };
let bob: { token: string; userId: string; personalWorkspaceId: string };

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const jsonOf = (res: Response) => res.json() as Promise<any>;

function seed(id: string, workspaceId: string, actorId: string, content: string) {
  const now = Date.now() - 3600_000;
  sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '[]', 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, now, now, workspaceId, actorId)
    .run();
}

/** Every edges row touching the pair, whatever direction it was stored in. */
async function edgeRows(a: string, b: string): Promise<{ source_id: string; target_id: string; workspace_id: string }[]> {
  const { results } = await sqlite.db
    .prepare(
      `SELECT source_id, target_id, workspace_id FROM edges
       WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
    )
    .bind(a, b, b, a)
    .all();
  return results as { source_id: string; target_id: string; workspace_id: string }[];
}

/** The MCP `link`/`unlink` tools, driven through a real client as that member. */
async function viaMcp(token: string, tool: "link" | "unlink", args: Record<string, unknown>): Promise<string> {
  const identity = (await resolveIdentityFromToken(token, env))!;
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "link-client", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return (result.content as { type: string; text: string }[])[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  companyWorkspaceId = roots.companyWorkspaceId;

  const a = await createMember(env, { name: "Alice" });
  alice = { token: a.token, userId: a.member.userId, personalWorkspaceId: a.member.personalWorkspaceId };
  const b = await createMember(env, { name: "Bob" });
  bob = { token: b.token, userId: b.member.userId, personalWorkspaceId: b.member.personalWorkspaceId };

  seed("a-one", alice.personalWorkspaceId, alice.userId, "Alice private: the migration plan");
  seed("a-two", alice.personalWorkspaceId, alice.userId, "Alice private: why the migration slipped");
  seed("co-one", companyWorkspaceId, alice.userId, "Company: releases ship behind a flag");
  seed("co-two", companyWorkspaceId, bob.userId, "Company: on-call rotates Monday");
  seed("b-one", bob.personalWorkspaceId, bob.userId, "Bob private: interviewing elsewhere");
});

afterEach(() => sqlite?.close());

describe("an explicit link lands in the layer its endpoints live in", () => {
  it("stamps a member's own personal link with that member's workspace, not the legacy space", async () => {
    const res = await call("POST", "/link", alice.token, { source_id: "a-one", target_id: "a-two" });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, source_id: "a-one", target_id: "a-two", type: "relates_to" });

    const rows = await edgeRows("a-one", "a-two");
    expect(rows).toHaveLength(1);
    // "" is the legacy/system space. A member cannot read it, so an edge written
    // there is a link the person who made it can never see again.
    expect(rows[0].workspace_id).toBe(alice.personalWorkspaceId);
  });

  it("shows that link back to its author in GET /graph", async () => {
    // The user-visible half of the same bug: /link answered 200, and the link was
    // simply not in the graph, because buildGraph's edge scan is scoped.
    await call("POST", "/link", alice.token, { source_id: "a-one", target_id: "a-two" });

    const view = await jsonOf(await call("GET", "/graph", alice.token));
    expect(view.ok).toBe(true);
    expect(view.edges).toContainEqual(expect.objectContaining({ source: "a-one", target: "a-two" }));
    expect(view.nodes.map((n: any) => n.id).sort()).toEqual(["a-one", "a-two"]);
  });

  it("stamps a company-layer link with the company workspace", async () => {
    const res = await call("POST", "/link", alice.token, { source_id: "co-one", target_id: "co-two", type: "relates_to" });
    expect(res.status).toBe(200);

    const rows = await edgeRows("co-one", "co-two");
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(companyWorkspaceId);
  });
});

describe("a link across two layers is refused, not written", () => {
  it("POST /link answers 400 with an instruction and writes no edge", async () => {
    const res = await call("POST", "/link", alice.token, { source_id: "a-one", target_id: "co-one" });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({
      ok: false,
      error: "Both memories must be in the same workspace — move one into the other's workspace first",
      code: "cross_workspace_link",
    });
    expect(await edgeRows("a-one", "co-one")).toEqual([]);
  });

  it("refuses the company→personal direction too, so the rule does not depend on argument order", async () => {
    const res = await call("POST", "/link", alice.token, { source_id: "co-one", target_id: "a-one" });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).code).toBe("cross_workspace_link");
    expect(await edgeRows("co-one", "a-one")).toEqual([]);
  });

  it("the MCP link tool refuses the same pair, in the same words, and writes no edge", async () => {
    const text = await viaMcp(alice.token, "link", { source_id: "a-one", target_id: "co-one", type: "relates_to" });
    expect(text).toContain("same workspace");
    expect(text).toBe("Both memories must be in the same workspace — move one into the other's workspace first");
    expect(await edgeRows("a-one", "co-one")).toEqual([]);
  });

  it("keeps a colleague's private entry a 404 rather than leaking it as a layer mismatch", async () => {
    // The readability check runs first, so the refusal never becomes an oracle
    // for "this id exists in someone else's workspace".
    const res = await call("POST", "/link", alice.token, { source_id: "a-one", target_id: "b-one" });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error).toBe("No entry found with ID: b-one");
  });
});

describe("POST /link and the MCP link tool leave the database in the same state", () => {
  // The repo's REST/MCP parity convention (test/integration/update-parity.test.ts):
  // the two callers are one operation, so the assertion is that they agree, not
  // that each independently matches a spec.
  const CASES: { name: string; source: string; target: string; expectRows: (ws: () => string) => unknown }[] = [
    {
      name: "same personal layer",
      source: "a-one",
      target: "a-two",
      expectRows: (ws) => [{ source_id: "a-one", target_id: "a-two", workspace_id: ws() }],
    },
    {
      name: "same company layer",
      source: "co-one",
      target: "co-two",
      expectRows: () => [{ source_id: "co-one", target_id: "co-two", workspace_id: companyWorkspaceId }],
    },
    { name: "across two layers", source: "a-one", target: "co-one", expectRows: () => [] },
  ];

  it.each(CASES)("$name — both callers write the same edges rows", async ({ source, target, expectRows }) => {
    await call("POST", "/link", alice.token, { source_id: source, target_id: target });
    const afterHttp = await edgeRows(source, target);
    await sqlite.db.prepare(`DELETE FROM edges`).run();

    await viaMcp(alice.token, "link", { source_id: source, target_id: target, type: "relates_to" });
    const afterMcp = await edgeRows(source, target);

    expect(afterMcp).toEqual(afterHttp);
    expect(afterHttp).toEqual(expectRows(() => alice.personalWorkspaceId));
  });
});

describe("unlink still removes a stale cross-layer edge", () => {
  /**
   * Links made before this rule existed are exactly the rows a user most needs to
   * be able to delete, so `unlink` is deliberately unchanged: it gates on both
   * endpoints being readable and says nothing about their layers.
   */
  async function seedCrossLayerEdge() {
    await sqlite.db
      .prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
         VALUES ('stale-edge', 'a-one', 'co-one', 'relates_to', 1.0, 'explicit', '{}', 1, 1, ?)`,
      )
      .bind(alice.personalWorkspaceId)
      .run();
  }

  it("POST /unlink deletes it", async () => {
    await seedCrossLayerEdge();
    const res = await call("POST", "/unlink", alice.token, { source_id: "a-one", target_id: "co-one" });
    expect(res.status).toBe(200);
    // Asserted against the table rather than the reported count: the sqlite facade
    // reports rows_written, not D1's meta.changes, so the count is 0 here either way.
    expect(await edgeRows("a-one", "co-one")).toEqual([]);
  });

  it("the MCP unlink tool deletes it too", async () => {
    await seedCrossLayerEdge();
    await viaMcp(alice.token, "unlink", { source_id: "a-one", target_id: "co-one" });
    expect(await edgeRows("a-one", "co-one")).toEqual([]);
  });
});

/**
 * Task 15b. The same mis-filing as bug (1) above, on the path nobody links by
 * hand: when a capture wins a contradiction, `captureEntry` writes a `supersedes`
 * edge itself. That call passed no `workspaceId`, so `edgeInsertStatement` bound
 * the `""` default and the edge landed in the legacy/system space — which
 * `readableWorkspaces` grants to admins only. Every link the system inferred on a
 * member's own capture was therefore invisible to that member, exactly as their
 * hand-made links had been.
 *
 * Alice is a plain member for the reason given at the top of this file: an admin
 * reads `""` and would have seen the mis-filed edge anyway.
 */
describe("a link the system draws on capture lands in the capturer's own layer", () => {
  /**
   * A capture that supersedes an existing memory: the vector index answers with
   * `a-one` as a near neighbour, and the model calls it a contradiction the new
   * memory wins.
   */
  function contradictionEnv() {
    const sse = (text: string) => new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    env.VECTORIZE = makeVectorizeMock({
      // 0.9 is above DUPLICATE_FLAG_THRESHOLD and below DUPLICATE_BLOCK_THRESHOLD,
      // which is the band where the merge/contradiction model is consulted.
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "a-one", score: 0.9, metadata: { parentId: "a-one" } }],
      }),
    });
    env.AI = {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        return sse('{"action":"contradiction","conflicting_id":"a-one","reason":"plan changed"}');
      }),
    } as unknown as Ai;
  }

  async function supersedesEdge(): Promise<{ source_id: string; target_id: string; workspace_id: string } | null> {
    return await sqlite.db
      .prepare(`SELECT source_id, target_id, workspace_id FROM edges WHERE type = 'supersedes'`)
      .first() as { source_id: string; target_id: string; workspace_id: string } | null;
  }

  it("stamps the supersedes edge with the capturer's workspace, not the legacy space", async () => {
    contradictionEnv();

    const res = await call("POST", "/capture", alice.token, {
      content: "Alice private: the migration plan was cancelled",
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // The capture really did resolve a contradiction — otherwise there is no
    // system-drawn edge to be mis-filed and the assertion below proves nothing.
    expect(body.resolved_conflict).toBe("a-one");

    const edge = await supersedesEdge();
    // Direction is the claim: the new memory supersedes the one it corrected.
    expect(edge).toEqual({
      source_id: body.id,
      target_id: "a-one",
      workspace_id: alice.personalWorkspaceId,
    });
  });

  it("shows that inferred link back to the member in GET /graph", async () => {
    // The user-visible half: buildGraph's edge scan is scoped, so an edge in ""
    // is simply absent from the member's own graph however loudly capture
    // reported it.
    contradictionEnv();
    const body = await jsonOf(await call("POST", "/capture", alice.token, {
      content: "Alice private: the migration plan was cancelled",
    }));

    const view = await jsonOf(await call("GET", "/graph", alice.token));
    expect(view.ok).toBe(true);
    expect(view.edges).toContainEqual(expect.objectContaining({ source: body.id, target: "a-one" }));
    expect(view.nodes.map((n: any) => n.id).sort()).toEqual([body.id, "a-one"].sort());
  });

  it("stamps a company-layer capture's inferred link with the company workspace", async () => {
    // The stamp follows the WRITE TARGET, not the member — a capture the member
    // chose to share lands its edge on the company layer with the entry.
    contradictionEnv();
    env.VECTORIZE = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "co-one", score: 0.9, metadata: { parentId: "co-one" } }],
      }),
    });
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify('{"action":"contradiction","conflicting_id":"co-one","reason":"policy changed"}')}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    env.AI = {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        return sse;
      }),
    } as unknown as Ai;

    const body = await jsonOf(await call("POST", "/capture", alice.token, {
      content: "Company: releases now ship without a flag",
      workspace: "company",
    }));
    expect(body.resolved_conflict).toBe("co-one");

    expect(await supersedesEdge()).toEqual({
      source_id: body.id,
      target_id: "co-one",
      workspace_id: companyWorkspaceId,
    });
  });
});

/**
 * Task 15c. The refusal above used to read "share the personal one first",
 * which presumes one of the two endpoints is a personal workspace. Two reachable
 * shapes have no personal side at all:
 *
 *   - a member of TWO teams linking a team-A memory to a team-B one;
 *   - an admin linking a `""` legacy/system row to a personal one — no share
 *     moves an entry INTO `""`.
 *
 * Spec item 4.1 makes "introduce no new single-team assumption" a binding
 * negative requirement, and that sentence was one. One constant, so the two
 * surfaces cannot drift; asserted against all three shapes rather than the one
 * the sentence happened to describe.
 */
describe("the cross-workspace refusal is correct whichever two workspaces disagree", () => {
  const TEAM_B = "ws-team-b";
  /** The bootstrap owner, who is the only identity that can read `""`. */
  const ADMIN = "test-token";

  async function joinTeamB(userId: string) {
    await sqlite.db
      .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Platform', ?)`)
      .bind(TEAM_B, Date.now() + 1000).run();
    await sqlite.db
      .prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
      .bind(userId, TEAM_B, Date.now()).run();
  }

  const SHAPES: { name: string; setup: () => Promise<{ token: string; source: string; target: string }> }[] = [
    {
      name: "personal and company",
      setup: async () => ({ token: alice.token, source: "a-one", target: "co-one" }),
    },
    {
      name: "two company workspaces, neither of them personal",
      setup: async () => {
        await joinTeamB(alice.userId);
        seed("tb-one", TEAM_B, alice.userId, "Platform: the on-call handbook");
        return { token: alice.token, source: "co-one", target: "tb-one" };
      },
    },
    {
      name: "the legacy/system workspace and a personal one",
      setup: async () => {
        // Pre-tenancy rows sit in "". Nothing moves an entry INTO "", so
        // "share the personal one first" named a fix that does not exist here.
        const owner = await sqlite.db
          .prepare(`SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
                    JOIN users u ON u.id = m.user_id
                    WHERE w.kind = 'personal' AND u.role = 'admin'`)
          .first() as { id: string };
        seed("legacy-one", "", "", "A memory from before this brain had workspaces");
        seed("admin-one", owner.id, "", "Admin: this quarter's board pack");
        return { token: ADMIN, source: "legacy-one", target: "admin-one" };
      },
    },
  ];

  it.each(SHAPES)("POST /link refuses $name without assuming either side is personal", async ({ setup }) => {
    const { token, source, target } = await setup();
    const res = await call("POST", "/link", token, { source_id: source, target_id: target });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({
      ok: false,
      error: "Both memories must be in the same workspace — move one into the other's workspace first",
      code: "cross_workspace_link",
    });
    expect(await edgeRows(source, target)).toEqual([]);
  });

  it.each(SHAPES)("the MCP link tool refuses $name in the very same words", async ({ setup }) => {
    const { token, source, target } = await setup();
    const text = await viaMcp(token, "link", { source_id: source, target_id: target, type: "relates_to" });
    expect(text).toBe("Both memories must be in the same workspace — move one into the other's workspace first");
    expect(await edgeRows(source, target)).toEqual([]);
  });

  it("names no layer the pair does not have", async () => {
    // The regression in one line: the sentence must not tell a member of two
    // teams to share a personal memory that neither endpoint is.
    expect(CROSS_WORKSPACE_LINK_MESSAGE).not.toContain("personal");
  });
});
