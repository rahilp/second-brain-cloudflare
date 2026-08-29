/**
 * A graph walk may not travel THROUGH a memory the caller cannot read.
 *
 * `expandGraph` scoped its `edges` scan but not the endpoints it derived from it:
 * every id on the far side of a readable edge became a candidate, whether or not
 * the `entries` row behind it was in the caller's readable set. No content leaked
 * — `getConnections` drops rows `hydrateGraphEntries` did not return, `buildGraph`
 * filters against its node set, and recall hydrates through a scoped query — so
 * hop 1 looked safe. Hop 2 was not: an unreadable node still entered the frontier,
 * and the walk continued out the other side of it. The result is a node set that
 * depends on a colleague's private memory. The reached node may itself be
 * perfectly readable; the *path* to it is the thing the caller was never entitled
 * to, and the edge structure it implies is inference drawn from a private row.
 *
 * Cross-layer edges are not hypothetical after Task 10 refuses new ones:
 *   - `moveEntry` re-stamps edges `WHERE source_id = ?`, so sharing one end of a
 *     link made before the share moves the EDGE into the company layer and leaves
 *     the far end personal. That is the "link then share" case below, driven
 *     through the real /link and /share routes rather than seeded.
 *   - `inferEdgesOnWrite` copies the SOURCE entry's workspace, so a company-layer
 *     capture whose nearest neighbour is someone's private memory writes a
 *     company-stamped edge to a personal row, with no explicit link involved.
 *
 * Real SQLite, because the subject is whether a scope clause hides a row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { buildGraph, expandGraph, getConnections } from "../../src/graph/traverse";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { recallEntries } from "../../src/recall/search";
import type { RecallDiagnostics } from "../../src/recall/types";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";

let sqlite: SqliteD1;
let env: Env;
let companyWorkspaceId = "";
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

const SEEDED_AT = Date.now() - 3600_000;

function seed(id: string, workspaceId: string, actorId: string, content: string) {
  return sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '[]', 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, SEEDED_AT, SEEDED_AT, workspaceId, actorId)
    .run();
}

/** An edges row with its workspace_id chosen explicitly — that column IS the subject. */
function seedEdge(sourceId: string, targetId: string, workspaceId: string) {
  return sqlite.db
    .prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'relates_to', 0.9, 'inferred', '{}', 1, 1, ?)`,
    )
    .bind(`${sourceId}--${targetId}`, sourceId, targetId, workspaceId)
    .run();
}

const identityFor = async (token: string): Promise<Identity> => (await resolveIdentityFromToken(token, env))!;

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
});

afterEach(() => sqlite?.close());

describe("a hop lands only on a node the caller may read", () => {
  beforeEach(async () => {
    // A (Alice) — B (Bob, private) — C (company), with BOTH edges stamped company:
    // exactly what a share leaves behind, since moveEntry re-stamps by source_id
    // and the far endpoint does not move with it.
    await seed("a-seed", alice.personalWorkspaceId, alice.userId, "Alice private: the Q3 pricing decision");
    await seed("b-mid", bob.personalWorkspaceId, bob.userId, "Bob private: my counter-offer numbers");
    await seed("co-far", companyWorkspaceId, bob.userId, "Company: pricing page copy freeze");
    await seedEdge("a-seed", "b-mid", companyWorkspaceId);
    await seedEdge("co-far", "b-mid", companyWorkspaceId);
  });

  it("expandGraph returns no candidate for a colleague's private row", async () => {
    // The hole itself. The A—B edge is readable (company-stamped); B is not.
    const out = await expandGraph(["a-seed"], { hops: 1 }, env, undefined, await identityFor(alice.token));
    expect(out.map(n => n.id)).toEqual([]);
  });

  it("GET /connections?id=a-seed as Alice returns nothing", async () => {
    const body = await jsonOf(await call("GET", "/connections?id=a-seed", alice.token));
    expect(body).toEqual({ ok: true, id: "a-seed", connections: [] });
  });

  it("a 2-hop GET /graph?seed=a-seed reaches neither Bob's row nor what lies beyond it", async () => {
    // co-far is a company memory Alice may read — that is the point. Before the
    // fix she received it here, and the only route to it was through b-mid, which
    // she may not read. Which nodes a walk reaches is itself information: it says
    // Bob's private memory connects these two.
    const view = await jsonOf(await call("GET", "/graph?seed=a-seed", alice.token));
    expect(view.ok).toBe(true);
    expect(view.nodes.map((n: any) => n.id)).toEqual(["a-seed"]);
    expect(view.edges).toEqual([]);
  });

  it("still reaches co-far for Bob, who can read the whole path", async () => {
    // The mirror case, so the fix is proven to be a scope check and not a blanket
    // "drop hop 2". Bob reads b-mid and co-far, and the a-seed edge is company-
    // stamped, so his walk from b-mid is unaffected.
    const view = await jsonOf(await call("GET", "/graph?seed=b-mid", bob.token));
    expect(view.nodes.map((n: any) => n.id).sort()).toEqual(["b-mid", "co-far"]);
  });
});

describe("link, then share: the walk the re-stamped edge used to allow", () => {
  /**
   * Spec 1.4's explicit case, driven through the real routes. Alice links two of
   * her own personal memories (legal — same layer), then shares one. moveEntry
   * moves the entry AND re-stamps `edges WHERE source_id = ?`, so the link is now
   * a company-layer edge pointing at a row that is still Alice's alone.
   */
  async function linkThenShare() {
    await seed("a-plan", alice.personalWorkspaceId, alice.userId, "Alice: rollout plan for the ledger migration");
    await seed("a-quote", alice.personalWorkspaceId, alice.userId, "Alice private: the vendor quote that decided it");
    await seed("co-note", companyWorkspaceId, bob.userId, "Company: quarterly vendor review notes");

    // Ids chosen so "a-plan" sorts before "a-quote": `relates_to` is symmetric, so
    // edgeInsertStatement stores the pair in lexical order, and moveEntry re-stamps
    // `WHERE source_id = ?`. Reverse the names and the share moves the entry while
    // leaving the edge behind in Alice's personal layer — a separate defect, and not
    // the one under test here.
    const linked = await call("POST", "/link", alice.token, { source_id: "a-plan", target_id: "a-quote" });
    expect(linked.status).toBe(200);
    const shared = await jsonOf(await call("POST", "/share", alice.token, { id: "a-plan" }));
    expect(shared.status).toBe("shared");

    // A second company-stamped edge on the far side of a-detail — an inferred one
    // this time (inferEdgesOnWrite copies the source's workspace), so hop 2 has
    // somewhere readable to land.
    await seedEdge("co-note", "a-quote", companyWorkspaceId);

    // Precondition: the share really did leave a company edge pointing at a
    // personal row. Without this the test could pass for the wrong reason.
    const { results } = await sqlite.db
      .prepare(`SELECT workspace_id FROM edges WHERE source_id = 'a-plan' AND target_id = 'a-quote'`)
      .all();
    expect(results).toEqual([{ workspace_id: companyWorkspaceId }]);
  }

  function recallEnvFor(seedId: string) {
    // Only the shared entry is a direct semantic hit; everything else must be
    // reached, or not, by the walk.
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: seedId, score: 0.95, metadata: { parentId: seedId, isUpdate: false } }],
        }),
      }),
    });
  }

  /**
   * Recall's own walk, with the node set it reached.
   *
   * `diagnostics.expandedIds` is what this task is about: not what recall printed
   * — recall's final hydration is scoped, so an unreadable row was always dropped
   * from the answer — but which nodes the traversal visited on the way, because
   * that is what decides where hop 2 can go.
   */
  async function walkFor(token: string) {
    const identity = await identityFor(token);
    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: "ledger migration rollout plan", topK: 20, hops: 2, synthesize: false },
      env,
      ctx,
      undefined,
      { identity, diagnostics },
    );
    return { reached: diagnostics.expandedIds ?? [], ids: result.matches.map(m => m.id) };
  }

  it("Bob's walk never enters the memory that stayed private, so it never leaves it either", async () => {
    await linkThenShare();
    recallEnvFor("a-plan");

    const bobWalk = await walkFor(bob.token);

    // a-quote is Alice's alone. It was reachable only because the edge — not the
    // entry — moved to the company layer when a-plan was shared.
    expect(bobWalk.reached).not.toContain("a-quote");
    // And co-note, which Bob may read perfectly well, is not reachable from here:
    // the only path to it runs through a-quote. Reaching it would tell Bob that
    // Alice's private memory connects the rollout plan to the vendor review.
    expect(bobWalk.reached).not.toContain("co-note");
    expect(bobWalk.reached).toEqual([]);

    // The answer itself: the shared memory, and nothing downstream of the private one.
    expect(bobWalk.ids).toContain("a-plan");
    expect(bobWalk.ids).not.toContain("a-quote");
    expect(bobWalk.ids).not.toContain("co-note");
  });

  it("Alice, who may read every step, still walks the whole path", async () => {
    // The control. Without it the fix could be "stop expanding at hop 2" and pass.
    await linkThenShare();
    recallEnvFor("a-plan");

    const aliceWalk = await walkFor(alice.token);
    expect(aliceWalk.reached).toEqual(expect.arrayContaining(["a-quote", "co-note"]));
  });
});

describe("what the readability filter must not change", () => {
  it("a caller with no Identity still reaches every neighbour, and pays no extra query", async () => {
    // The cron/backfill callers. Behaviour byte-identical to pre-tenancy, and the
    // subrequest count with it — expandGraph's budget is shared with the free
    // plan's 50-subrequest ceiling (see GRAPH_VIEW_MAX_NODES).
    await seed("x", "ws-one", "u1", "one");
    await seed("y", "ws-two", "u2", "two");
    await seedEdge("x", "y", "ws-two");

    const before = sqlite.issued.length;
    const out = await expandGraph(["x"], { hops: 1, includeDeprecated: true }, env);
    expect(out.map(n => n.id)).toEqual(["y"]);
    // One statement: the edge scan. No entries lookup, because there is nothing
    // to filter on when there is no identity and deprecated rows are wanted.
    expect(sqlite.issued.length - before).toBe(1);
  });

  it("a deprecated neighbour is still dropped for an identity-less caller", async () => {
    await seed("p", "ws-one", "u1", "one");
    await sqlite.db
      .prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id)
         VALUES ('q', 'two', ?, 'test', ?, '[]', 0, 0, 'ws-one', 'u1')`,
      )
      .bind(JSON.stringify(["status:deprecated"]), SEEDED_AT)
      .run();
    await seedEdge("p", "q", "ws-one");

    expect((await expandGraph(["p"], { hops: 1 }, env)).map(n => n.id)).toEqual([]);
    expect((await expandGraph(["p"], { hops: 1, includeDeprecated: true }, env)).map(n => n.id)).toEqual(["q"]);
  });

  it("costs one extra statement per hop, and only on the hop that had none", async () => {
    /**
     * Constraint 8, pinned. The readable check is folded into the statement the
     * deprecation check was already issuing, so the paths that ran it — recall's
     * walk, getConnections — pay nothing. The one that did not is buildGraph's
     * seed walk, which passes includeDeprecated and so skipped the query
     * entirely: 4 statements to 6, one per hop, measured against the free plan's
     * 50-subrequest ceiling that GRAPH_VIEW_MAX_NODES is sized for.
     */
    const owner = await identityFor("test-token");
    for (const id of ["g1", "g2", "g3"]) await seed(id, owner.personalWorkspaceId, owner.userId, `memory ${id}`);
    await seedEdge("g1", "g2", owner.personalWorkspaceId);
    await seedEdge("g2", "g3", owner.personalWorkspaceId);

    let before = sqlite.issued.length;
    await buildGraph({ seed: "g1" }, env, undefined, owner);
    // 2 edge scans + 2 readable/deprecated checks + node hydration + edge hydration.
    expect(sqlite.issued.length - before).toBe(6);

    before = sqlite.issued.length;
    await getConnections("g1", undefined, env, undefined, owner);
    // Unchanged: 1 edge scan + the check it already ran + hydration.
    expect(sqlite.issued.length - before).toBe(3);
  });

  it("a solo brain's owner walks their own graph exactly as before", async () => {
    // Backwards compatibility: on a brain with one person, every row shares one
    // workspace and the filter can never remove anything.
    const owner = await identityFor("test-token");
    await seed("s1", owner.personalWorkspaceId, owner.userId, "one");
    await seed("s2", owner.personalWorkspaceId, owner.userId, "two");
    await seed("s3", owner.personalWorkspaceId, owner.userId, "three");
    await seedEdge("s1", "s2", owner.personalWorkspaceId);
    await seedEdge("s2", "s3", owner.personalWorkspaceId);

    const out = await expandGraph(["s1"], { hops: 2 }, env, undefined, owner);
    expect(out.map(n => n.id)).toEqual(["s2", "s3"]);
  });
});
