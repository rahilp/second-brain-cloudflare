/**
 * The graph canvas has to draw the two-layer model, and until now it could not:
 * `buildGraph` projected `id, content, tags, importance_score, created_at` and
 * nothing about tenancy, so a shared node and a private one arrived
 * indistinguishable and no node said who wrote it. `GET /list` already answers
 * both questions; these cases pin `/graph` to the SAME vocabulary — `workspace`
 * as "personal" | "company" | "system", `actor_name` always present and null
 * where there is no author to name — rather than a second one.
 *
 * Driven against real SQLite through `worker.fetch`, like team-isolation.test.ts,
 * because the layer of a row and the reachability of a node are both properties
 * of the scope clause, which the string-matching D1 mock cannot evaluate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { GRAPH_VIEW_MAX_NODES } from "../../src/graph/traverse";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";
const SEEDED_AT = Date.now() - 3600_000;

let sqlite: SqliteD1;
let env: Env;
/**
 * Every statement the Worker prepared WITH the values it bound — the bindings
 * matter as much as the SQL here, because D1 rejects a statement carrying more
 * than D1_MAX_BOUND_PARAMS of them and that failure is invisible to node:sqlite.
 */
let calls: { sql: string; params: unknown[] }[];
/** KV reads, which share the Worker's subrequest budget with the D1 ones. */
let kvReads: string[];
const sqls = () => calls.map(c => c.sql);
let aliceToken = "";
let bobToken = "";
let aliceUserId = "";
let aliceWorkspaceId = "";
let bobUserId = "";
let bobWorkspaceId = "";
let companyWorkspaceId = "";

function call(path: string, token: string): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    env,
    ctx,
  );
}

const jsonOf = async (res: Response) => res.json() as Promise<any>;

/** Insert directly: the subject is which layer a node reports, not how it got there. */
function seed(id: string, workspaceId: string, actorId: string, content: string) {
  sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '[]', 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, SEEDED_AT, SEEDED_AT, workspaceId, actorId)
    .run();
}

