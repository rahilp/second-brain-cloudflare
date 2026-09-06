/**
 * The three MCP tools that print a memory must agree about what it is.
 *
 * recall, list_recent and get each render a bracketed header, and each built its
 * own. They had drifted: recall showed the layer and its author, the other two
 * showed neither — so an agent that browsed with list_recent, or fetched a
 * memory in full with get before acting on it, could not tell a shared memory
 * from a private one, or who wrote it, while the same memory recalled a moment
 * earlier said both. list_recent also rendered tags as " · ops", the separator
 * the layer badge uses, so in the one tool that showed no layer a tag looked
 * exactly like one.
 *
 * They share `memoryHeader` now. These cases pin the four states a memory can be
 * in for a reader, across all three tools at once, because the failure mode is
 * not one tool being wrong — it is two tools disagreeing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };
let bob: { userId: string; personalWorkspaceId: string; token: string };

async function withClient(identity: Identity | undefined, run: (c: Client) => Promise<void>) {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { await run(client); } finally { await client.close(); }
}

const textOf = (res: any) => String(res.content[0].text);

/** The bracketed header for one memory, from each tool that prints one. */
async function headersFor(identity: Identity | undefined, id: string, query: string) {
  const out: Record<string, string> = {};
  await withClient(identity, async (client) => {
    const line = (text: string) =>
      text.split("\n").find((l) => l.includes(`ID: ${id}`))
        ? text.split("\n")[text.split("\n").findIndex((l) => l.includes(`ID: ${id}`)) - 1]
        : "";
    out.recall = line(textOf(await client.callTool({ name: "recall", arguments: { query, topK: 20 } })));
    out.list_recent = line(textOf(await client.callTool({ name: "list_recent", arguments: { n: 20 } })));
    out.get = textOf(await client.callTool({ name: "get", arguments: { id } })).split("\n")[0];
  });
  return out;
}

/** Strip the parts only recall prints, leaving the shared header. */
const core = (s: string) => s.replace(/^\d+\.\s*/, "").replace(/\]\s*\(\d+% match\).*$/, "]").trim();

function seed(id: string, workspaceId: string, actorId: string, content: string, tags: string[], source = "api") {
  const now = Date.now() - 3600_000;
  return sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, JSON.stringify(tags), source, now, now, workspaceId, actorId)
    .run();
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  const created = await createMember(env, { name: "Bob Chen" });
  bob = { userId: created.member.userId, personalWorkspaceId: created.member.personalWorkspaceId, token: created.token };
});

afterEach(() => sqlite?.close());

