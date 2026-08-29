/**
 * `GET /list?actor=` — the shared layer, browsable by author.
 *
 * The company layer prints who wrote every row and, until this filter, could be
 * narrowed by none of it: a member could see that Bob wrote nine of the last ten
 * shared memories and had no way to ask for Bob's. The filter accepts one
 * vocabulary with three spellings — a user id, a display name as printed in the
 * header, or `me` — and resolves all three to a single `actor_id = ?` predicate.
 *
 * Two properties carry the file, and both are about what the filter must NOT be
 * able to do:
 *
 * 1. It COMPOSES with the workspace scope and never widens it. `?actor=<bobId>`
 *    combined with `?workspace=personal` is an empty list, not Bob's rows — an
 *    actor filter that can reach a row the scope excluded is a cross-user leak.
 * 2. It resolves through `listRoster`, whose `memberships` join means a name or
 *    an id belonging to a team the caller is not in does not resolve at all. The
 *    cross-team cases assert a 400 rather than an empty list, because an empty
 *    list would confirm that person exists.
 *
 * The `me` path issues no lookup of any kind: it is the caller's own identity,
 * already resolved, so the statement trace for `?actor=me` is the trace for no
 * filter at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { buildEntryFilterQuery } from "../../src/capture/entry";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";
const NOT_A_MEMBER = "actor must be a member of your team";
/** A second company workspace, created after the bootstrap's, holding Carol alone. */
const TEAM_B = "ws-team-b";

let sqlite: SqliteD1;
let env: Env;
/** Every SQL statement prepared, whitespace-normalised, since the last reset. */
let statements: string[];

let aliceToken = "";
let bobToken = "";
let aliceUserId = "";
let bobUserId = "";
let carolUserId = "";

/** Alice's and Bob's rows, so assertions name entries rather than array indexes. */
let alicePrivate = "";
let aliceShared = "";
let bobPrivate = "";
let bobShared = "";

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

const jsonOf = async (res: Response) => res.json() as Promise<any>;

async function capture(token: string, content: string): Promise<string> {
  const res = await call("POST", "/capture", token, { content, tags: ["work"] });
  const body = await jsonOf(res);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.id as string;
}

async function share(token: string, id: string) {
  const res = await call("POST", "/share", token, { id, workspace: "company" });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** The ids `GET /list<query>` returns for `token`, in response order. */
async function listIds(token: string, query: string): Promise<string[]> {
  const res = await call("GET", `/list${query}`, token);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await jsonOf(res)) as any[]).map((r) => r.id as string);
}

/** The statements a single request prepares, isolated from every other request. */
async function statementsDuring(run: () => Promise<unknown>): Promise<string[]> {
  statements = [];
  await run();
  return [...statements];
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  statements = [];
  const DB = {
    prepare(sql: string) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return sqlite.db.prepare(sql);
    },
    exec: (sql: string) => sqlite.db.exec(sql),
    batch: (sts: any[]) => sqlite.db.batch(sts),
  } as unknown as Env["DB"];
  env = makeTestEnv(undefined, { DB, OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);

  const alice = await createMember(env, { name: "Alice" });
  const bob = await createMember(env, { name: "Bob" });
  aliceToken = alice.token;
  bobToken = bob.token;
  aliceUserId = alice.member.userId;
  bobUserId = bob.member.userId;

  // Carol is on the deployment but in a different team: createMember joins the
  // bootstrap company workspace, so she is moved out of it and into TEAM_B.
  const carol = await createMember(env, { name: "Carol" });
  carolUserId = carol.member.userId;
  await sqlite.db
    .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Team B', ?)`)
    .bind(TEAM_B, Date.now())
    .run();
  await sqlite.db.prepare(`DELETE FROM memberships WHERE user_id = ? AND workspace_id != ?`)
    .bind(carolUserId, carol.member.personalWorkspaceId).run();
  await sqlite.db.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
    .bind(carolUserId, TEAM_B, Date.now()).run();

  alicePrivate = await capture(aliceToken, "Alice private: sabbatical plan");
  aliceShared = await capture(aliceToken, "Company: releases ship behind a flag");
  await share(aliceToken, aliceShared);
  bobPrivate = await capture(bobToken, "Bob private: gym on Tuesdays");
  bobShared = await capture(bobToken, "Company: on-call rota is weekly");
  await share(bobToken, bobShared);
});

afterEach(() => sqlite?.close());