/** buildGraph derives its node set from edges, so every node under test needs one. */
function seedEdge(sourceId: string, targetId: string, workspaceId: string, weight = 0.9) {
  sqlite.db
    .prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'relates_to', ?, 'explicit', '{}', 1, 1, ?)`,
    )
    .bind(`${sourceId}-${targetId}`, sourceId, targetId, weight, workspaceId)
    .run();
}

const nodeIds = (data: any) => (data.nodes as any[]).map(n => n.id).sort();
const nodeById = (data: any, id: string) => (data.nodes as any[]).find(n => n.id === id);

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  calls = [];
  kvReads = [];
  const DB = {
    prepare(sql: string) {
      const statement = sqlite.db.prepare(sql);
      const record = { sql: sql.replace(/\s+/g, " ").trim(), params: [] as unknown[] };
      calls.push(record);
      // Wrapped rather than spied so the bound values are recorded too; the
      // facade underneath still counts subrequests in `sqlite.issued`, where a
      // batch collapses to the one call the platform actually charges for.
      return {
        bind: (...params: unknown[]) => { record.params = params; return statement.bind(...params); },
        all: () => statement.all(),
        first: () => statement.first(),
        run: () => statement.run(),
      };
    },
    exec: (sql: string) => sqlite.db.exec(sql),
    batch: (sts: any[]) => sqlite.db.batch(sts),
  } as unknown as Env["DB"];
  const kv = makeMemoryKV();
  const countingKV = {
    ...kv,
    get: (key: string) => { kvReads.push(key); return kv.get(key); },
  } as unknown as KVNamespace;
  env = makeTestEnv(undefined, { DB, OAUTH_KV: countingKV });
  // The runtime-ALTER columns schema.sql leaves to init (updated_at among them).
  await initializeDatabase(env);

  const roots = await ensureTenantBootstrap(env);
  companyWorkspaceId = roots.companyWorkspaceId;
  // Two members, neither of them the bootstrap admin: the flag under test must
  // hold for an ordinary member, and an admin reads the legacy '' layer too.
  const alice = await createMember(env, { name: "Alice" });
  const bob = await createMember(env, { name: "Bob" });
  aliceToken = alice.token;
  bobToken = bob.token;
  aliceUserId = alice.member.userId;
  aliceWorkspaceId = alice.member.personalWorkspaceId;
  bobUserId = bob.member.userId;
  bobWorkspaceId = bob.member.personalWorkspaceId;
});

afterEach(() => sqlite?.close());

/**
 * Alice holds two private memories, Bob holds two he shared, Alice has one of
 * her own on the company layer, and Bob keeps one private that Alice must never
 * reach. Edges carry the workspace of their source entry, as moveEntry stamps.
 */
function seedTwoLayerBrain() {
  seed("a-mine", aliceWorkspaceId, aliceUserId, "Alice private: sabbatical plan");
  seed("a-mine2", aliceWorkspaceId, aliceUserId, "Alice private: sabbatical dates");
  seedEdge("a-mine", "a-mine2", aliceWorkspaceId);

  seed("b-shared", companyWorkspaceId, bobUserId, "Company: releases ship behind a flag");
  seed("b-shared2", companyWorkspaceId, bobUserId, "Company: flags are cleaned up quarterly");
  seedEdge("b-shared", "b-shared2", companyWorkspaceId);

  seed("a-shared", companyWorkspaceId, aliceUserId, "Company: on-call rota is weekly");
  seedEdge("a-shared", "b-shared", companyWorkspaceId);

  seed("b-private", bobWorkspaceId, bobUserId, "Bob private: interviewing elsewhere");
  seed("b-private2", bobWorkspaceId, bobUserId, "Bob private: recruiter call Thursday");
  seedEdge("b-private", "b-private2", bobWorkspaceId);
}

describe("GET /graph — layer and author on every node", () => {
  it("reports a colleague's shared node as company and names its author", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph", aliceToken));

    expect(nodeById(data, "b-shared")).toMatchObject({ workspace: "company", actor_name: "Bob" });
  });

  it("reports the caller's own private node as personal with no author to name", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph", aliceToken));

    // Not "Alice", and not absent: the key is always present so a client can
    // tell "nobody to name here" from "this deployment does not report authors".
    const mine = nodeById(data, "a-mine");
    expect(mine).toMatchObject({ workspace: "personal", actor_name: null });
    expect(Object.keys(mine)).toContain("actor_name");
  });

  it("labels the caller's own shared node 'You' — the viewer id reaches the resolver", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph", aliceToken));

    expect(nodeById(data, "a-shared")).toMatchObject({ workspace: "company", actor_name: "You" });
  });

  it("calls a pipeline-written shared node 'Second Brain', exactly as /list does", async () => {
    // resolveActorLabel decides this from `source`, and /list and /entry both
    // pass it. A canvas that named the member whose row the pipeline rewrote
    // would be the second vocabulary this whole task exists to prevent.
    //
    // The label is the product's own name (SYSTEM_ACTOR_LABEL): "System" named
    // a category, this names the writer. One constant in one function, which
    // is why both surfaces below move together and neither needed a change.
    seedTwoLayerBrain();
    sqlite.db.prepare(`UPDATE entries SET source = 'system' WHERE id = 'b-shared'`).run();

    const graph = await jsonOf(await call("/graph", aliceToken));
    const list = await jsonOf(await call("/list?n=50", aliceToken));

    expect(nodeById(graph, "b-shared").actor_name).toBe("Second Brain");
    expect(list.find((r: any) => r.id === "b-shared").actor_name).toBe("Second Brain");
  });

  it("still hides a colleague's private nodes", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph", aliceToken));

    expect(nodeIds(data)).not.toContain("b-private");
    expect(nodeIds(data)).not.toContain("b-private2");
  });
});

describe("GET /graph?workspace=", () => {
  it("narrows to the caller's personal layer alone", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph?workspace=personal", aliceToken));

    expect(nodeIds(data)).toEqual(["a-mine", "a-mine2"]);
    expect((data.nodes as any[]).every(n => n.workspace === "personal")).toBe(true);
    // The edges have to follow the nodes, or the canvas draws links to nothing.
    expect((data.edges as any[]).every(e => e.source.startsWith("a-mine") && e.target.startsWith("a-mine"))).toBe(true);
  });

  it("narrows to the company layer alone", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph?workspace=company", aliceToken));

    expect(nodeIds(data)).toEqual(["a-shared", "b-shared", "b-shared2"]);
    expect((data.nodes as any[]).every(n => n.workspace === "company")).toBe(true);
  });

  it("returns the union when the parameter is absent — unchanged from before", async () => {
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph", aliceToken));

    expect(nodeIds(data)).toEqual(["a-mine", "a-mine2", "a-shared", "b-shared", "b-shared2"]);
  });

  it("rejects any other value with the same 400 /list and /recall give", async () => {
    seedTwoLayerBrain();

    const res = await call("/graph?workspace=nonsense", aliceToken);

    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ ok: false, error: 'workspace must be "personal" or "company"' });
  });

  it("cannot be used to name a workspace the caller does not belong to", async () => {
    // The parameter takes a layer, never an id — both resolve from the identity,
    // so "company" as Bob can only ever be Bob's own company layer.
    seedTwoLayerBrain();

    const data = await jsonOf(await call("/graph?workspace=company", bobToken));

    expect(nodeIds(data)).toEqual(["a-shared", "b-shared", "b-shared2"]);
  });
});

describe("GET /graph author lookup cost", () => {
  it("names every author without a statement of its own", async () => {
    // The names arrive on the hydration the view was already issuing. Anything
    // matching `FROM users` that is NOT that statement is a second read, and on
    // this endpoint a second read is what has to stay impossible.
    for (let i = 0; i < 40; i++) {
      seed(`c${i}`, companyWorkspaceId, i % 2 ? bobUserId : aliceUserId, `Company memory ${i}`);
      if (i > 0) seedEdge(`c${i - 1}`, `c${i}`, companyWorkspaceId, 0.5 + i / 100);
    }

    calls = []; // the fixture's own bootstrap writes are not the subject
    const data = await jsonOf(await call("/graph", aliceToken));
    expect(data.nodes).toHaveLength(40);
    // The vocabulary still has to be /list's, or the cost saving cost the point.
    expect(new Set((data.nodes as any[]).map(n => n.actor_name))).toEqual(new Set(["You", "Bob"]));

    const touchingUsers = sqls().filter(s => /\busers\b/.test(s) && !/^UPDATE users/.test(s));
    expect(touchingUsers).toHaveLength(2); // the identity read, and the hydration join
    expect(touchingUsers.filter(s => s.includes("FROM entries e LEFT JOIN users u"))).toHaveLength(1);
  });

  it("costs a personal-only view exactly what it costs a view full of shared nodes", async () => {
    // The author names used to be a conditional extra statement, which made a
    // team brain cost one more than a personal one. Folded into the join, the
    // two are the same request — no branch, nothing to regress.
    for (let i = 0; i < 20; i++) {
      seed(`p${i}`, aliceWorkspaceId, aliceUserId, `Alice private memory ${i}`);
      if (i > 0) seedEdge(`p${i - 1}`, `p${i}`, aliceWorkspaceId, 0.9);
    }
    for (let i = 0; i < 20; i++) {
      seed(`c${i}`, companyWorkspaceId, bobUserId, `Company memory ${i}`);
      if (i > 0) seedEdge(`c${i - 1}`, `c${i}`, companyWorkspaceId, 0.9);
    }

    sqlite.issued.length = 0;
    const personal = await jsonOf(await call("/graph?workspace=personal", aliceToken));
    const personalCost = sqlite.issued.length;
    sqlite.issued.length = 0;
    const company = await jsonOf(await call("/graph?workspace=company", aliceToken));
    const companyCost = sqlite.issued.length;

    expect(personal.nodes).toHaveLength(20);
    expect(company.nodes).toHaveLength(20);
    expect((company.nodes as any[]).every(n => n.actor_name === "Bob")).toBe(true);
    expect(companyCost).toBe(personalCost);
  });

  it("binds no parameter per author, so a 120-author view cannot exceed D1's ceiling", async () => {
    // The bug this is here for cannot be reproduced by node:sqlite, which has no
    // bound-parameter limit: D1 caps a statement at D1_MAX_BOUND_PARAMS and
    // rejects the whole statement past it, so a lookup that binds one parameter
    // per distinct author turns a big-enough team's graph tab into a 500. The
    // property is therefore asserted on the BINDINGS, not on the result.
    const authors: string[] = [];
    for (let i = 0; i < 120; i++) {
      const member = await createMember(env, { name: `Member ${i}` });
      authors.push(member.member.userId);
    }
    for (let i = 0; i < 200; i++) {
      seed(`c${i}`, companyWorkspaceId, authors[i % authors.length], `Company memory ${i}`);
      if (i > 0) seedEdge(`c${i - 1}`, `c${i}`, companyWorkspaceId, 0.9);
    }

    calls = [];
    const data = await jsonOf(await call("/graph", aliceToken));

    expect(data.nodes).toHaveLength(200);
    // Not vacuous: the authors really are being named, all 120 of them.
    expect(new Set((data.nodes as any[]).map(n => n.actor_name)).size).toBe(120);
    const worst = Math.max(...calls.map(c => c.params.length));
    expect(worst).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    // Placeholders as well as bound values: the two agree or D1 errors anyway.
    expect(Math.max(...calls.map(c => (c.sql.match(/\?/g) ?? []).length))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });
});

describe("GET /graph subrequest budget", () => {
  /**
   * `n` entries alternating between Alice's personal layer and the company one,
   * chained by same-layer edges, inserted by two recursive CTEs — a per-row
   * INSERT from JS is what makes a 1600-row fixture slow, not SQLite.
   */
  function seedTwoLayerGraph(n: number) {
    sqlite.db.prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ${n})
       INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       SELECT 'n' || i, 'Memory ' || i, '[]', 'test', ${SEEDED_AT}, ${SEEDED_AT}, '[]',
              CASE i % 2 WHEN 0 THEN '${aliceWorkspaceId}' ELSE '${companyWorkspaceId}' END,
              CASE i % 2 WHEN 0 THEN '${aliceUserId}' ELSE '${bobUserId}' END
       FROM seq`,
    ).run();
    // Every edge joins two nodes of the same layer and is stamped with it, the
    // shape moveEntry leaves behind.
    for (const [prefix, offset, workspace] of [["pe", 0, aliceWorkspaceId], ["ce", 1, companyWorkspaceId]] as const) {
      sqlite.db.prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ${Math.floor(n / 2) - 1})
         INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
         SELECT '${prefix}' || i, 'n' || (i * 2 + ${offset}), 'n' || (i * 2 + 2 + ${offset}),
                'relates_to', 1.0 - (i / 100000.0), 'explicit', '{}', 1, 1, '${workspace}'
         FROM seq`,
      ).run();
    }
  }

  it("costs exactly this many subrequests at GRAPH_VIEW_MAX_NODES, and no more", async () => {
    // THE TOTAL, pinned. Everything else in this file pins a shape; this pins the
    // number the Workers free plan actually charges against its limit of 50 per
    // invocation, because until it existed nothing did — graph-read-budget.test.ts
    // asserts LIMITs and query plans, so a statement added anywhere in buildGraph
    // broke no test and the figure lived only in a comment.
    //
    // For a member (two scope bindings) at N = GRAPH_VIEW_MAX_NODES:
    //
    //   1   identity read + last_used_at stamp — ONE batch, therefore one subrequest
    //   1   strongest-edges scan
    //  16   node hydration, ceil(1500 / (100 - 2)) — authors included, via the join
    //  31   edge hydration, ceil(1500 / floor((100 - 2) / 2))
    //   1   KV read for the config
    //  ---
    //  50   total, which is the whole free-plan budget with nothing spare
    //
    // An admin costs one more of each hydration kind (three scope bindings, because
    // readableWorkspaces adds the legacy '' layer). Read a change to this number as
    // a decision to make, not a test to update: at 50 there is no headroom left, and
    // a cold isolate pays initializeDatabase's DDL on top (see #282).
    seedTwoLayerGraph(GRAPH_VIEW_MAX_NODES + 100);
    // Warm: the schema probe and the tenancy bootstrap are one-offs, and this is a
    // claim about a served request, not a cold isolate.
    await call("/graph?limit=1", aliceToken);
    sqlite.issued.length = 0;
    kvReads = [];

    const data = await jsonOf(await call("/graph", aliceToken));

    expect(data.nodes).toHaveLength(GRAPH_VIEW_MAX_NODES);
    // Both layers really are in the view, so the join is doing work.
    expect(new Set((data.nodes as any[]).map(n => n.workspace))).toEqual(new Set(["personal", "company"]));
    expect(sqlite.issued.length).toBe(49);
    expect(kvReads).toHaveLength(1);
    expect(sqlite.issued.length + kvReads.length).toBe(50);
  });
});
