/**
 * `list_recent({ actor })` — the same author filter `GET /list` has, spelled the
 * same way and resolved by the same function.
 *
 * An agent browsing a team brain reads an author on every shared row and, until
 * this parameter, could ask for none of them. The vocabulary is deliberately the
 * HTTP surface's: a display name exactly as the header prints it, a user id, or
 * `me` — so a model that has just read "· shared · Bob" can pass "Bob" back.
 *
 * Three things this file pins beyond the happy path:
 *
 *  - A name nobody on the caller's team answers to is a TEXT answer, not a
 *    thrown tool error. "No one on your team matches that" is a useful answer,
 *    and the tool's whole contract is a text answer.
 *  - An identity-less caller (direct construction in tests, pre-tenancy paths)
 *    ignores `actor` entirely: it has no roster to resolve against. Its output
 *    with `actor` set must equal its output without.
 *  - `list_recent({})` is byte-identical to what it printed before the parameter
 *    existed — the golden below was captured from the pre-task implementation
 *    against this exact fixture. The header, the snippet budget and the omitted
 *    note are unchanged in every case, including when `actor` is absent.
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
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const NOT_A_MEMBER = "actor must be a member of your team.";

/** Fixed timestamps, so the rendered headers are stable across runs. */
const T_BOB_SHARED = Date.UTC(2026, 2, 4, 12);
const T_ALICE_SHARED = Date.UTC(2026, 2, 3, 12);
const T_ALICE_PRIVATE = Date.UTC(2026, 2, 2, 12);
const T_BOB_PRIVATE = Date.UTC(2026, 2, 1, 12);

/** The one piece of rendering the golden may not hard-code: the reader's locale. */
const day = (ts: number) =>
  new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

let sqlite: SqliteD1;
let env: Env;
let alice: Identity;
let bobUserId = "";
let companyWorkspaceId = "";

async function withClient(identity: Identity | undefined, run: (c: Client) => Promise<void>) {
  const server = buildMcpServer(env, ctx, identity);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try { await run(client); } finally { await client.close(); }
}

/** `list_recent` as one person, returning exactly the text a client would read. */
async function listRecent(identity: Identity | undefined, args: Record<string, unknown>): Promise<string> {
  let text = "";
  await withClient(identity, async (client) => {
    const res: any = await client.callTool({ name: "list_recent", arguments: args });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    text = String(res.content[0].text);
  });
  return text;
}

function seed(id: string, workspaceId: string, actorId: string, content: string, createdAt: number) {
  return sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '["work"]', 'api', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, createdAt, createdAt, workspaceId, actorId)
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
  const roots = await ensureTenantBootstrap(env);
  companyWorkspaceId = roots.companyWorkspaceId;

  const madeAlice = await createMember(env, { name: "Alice" });
  const madeBob = await createMember(env, { name: "Bob" });
  alice = (await resolveIdentityFromToken(madeAlice.token, env))!;
  bobUserId = madeBob.member.userId;

  seed("bob-shared", companyWorkspaceId, bobUserId, "Company: on-call rota is weekly", T_BOB_SHARED);
  seed("alice-shared", companyWorkspaceId, alice.userId, "Company: releases ship behind a flag", T_ALICE_SHARED);
  seed("alice-private", alice.personalWorkspaceId, alice.userId, "Alice private: sabbatical plan", T_ALICE_PRIVATE);
  seed("bob-private", madeBob.member.personalWorkspaceId, bobUserId, "Bob private: gym on Tuesdays", T_BOB_PRIVATE);
});

afterEach(() => sqlite?.close());

describe("MCP list_recent — the actor filter", () => {
  it("lists only that person's shared memories when given their display name", async () => {
    const text = await listRecent(alice, { workspace: "company", actor: "Bob" });
    expect(text).toContain("Company: on-call rota is weekly");
    expect(text).not.toContain("Company: releases ship behind a flag");
  });

  it("resolves a user id to the same answer as the name", async () => {
    const byName = await listRecent(alice, { workspace: "company", actor: "Bob" });
    const byId = await listRecent(alice, { workspace: "company", actor: bobUserId });
    expect(byId).toBe(byName);
  });

  it("narrows to the caller's own memories for actor=me", async () => {
    const text = await listRecent(alice, { actor: "me" });
    expect(text).toContain("Alice private: sabbatical plan");
    expect(text).toContain("Company: releases ship behind a flag");
    expect(text).not.toContain("Company: on-call rota is weekly");
  });

  it("answers a stranger's name in text rather than throwing", async () => {
    expect(await listRecent(alice, { actor: "Nobody" })).toBe(NOT_A_MEMBER);
  });

  it("ignores actor entirely for an identity-less caller", async () => {
    // No identity means no roster to resolve against and no actor_id worth
    // trusting, so the argument changes nothing — including the name that would
    // be refused for a real member.
    const plain = await listRecent(undefined, { n: 10 });
    expect(await listRecent(undefined, { n: 10, actor: "Nobody" })).toBe(plain);
    expect(await listRecent(undefined, { n: 10, actor: "me" })).toBe(plain);
    expect(plain).toContain("Bob private: gym on Tuesdays");
  });

  it("prints exactly what it printed before the parameter existed when actor is absent", async () => {
    const expected = [
      `1. [${day(T_BOB_SHARED)} · api · shared · Bob [work]]`,
      `ID: bob-shared`,
      `Company: on-call rota is weekly`,
      ``,
      `2. [${day(T_ALICE_SHARED)} · api · shared · You [work]]`,
      `ID: alice-shared`,
      `Company: releases ship behind a flag`,
      ``,
      `3. [${day(T_ALICE_PRIVATE)} · api [work]]`,
      `ID: alice-private`,
      `Alice private: sabbatical plan`,
    ].join("\n");
    expect(await listRecent(alice, {})).toBe(expected);
  });
});
