/**
 * GET /stats/graph — the edge-quality baseline audit surface.
 *
 * Admin-only, and split: the edge-type aggregate is one grouped scan and always
 * runs, while the endpoint join, top-degree ranking and capture-gap histogram
 * each need their own pass over a table and only run behind ?deep=1. The split
 * is the point of the endpoint — an operator polling the cheap half must not be
 * paying for the expensive half.
 *
 * The scope assertions derive the admin's readable workspaces from the identity
 * rather than restating an id, so they still mean "what this caller may read"
 * if tenancy bootstrap ever changes the ids it mints.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { requireAdmin } from "../../src/lib/identity";
import { scopeWorkspaces } from "../../src/lib/scope";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";
const OUTSIDE = "ws-not-readable-by-anyone";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function get(path: string, token?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /stats/graph", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let memberToken = "";
  let readable: string[] = [];

  /** Edges are inserted directly: seed() has no workspace column and scope is what is under test. */
  function edge(id: string, source: string, target: string, type: string, workspaceId: string): void {
    sqlite.db
      .prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
         VALUES (?, ?, ?, ?, 0.5, 'inferred', '{}', 0, 0, ?)`,
      )
      .bind(id, source, target, type, workspaceId)
      .run();
  }

  /** entries.seed() has no workspace column, and workspace placement is under test. */
  function entry(id: string, createdAt: number, workspaceId: string): void {
    sqlite.db
      .prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, workspace_id)
         VALUES (?, ?, '[]', 'api', ?, ?, '[]', 0, 0, ?)`,
      )
      .bind(id, `entry ${id}`, createdAt, createdAt, workspaceId)
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
    await ensureTenantBootstrap(env);
    memberToken = (await createMember(env, { name: "Bob" })).token;

    const auth = await requireAdmin(get("/stats/graph", ADMIN), env);
    if (auth instanceof Response) throw new Error("admin fixture failed to authenticate");
    readable = scopeWorkspaces(auth);
  });

  afterEach(() => sqlite.close());

  it("rejects an unauthenticated caller with 401", async () => {
    const res = await worker.fetch(get("/stats/graph"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects a member who is not an admin with 403", async () => {
    const res = await worker.fetch(get("/stats/graph", memberToken), env, ctx);
    expect(res.status).toBe(403);
  });

  it("counts edges by type for an admin", async () => {
    edge("e1", "a", "b", "relates_to", readable[0]);
    edge("e2", "b", "c", "relates_to", readable[0]);
    edge("e3", "c", "d", "follows", readable[0]);

    const res = await worker.fetch(get("/stats/graph", ADMIN), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.edgeTypes).toEqual({ relates_to: 2, follows: 1 });
  });

  it("omits the deep sections unless ?deep=1 is asked for", async () => {
    edge("e1", "a", "b", "relates_to", readable[0]);

    const body = await (await worker.fetch(get("/stats/graph", ADMIN), env, ctx)).json() as any;
    expect(body.deep).toBe(false);
    expect(body.topDegree).toBeUndefined();
    expect(body.dangling).toBeUndefined();
    expect(body.gapBuckets).toBeUndefined();
  });

  // Inbound only: with a source-side fixture alone, dropping the target half of
  // the UNION ALL still reports the hub correctly.
  it("counts inbound edges towards a node's degree", async () => {
    entry("sink", 1000, readable[0]);
    edge("e1", "a", "sink", "relates_to", readable[0]);
    edge("e2", "b", "sink", "relates_to", readable[0]);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.topDegree[0]).toEqual({ id: "sink", degree: 2 });
  });

  it("ranks nodes by degree under ?deep=1", async () => {
    sqlite.seed({ id: "hub", content: "hub", createdAt: 1000 });
    sqlite.seed({ id: "leaf1", content: "leaf1", createdAt: 1001 });
    sqlite.seed({ id: "leaf2", content: "leaf2", createdAt: 1002 });
    edge("e1", "hub", "leaf1", "relates_to", readable[0]);
    edge("e2", "hub", "leaf2", "relates_to", readable[0]);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.deep).toBe(true);
    expect(body.topDegree[0]).toEqual({ id: "hub", degree: 2 });
  });

  it("counts an edge whose target has no entries row under ?deep=1", async () => {
    entry("real", 1000, readable[0]);
    edge("kept", "real", "real", "relates_to", readable[0]);
    edge("missing-target", "real", "deleted-entry", "relates_to", readable[0]);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.invalidEndpointEdges).toBe(1);
  });

  // The source side needs its own fixture: with only a missing-target case,
  // pointing both subqueries at target_id still returns the right number.
  it("counts an edge whose SOURCE has no entries row", async () => {
    entry("real", 1000, readable[0]);
    edge("missing-source", "deleted-entry", "real", "relates_to", readable[0]);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.invalidEndpointEdges).toBe(1);
  });

  // Caller-independent: an endpoint living in another workspace is a corrupt
  // edge whether or not this admin happens to read that workspace, so the
  // count must not depend on the caller's membership.
  it("counts an edge whose endpoint sits in a different workspace from the edge", async () => {
    entry("elsewhere", 1000, "ws-somewhere-else");
    edge("crossing", "elsewhere", "elsewhere", "relates_to", readable[0]);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.invalidEndpointEdges).toBe(1);
  });

  it("buckets the gaps between consecutive captures under ?deep=1", async () => {
    // One gap per bucket, accumulated rather than written out as absolute
    // timestamps so a bucket boundary cannot be mis-added by hand.
    const gaps = [2 * MINUTE, 20 * MINUTE, HOUR, 5 * HOUR, 3 * DAY, 30 * DAY];
    let at = 1_700_000_000_000;
    sqlite.seed({ id: "g0", content: "gap 0", createdAt: at });
    gaps.forEach((gap, i) => {
      at += gap;
      sqlite.seed({ id: `g${i + 1}`, content: `gap ${i + 1}`, createdAt: at });
    });

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.gapBuckets).toEqual({
      under5m: 1, under30m: 1, under2h: 1, under1d: 1, under7d: 1, older: 1,
    });
  });

  // Both workspaces are readable, so nothing here is about privacy: it is about
  // measuring the right population. `follows` is only ever drawn within one
  // workspace, so a gap between two workspaces is not a gap it could describe.
  it("measures capture gaps within a workspace, not across two readable ones", async () => {
    const t0 = 1_700_000_000_000;
    entry("a1", t0, readable[0]);
    entry("b1", t0 + 1 * MINUTE, "");
    entry("a2", t0 + 60 * MINUTE, readable[0]);
    entry("b2", t0 + 61 * MINUTE, "");

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    // Interleaved globally this reads as 1m/59m/1m; per workspace it is 60m twice.
    expect(body.gapBuckets).toEqual({
      under5m: 0, under30m: 0, under2h: 2, under1d: 0, under7d: 0, older: 0,
    });
  });

  // Each boundary lands in the HIGHER bucket, so < cannot drift to <=.
  it("puts a gap exactly on a boundary into the wider bucket", async () => {
    const t0 = 1_700_000_000_000;
    const bounds = [5 * MINUTE, 30 * MINUTE, 2 * HOUR, DAY, 7 * DAY];
    let at = t0;
    entry("b0", at, readable[0]);
    bounds.forEach((gap, i) => {
      at += gap;
      entry(`b${i + 1}`, at, readable[0]);
    });

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.gapBuckets).toEqual({
      under5m: 0, under30m: 1, under2h: 1, under1d: 1, under7d: 1, older: 1,
    });
  });

  it("never counts edges from a workspace the caller cannot read", async () => {
    // Well-formed: endpoint and edge share a workspace, so it is not counted
    // as invalid and the assertion below is about scope alone.
    entry("mine", 1000, readable[0]);
    sqlite.seed({ id: "theirs", content: "theirs", createdAt: 1001 });
    edge("in", "mine", "mine", "relates_to", readable[0]);
    // Same shape, higher degree, outside the caller's scope: it would top the
    // ranking and double the type count if the scope clause were dropped.
    edge("out1", "theirs", "mine", "relates_to", OUTSIDE);
    edge("out2", "theirs", "mine", "follows", OUTSIDE);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.edgeTypes).toEqual({ relates_to: 1 });
    expect(body.topDegree.map((n: any) => n.id)).not.toContain("theirs");
    // The deep aggregates are scoped too: the out-of-scope edges point at an
    // entry that does not exist, so an unscoped count would see them.
    expect(body.invalidEndpointEdges).toBe(0);
  });

  it("never measures capture gaps from a workspace the caller cannot read", async () => {
    const t0 = 1_700_000_000_000;
    entry("mine-1", t0, readable[0]);
    entry("mine-2", t0 + 10 * MINUTE, readable[0]);
    // A dense burst outside the caller's scope: it would dominate the histogram.
    for (let i = 0; i < 5; i++) entry(`theirs-${i}`, t0 + i * 1000, OUTSIDE);

    const body = await (await worker.fetch(get("/stats/graph?deep=1", ADMIN), env, ctx)).json() as any;
    expect(body.gapBuckets).toEqual({
      under5m: 0, under30m: 1, under2h: 0, under1d: 0, under7d: 0, older: 0,
    });
  });
});
