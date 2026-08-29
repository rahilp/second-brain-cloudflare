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
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";
const SEEDED_AT = Date.now() - 3600_000;

let sqlite: SqliteD1;
let env: Env;
/** Every statement the Worker prepared, so a conditional query can be proved absent. */
let statements: string[];
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
  it("issues no author query at all on a view with no company nodes", async () => {
    // The whole extra D1 read is conditional; a personal brain must cost exactly
    // what it did before this shipped.
    seed("a-mine", aliceWorkspaceId, aliceUserId, "Alice private: sabbatical plan");
    seed("a-mine2", aliceWorkspaceId, aliceUserId, "Alice private: sabbatical dates");
    seedEdge("a-mine", "a-mine2", aliceWorkspaceId);

    const data = await jsonOf(await call("/graph", aliceToken));
    expect(nodeIds(data)).toEqual(["a-mine", "a-mine2"]);

    expect(statements.filter(s => /SELECT id, name FROM users/.test(s))).toEqual([]);
  });

  it("resolves every author on a 40-node company view in ONE query", async () => {
    // The failure this guards against is a lookup per node: 40 shared nodes, two
    // authors, one statement.
    for (let i = 0; i < 40; i++) {
      seed(`c${i}`, companyWorkspaceId, i % 2 ? bobUserId : aliceUserId, `Company memory ${i}`);
      if (i > 0) seedEdge(`c${i - 1}`, `c${i}`, companyWorkspaceId, 0.5 + i / 100);
    }

    const data = await jsonOf(await call("/graph", aliceToken));
    expect(data.nodes).toHaveLength(40);
    expect(new Set((data.nodes as any[]).map(n => n.actor_name))).toEqual(new Set(["You", "Bob"]));

    expect(statements.filter(s => /SELECT id, name FROM users/.test(s))).toHaveLength(1);
  });
});
