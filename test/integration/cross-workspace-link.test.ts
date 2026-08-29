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
 * re-stamps it `WHERE source_id = ?` alone. A link whose endpoints sit in
 * different layers therefore has no correct value the moment either end moves:
 * it is guaranteed to go inconsistent, not merely unusual. So the pair is refused
 * at creation, with an instruction the user can act on, rather than written into a
 * layer where one endpoint will stop being visible.
 *
 * Real SQLite via `test/helpers/sqlite-d1.ts`: whether a scope clause actually
 * hides an edge row is a property of the SQL, and the string-matching d1-mock
 * ignores workspace bindings entirely, so a green mock proves nothing here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken } from "../../src/lib/identity";
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
      error: "Both memories must be in the same layer — share the personal one first",
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
    expect(text).toContain("same layer");
    expect(text).toBe("Both memories must be in the same layer — share the personal one first");
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