describe("a shared brain: every tool says the same thing about a memory", () => {
  beforeEach(async () => {
    seed("own-private", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Runbook lives in Notion", ["ops"]);
    seed("own-shared", roots.companyWorkspaceId, roots.ownerUserId, "Runbook policy for the team", ["ops"]);
    seed("their-shared", roots.companyWorkspaceId, bob.userId, "On-call rotates Monday", ["oncall"]);
    // The '' legacy/system space, which only an admin can read at all.
    seed("legacy", "", "", "A memory from before v3", ["legacy"]);
  });

  it("a memory the reader wrote and kept private carries no badge", async () => {
    const admin = (await resolveIdentityFromToken("test-token", env))!;
    const h = await headersFor(admin, "own-private", "Runbook Notion");
    expect(core(h.recall)).toBe(h.get);
    expect(core(h.list_recent)).toBe(h.get);
    expect(h.get).not.toContain("shared");
    expect(h.get).toContain("[ops]");
  });

  it("a memory the reader shared says so, and names them as the author", async () => {
    const admin = (await resolveIdentityFromToken("test-token", env))!;
    const h = await headersFor(admin, "own-shared", "Runbook policy team");
    expect(h.get).toContain(" · shared · You");
    expect(core(h.recall)).toBe(h.get);
    expect(core(h.list_recent)).toBe(h.get);
  });

  it("a colleague's shared memory names the colleague, in all three", async () => {
    const admin = (await resolveIdentityFromToken("test-token", env))!;
    const h = await headersFor(admin, "their-shared", "on-call rotates Monday");
    expect(h.get).toContain(" · shared · Bob Chen");
    expect(core(h.recall)).toBe(h.get);
    expect(core(h.list_recent)).toBe(h.get);
  });

  it("the same memory reads as the member's own when the member asks", async () => {
    // "You" is relative to the reader, so the one row has two correct answers.
    const member = (await resolveIdentityFromToken(bob.token, env))!;
    const h = await headersFor(member, "their-shared", "on-call rotates Monday");
    expect(h.get).toContain(" · shared · You");
    expect(core(h.list_recent)).toBe(h.get);
  });

  it("a legacy/system row is unbadged, and a member cannot see it at all", async () => {
    const admin = (await resolveIdentityFromToken("test-token", env))!;
    const h = await headersFor(admin, "legacy", "memory from before");
    expect(h.get).not.toContain("shared");

    const member = (await resolveIdentityFromToken(bob.token, env))!;
    await withClient(member, async (client) => {
      expect(textOf(await client.callTool({ name: "get", arguments: { id: "legacy" } })))
        .toContain("No entry found");
    });
  });

  it("tags never render with the separator the layer badge uses", async () => {
    // list_recent used to print " · ops" for a tag, which is exactly the shape of
    // " · shared" — indistinguishable in the one tool that showed no layer.
    const admin = (await resolveIdentityFromToken("test-token", env))!;
    const h = await headersFor(admin, "own-private", "Runbook Notion");
    for (const header of Object.values(h)) {
      expect(header).toContain("[ops]");
      expect(header).not.toContain("· ops");
    }
  });
});

describe("a personal brain: nothing is badged", () => {
  it("a solo owner sees no layer or author anywhere", async () => {
    // No members added, so every memory the owner holds is simply theirs. A badge
    // here would decorate 100% of every result and distinguish nothing.
    seed("solo", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Ship behind a flag", ["convention"]);
    const admin = (await resolveIdentityFromToken("test-token", env))!;
    const h = await headersFor(admin, "solo", "ship behind a flag");
    for (const header of Object.values(h)) {
      expect(header).not.toContain("shared");
      expect(header).not.toContain("You");
    }
    expect(core(h.recall)).toBe(h.get);
    expect(core(h.list_recent)).toBe(h.get);
  });
});


/**
 * The REST twins of those tools. GET /list and GET /recall return the same
 * memories to the dashboard and to the CLI, so a field that exists on one and
 * not the other is a client that has to special-case which endpoint it asked.
 */
describe("GET /list and GET /recall describe a memory the same way", () => {
  const call = (path: string, token: string) =>
    worker.fetch(
      new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
      ctx,
    );
  const jsonOf = (r: Response) => r.json() as Promise<any>;

  it("actor_name is on every row, null where there is no author to name", async () => {
    // It used to be added only to company rows, so the KEY's existence depended
    // on whether the page happened to contain a shared memory — and on a
    // personal brain it never appeared at all. A client could not tell "nobody
    // wrote this" from "this deployment does not report authors".
    seed("own-private", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Runbook lives in Notion", ["ops"]);
    seed("their-shared", roots.companyWorkspaceId, bob.userId, "On-call rotates Monday", ["oncall"]);

    const rows = await jsonOf(await call("/list?n=50", "test-token"));
    expect(rows.every((r: any) => "actor_name" in r)).toBe(true);
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    expect(byId["own-private"].actor_name).toBeNull();
    expect(byId["their-shared"].actor_name).toBe("Bob Chen");
  });

  it("a personal brain still carries the key, on every row", async () => {
    seed("solo", roots.ownerPersonalWorkspaceId, roots.ownerUserId, "Ship behind a flag", ["convention"]);
    const rows = await jsonOf(await call("/list?n=50", "test-token"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => "actor_name" in r && r.actor_name === null)).toBe(true);
  });

  it("both endpoints agree on the layer and the author for one memory", async () => {
    seed("their-shared", roots.companyWorkspaceId, bob.userId, "On-call rotates Monday", ["oncall"]);

    const listed = (await jsonOf(await call("/list?n=50", "test-token")))
      .find((r: any) => r.id === "their-shared");
    const recalled = (await jsonOf(await call("/recall?query=on-call%20rotates&topK=10&synthesize=false", "test-token")))
      .results.find((r: any) => r.id === "their-shared");

    expect(listed.workspace).toBe("company");
    expect(recalled.workspace).toBe("company");
    expect(listed.actor_name).toBe("Bob Chen");
    expect(recalled.actor_name).toBe("Bob Chen");
  });
});