describe("GET /list?actor= — narrowing the shared layer by author", () => {
  it("returns only that person's shared rows when given their user id", async () => {
    expect(await listIds(aliceToken, `?workspace=company&actor=${bobUserId}`)).toEqual([bobShared]);
  });

  it("resolves a display name to the same single row as the user id", async () => {
    expect(await listIds(aliceToken, `?workspace=company&actor=Bob`)).toEqual([bobShared]);
  });

  it("matches a display name case-insensitively", async () => {
    expect(await listIds(aliceToken, `?workspace=company&actor=bob`)).toEqual([bobShared]);
  });

  it("narrows to the caller's own rows across both layers for actor=me", async () => {
    const ids = await listIds(aliceToken, `?actor=me`);
    expect(new Set(ids)).toEqual(new Set([alicePrivate, aliceShared]));
    expect(ids).not.toContain(bobShared);
    expect(ids).not.toContain(bobPrivate);
  });

  it("resolves actor=me with no lookup at all — the zero-query path", async () => {
    const withoutFilter = await statementsDuring(() => listIds(aliceToken, `?n=50`));
    const withMe = await statementsDuring(() => listIds(aliceToken, `?n=50&actor=me`));

    // Identity resolution reads `users` and `memberships` on every request; the
    // roster does too, and is told apart by its own three-column projection.
    // Nothing beyond what an unfiltered listing already costs may appear here.
    const roster = withMe.filter((s) => s.includes("u.name AS name"));
    expect(roster).toEqual([]);
    expect(withMe.length).toBe(withoutFilter.length);
  });

  it("rejects a name nobody on the team answers to", async () => {
    const res = await call("GET", `/list?workspace=company&actor=Nobody`, aliceToken);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ ok: false, error: NOT_A_MEMBER });
  });

  it("refuses a colleague from another team by name, rather than returning an empty list", async () => {
    const res = await call("GET", `/list?workspace=company&actor=Carol`, aliceToken);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe(NOT_A_MEMBER);
  });

  it("refuses a colleague from another team by user id — an empty list would confirm they exist", async () => {
    const res = await call("GET", `/list?workspace=company&actor=${carolUserId}`, aliceToken);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe(NOT_A_MEMBER);
  });

  it("composes with the workspace scope and never widens it", async () => {
    // Bob's rows exist and Alice may read the shared one — but not in her own
    // personal layer. The filter narrows what the scope allows; it cannot reach
    // past it.
    expect(await listIds(aliceToken, `?actor=${bobUserId}&workspace=personal`)).toEqual([]);
  });

  it("treats an empty actor parameter exactly as no parameter", async () => {
    expect(await listIds(aliceToken, `?actor=`)).toEqual(await listIds(aliceToken, ``));
  });

  it("costs no extra statement when no actor is given", async () => {
    // Four: identity resolution and its throttled last_used stamp (one batch,
    // two prepared statements), the listing itself, and one author-label lookup
    // for the company rows on the page. Pinned because the filter must be free
    // for every caller who does not use it.
    const traced = await statementsDuring(() => listIds(aliceToken, `?n=50`));
    expect(traced).toHaveLength(4);
    expect(traced.filter((s) => s.includes("FROM entries"))).toHaveLength(1);
  });
});

/**
 * The builder's own half of the same rule, one level below the route.
 *
 * `if (params.actor)` was a truthiness test, so an empty actor DROPPED the
 * predicate and returned the whole listing — the "filter that silently stops
 * filtering" the tag comment three lines above warns about. An empty actor
 * matches the legacy `''` actor_id rows and nothing else; that is a real answer,
 * and it is not "everything". Deciding that a blank filter means no filter is
 * the SURFACE's job, and both surfaces make that decision before they get here.
 */
describe("buildEntryFilterQuery — the actor predicate", () => {
  it("keeps filtering when the actor is the empty string", () => {
    const { sql, bindings } = buildEntryFilterQuery({ n: 10, actor: "" });
    expect(sql).toContain("actor_id = ?");
    expect(bindings).toEqual(["", 10]);
  });

  it("omits the predicate only when no actor was asked for", () => {
    const { sql, bindings } = buildEntryFilterQuery({ n: 10 });
    expect(sql).not.toContain("actor_id = ?");
    expect(bindings).toEqual([10]);
  });

  it("binds exactly one parameter for the actor, whatever else is filtered", () => {
    // The Phase 2 rule, pinned where it is easiest to break: one predicate, one
    // binding, never one per author.
    const { sql, bindings } = buildEntryFilterQuery({ n: 10, tag: "work", after: 1, before: 2, actor: "usr-bob" });
    expect(sql.match(/actor_id = \?/g)).toHaveLength(1);
    expect(bindings.filter((b) => b === "usr-bob")).toHaveLength(1);
  });
});
