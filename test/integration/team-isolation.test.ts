/**
 * Cross-user isolation, end to end through the Worker.
 *
 * `src/lib/scope.ts` states the house rule — "no unscoped corpus-wide query" —
 * and names this file as the thing that enforces it. The file did not exist, so
 * the rule was enforced by review alone, and one surface had already slipped
 * through: `GET /tags` scoped its D1 scan correctly but cached the result under a
 * single deployment-wide KV key, so whichever member rebuilt it last served their
 * tag vocabulary to everyone (`src/tags/vocabulary.ts`, now keyed per workspace).
 * A leak that reaches a response is worth a test that issues real requests, so
 * these drive `worker.fetch` against real SQLite rather than asserting on SQL.
 *
 * The shape throughout: two members of one brain, each holding a memory the other
 * must never see, and a third memory on the company layer that both must see.
 * Every read surface is asked the same question — can Bob reach Alice's row? —
 * and every write surface is asked whether Bob can change it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { resetVectorizeFilterState, vectorizeFilterState } from "../../src/vectorize/scope";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";

const ALICE = "test-token"; // the owner/admin, per makeTestEnv's AUTH_TOKEN
let bobToken = "";

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

let sqlite: SqliteD1;
let env: Env;
let ids: { alicePrivate: string; bobPrivate: string; shared: string };
let aliceUserId = "";
let aliceWorkspaceId = "";
let bobUserId = "";
let bobWorkspaceId = "";
let companyWorkspaceId = "";

/**
 * A pending pair for the insight queues. Inserted directly for the same reason
 * the entries are: the subject is who may read the pair, not how the accrual
 * pass found it.
 */
function seedCandidate(id: string, aId: string, bId: string, score: number) {
  sqlite.db
    .prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES (?, ?, ?, ?, 0, ?, 'vector', 'pending', ?)`,
    )
    .bind(id, aId, bId, score, score, SEEDED_AT)
    .run();
}

/**
 * An AI double for the nightly digest pass, recording every prompt it is given
 * so the ROWS a rollup was built from can be audited — the digest text alone
 * cannot show whether two workspaces were pooled.
 */
function digestAI(prompts: string[]): Ai {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream) {
        prompts.push(String(opts?.messages?.[0]?.content ?? ""));
        return sse("A digest paragraph covering the period.");
      }
      return { response: "3" };
    }),
  } as unknown as Ai;
}

/** An AI double that always reasons the pair into one given insight. */
function insightAI(text: string): Ai {
  const payload = JSON.stringify({ insight: true, shape: "throughline", text });
  return {
    run: vi.fn().mockResolvedValue(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    })),
  } as unknown as Ai;
}

/**
 * Insert directly: the unit under test is who can read the row, not how it got
 * there. Written as of an hour ago, not the epoch — /brief's topic query is
 * windowed on created_at, and epoch-dated rows fall outside it, which would make
 * the topic-chip assertion below pass against an empty list whether the query was
 * scoped or not.
 */
const SEEDED_AT = Date.now() - 3600_000;

function seed(id: string, workspaceId: string, actorId: string, content: string, tags: string[]) {
  sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, ?, 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, JSON.stringify(tags), SEEDED_AT, SEEDED_AT, workspaceId, actorId)
    .run();
}

beforeEach(async () => {
  resetDatabaseInit();
  // The filter-support latch is module-scoped, so a case that degrades it would
  // otherwise leave every later case in this file querying unfiltered.
  resetVectorizeFilterState();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  // Adds the runtime-ALTER columns (updated_at among them) that schema.sql leaves
  // to init, so recall's hydration and the seeds below have every column they read.
  await initializeDatabase(env);

  const roots = await ensureTenantBootstrap(env);
  const bob = await createMember(env, { name: "Bob" });
  bobToken = bob.token;

  aliceUserId = roots.ownerUserId;
  aliceWorkspaceId = roots.ownerPersonalWorkspaceId;
  bobUserId = bob.member.userId;
  bobWorkspaceId = bob.member.personalWorkspaceId;
  companyWorkspaceId = roots.companyWorkspaceId;

  ids = {
    alicePrivate: "e-alice",
    bobPrivate: "e-bob",
    shared: "e-shared",
  };
  seed(ids.alicePrivate, roots.ownerPersonalWorkspaceId, roots.ownerUserId,
    "Alice private: severance terms discussed with counsel", ["legal", "sensitive"]);
  seed(ids.bobPrivate, bob.member.personalWorkspaceId, bob.member.userId,
    "Bob private: interviewing elsewhere next week", ["job-hunting"]);
  seed(ids.shared, roots.companyWorkspaceId, roots.ownerUserId,
    "Company handbook: all releases ship behind a flag", ["handbook"]);

  // Two rows of Bob's that only the maintenance queues would ever surface.
  seed("bob-stale", bob.member.personalWorkspaceId, bob.member.userId,
    "Bob private: my therapist appointment is Tuesdays at 4", ["stale:as-of", "health"]);
  seed("bob-insight", bob.member.personalWorkspaceId, bob.member.userId,
    "Bob private insight: considering leaving the company", ["auto-insight"]);
});

afterEach(() => sqlite?.close());

describe("cross-user isolation — read surfaces", () => {
  it("GET /list shows a member their own rows and the company layer, never a colleague's", async () => {
    const mine = await jsonOf(await call("GET", "/list?n=50", bobToken));
    const contents = mine.map((e: any) => e.content as string);
    expect(contents).toEqual(expect.arrayContaining([
      expect.stringContaining("Bob private"),
      expect.stringContaining("Company handbook"),
    ]));
    expect(contents.join(" ")).not.toContain("Alice private");
  });

  it("GET /count counts only the readable set", async () => {
    // Bob: his three own rows (private, stale-flagged, pending insight) plus the
    // company row. Not Alice's.
    expect((await jsonOf(await call("GET", "/count", bobToken))).count).toBe(4);
  });

  it("GET /entry refuses a colleague's id outright", async () => {
    const res = await call("GET", `/entry?id=${ids.alicePrivate}`, bobToken);
    expect(res.status).toBe(404);
    // The company row is readable by both.
    expect((await call("GET", `/entry?id=${ids.shared}`, bobToken)).status).toBe(200);
  });

  it("GET /export backs up the member's readable set, not the deployment", async () => {
    const dump = await jsonOf(await call("GET", "/export", bobToken));
    const contents = dump.entries.map((e: any) => e.content as string).join(" ");
    expect(contents).toContain("Bob private");
    expect(contents).toContain("Company handbook");
    expect(contents).not.toContain("Alice private");
  });

  it("GET /tags never surfaces a colleague's vocabulary", async () => {
    // The regression this suite was written for: the scan was scoped, the cache
    // was not, so the first member to warm it served their tags to everyone.
    const bobTags = await jsonOf(await call("GET", "/tags", bobToken));
    expect(bobTags).toContain("job-hunting");
    expect(bobTags).toContain("handbook");
    expect(bobTags).not.toContain("legal");
    expect(bobTags).not.toContain("sensitive");

    const aliceTags = await jsonOf(await call("GET", "/tags", ALICE));
    expect(aliceTags).toContain("legal");
    expect(aliceTags).not.toContain("job-hunting");
  });

  it("GET /tags stays isolated whichever member warms the cache first", async () => {
    // Order is the whole mechanism of the original bug: with one shared key the
    // second caller was served whatever the first one's rebuild happened to leave
    // behind. Assert the exact set rather than the absence of two strings — under
    // the shared key the leaked value varied with which workspace's scan landed
    // last, so an absence check could pass by luck on a run that was still broken.
    await call("GET", "/tags", ALICE);
    expect(await jsonOf(await call("GET", "/tags", bobToken)))
      .toEqual(["auto-insight", "handbook", "health", "job-hunting", "stale:as-of"]);

    // And the reverse order, for the same reason.
    expect(await jsonOf(await call("GET", "/tags", ALICE)))
      .toEqual(["handbook", "legal", "sensitive"]);
  });

  it("GET /brief's topic chips name only the caller's own tags", async () => {
    // The Home screen renders `topics` straight into chips. This was the one query
    // in /brief's block without a scope clause, so a member's front page listed
    // colleagues' private tag names beside counts that came from scoped queries.
    const brief = await jsonOf(await call("GET", "/brief", bobToken));
    const tags = (brief.topics ?? []).map((t: any) => t.tag);
    // Positive first: an empty list would satisfy every negative below while
    // proving nothing, and the window this query applies makes that easy to hit.
    expect(tags).toEqual(expect.arrayContaining(["job-hunting", "handbook"]));
    expect(tags).not.toContain("legal");
    expect(tags).not.toContain("sensitive");

    const adminBrief = await jsonOf(await call("GET", "/brief", ALICE));
    expect((adminBrief.topics ?? []).map((t: any) => t.tag)).not.toContain("job-hunting");
  });

  it("GET /stats reports the admin's own content, and the deployment's repair backlog", async () => {
    // Two questions, two scopes. `brain stats` in the CLI prints top_tags under
    // "Top tags" and count under "Total memories", so both are content and are
    // scoped — an admin's terminal must not list a member's private tag names,
    // and the total must agree with the /count the same token gets.
    const stats = await jsonOf(await call("GET", "/stats", ALICE));
    expect(stats.top_tags).not.toContain("job-hunting");
    expect(stats.top_tags).toEqual(expect.arrayContaining(["legal", "sensitive"]));
    expect(stats.count).toBe((await jsonOf(await call("GET", "/count", ALICE))).count);

    // The repair counts stay corpus-wide: POST /vectorize-pending and
    // /classify-pending act on every workspace, so a scoped backlog would leave
    // rows unrepairable with nothing on screen to say so. Three entries exist.
    expect(stats.unclassified).toBe(5);
  });

  it("the admin's review queues never print a member's private memory", async () => {
    // The sharpest form of the rule: the SAME admin token gets a 404 from
    // /entry for these rows, and both queues were handing back their full text.
    // /stale prints the memory so it can be re-confirmed; /patterns prints an
    // insight drawn from the memories it cites. Neither is a licence to read a
    // colleague's personal workspace — nothing else in this codebase treats
    // "admin" that way.
    expect((await call("GET", "/entry?id=bob-stale", ALICE)).status).toBe(404);

    const stale = await jsonOf(await call("GET", "/stale", ALICE));
    expect(JSON.stringify(stale)).not.toContain("therapist");
    expect(stale.total).toBe(0);

    const patterns = await jsonOf(await call("GET", "/patterns", ALICE));
    expect(JSON.stringify(patterns)).not.toContain("leaving the company");
    expect(patterns.total).toBe(0);
  });

  it("GET /patterns never prints a source memory the caller cannot read", async () => {
    // The fourth leak of this shape, and the subtlest: the insight page itself is
    // scoped, and the `drawn_from` hydration below it constrains only
    // `e.source_id` — the ids of that scoped page. The content it RETURNS comes
    // from `e.target_id`, which nothing constrained, so an insight the admin may
    // read handed back the full text of the memory it was drawn from even when
    // that memory sits in a colleague's personal workspace.
    //
    // Alice's own insight, drawn from a memory of Bob's.
    seed("alice-drawn", aliceWorkspaceId, aliceUserId,
      "Alice insight: two threads about the same negotiation", ["auto-insight"]);
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('edge-1', 'alice-drawn', 'bob-source', 'drawn_from', 1, 'system', '{}', ?, ?, ?)`,
    ).bind(SEEDED_AT, SEEDED_AT, aliceWorkspaceId).run();
    seed("bob-source", bobWorkspaceId, bobUserId,
      "Bob private: my psychiatrist raised the lithium dose", ["health"]);

    const page = await jsonOf(await call("GET", "/patterns", ALICE));
    // The insight is hers and must still be listed.
    expect(page.patterns.map((p: any) => p.id)).toContain("alice-drawn");
    expect(JSON.stringify(page)).not.toContain("lithium");

    // An unreadable source reads exactly like a deleted one — the reviewer is
    // told the source is unavailable rather than shown a colleague's memory.
    const drawn = page.patterns.find((p: any) => p.id === "alice-drawn");
    expect(drawn.sources).toEqual([{ id: "bob-source", missing: true }]);

    // And a source she CAN read is still hydrated in full, or the fix would have
    // emptied the panel rather than scoped it.
    seed("alice-source", aliceWorkspaceId, aliceUserId,
      "Alice: the counterparty moved on the indemnity cap", ["deal"]);
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('edge-2', 'alice-drawn', 'alice-source', 'drawn_from', 1, 'system', '{}', ?, ?, ?)`,
    ).bind(SEEDED_AT, SEEDED_AT, aliceWorkspaceId).run();

    const again = await jsonOf(await call("GET", "/patterns", ALICE));
    const sources = again.patterns.find((p: any) => p.id === "alice-drawn").sources;
    expect(sources).toEqual(expect.arrayContaining([
      { id: "alice-source", content: "Alice: the counterparty moved on the indemnity cap" },
      { id: "bob-source", missing: true },
    ]));
  });

  it("the queues still show the caller their OWN flagged memories", async () => {
    // The guard must not empty the queue for the person it is built for.
    const stale = await jsonOf(await call("GET", "/stale", bobToken));
    expect(stale.total).toBe(1);
    expect(JSON.stringify(stale)).toContain("therapist");
  });

  it("POST /patterns/resolve cannot confirm or dismiss a member's insight", async () => {
    // Dismiss deprecates the row and drops its vectors; confirm promotes it into
    // recall. Both are writes into a workspace the caller cannot read.
    const res = await call("POST", "/patterns/resolve", ALICE, { id: "bob-insight", action: "dismiss" });
    expect(res.status).toBe(404);

    const tags = await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = 'bob-insight'`)
      .first() as { tags: string };
    expect(tags.tags).not.toContain("status:deprecated");
  });

  it("GET /graph draws only nodes the caller can read", async () => {
    const graph = await jsonOf(await call("GET", "/graph", bobToken));
    const nodeIds = (graph.nodes ?? []).map((n: any) => n.id);
    expect(nodeIds).not.toContain(ids.alicePrivate);
  });

  it("GET /insights/dry-run never previews a pair of a colleague's private memories", async () => {
    // The dry run reaches `entries` only through JOIN, which is how it escaped
    // the scope rule: two of Bob's personal memories paired by the accrual pass
    // put their full content through the model and their ids into the admin's
    // response. requireAdmin authorises the SURFACE — it is not a licence to
    // read a personal workspace, and the same token gets a 404 from /entry for
    // exactly these rows.
    seed("bob-pair-a", bobWorkspaceId, bobUserId,
      "Bob private: the custody hearing was moved to the eleventh", ["family"]);
    seed("bob-pair-b", bobWorkspaceId, bobUserId,
      "Bob private: retained a different solicitor for the custody matter", ["family"]);
    seedCandidate("cand-bob", "bob-pair-a", "bob-pair-b", 0.9);

    const res = await call("GET", "/insights/dry-run", ALICE);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.candidates).toEqual([]);
    const dump = JSON.stringify(body);
    expect(dump).not.toContain("custody");
    expect(dump).not.toContain("bob-pair-a");
    expect(dump).not.toContain("bob-pair-b");
  });

  it("GET /insights/dry-run still previews the admin's own pending pair", async () => {
    // The guard must narrow the preview, not empty it: the endpoint exists to
    // let its caller judge the ranking on their own data.
    seed("alice-pair-a", aliceWorkspaceId, aliceUserId,
      "Alice: quoted the retainer at nine hundred a month, flat", ["pricing"]);
    seed("alice-pair-b", aliceWorkspaceId, aliceUserId,
      "Alice: switched the retainer to hourly billing instead", ["pricing"]);
    seedCandidate("cand-alice", "alice-pair-a", "alice-pair-b", 0.8);

    const body = await jsonOf(await call("GET", "/insights/dry-run", ALICE));
    expect(body.candidates.map((c: any) => [c.a_id, c.b_id]))
      .toEqual([["alice-pair-a", "alice-pair-b"]]);
  });

  it("GET /insights/dry-run's novelty check never reads a colleague's pending insight", async () => {
    // The second, quieter half of the same leak: the comparison list the dry run
    // measures novelty against was every pending insight in the deployment. Bob's
    // private proposal is never printed, but it silently suppresses Alice's — an
    // admin is told her own candidate "restates a recently written insight" that
    // she cannot see and did not write. Suppression by an invisible row is still
    // a cross-workspace read.
    //
    // The two seeds share their whole distinctive vocabulary, which makes
    // reasonOverPair's asymmetric floor a no-op (see sharesVocabulary) so this
    // test turns on the novelty check alone.
    const twin = "Alice: quarterly kitesurfing bookkeeping deadlines collide";
    seed("alice-twin-a", aliceWorkspaceId, aliceUserId, twin, ["scheduling"]);
    seed("alice-twin-b", aliceWorkspaceId, aliceUserId, twin, ["scheduling"]);
    seedCandidate("cand-twin", "alice-twin-a", "alice-twin-b", 0.7);

    // Answers with text whose distinctive words are exactly those of the seeded
    // `bob-insight` row, so restatesRecent fires if — and only if — that row is
    // in the comparison list.
    env.AI = insightAI(
      "Considering leaving, that private company insight keeps returning to you.",
    );

    const body = await jsonOf(await call("GET", "/insights/dry-run", ALICE));
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].outcome).toBe("insight");
    expect(body.candidates[0].reason).toBe(null);
    expect(body.candidates[0].would_write).toBe(true);
  });

  it("GET /stats digest_candidates never names a colleague's private tag", async () => {
    // digest_candidates sits beside top_tags in the same response and top_tags is
    // already scoped, which is the tell: this one scanned every workspace, so an
    // admin's dashboard named a member's private topic — and its follow-up
    // "already digested?" existence check read the whole corpus too.
    //
    // Eleven rows because the candidate query keeps only tags with count > 10.
    for (let i = 0; i < 11; i++) {
      seed(`bob-topic-${i}`, bobWorkspaceId, bobUserId,
        `Bob private: divorce paperwork note ${i}`, ["divorce-paperwork"]);
    }

    const stats = await jsonOf(await call("GET", "/stats", ALICE));
    expect(stats.digest_candidates.map((c: any) => c.tag)).not.toContain("divorce-paperwork");

    // And the deployment-wide repair counter is deliberately NOT narrowed by this
    // change: /vectorize-pending acts on every workspace, so a scoped backlog
    // would leave Bob's rows unrepairable with nothing on screen to say so.
    // Five seeded rows plus the eleven above, none of them indexed.
    expect(stats.unvectorized).toBe(16);
  });
});

describe("cross-user isolation — write surfaces", () => {
  const denied = (status: number) => status === 403 || status === 404;

  it("POST /update cannot touch a colleague's private row", async () => {
    const res = await call("POST", "/update", bobToken, { id: ids.alicePrivate, content: "overwritten" });
    expect(denied(res.status)).toBe(true);
    const row = await sqlite.db.prepare(`SELECT content FROM entries WHERE id = ?`)
      .bind(ids.alicePrivate).first() as { content: string };
    expect(row.content).toContain("Alice private");
  });

  it("POST /append cannot touch a colleague's private row", async () => {
    const res = await call("POST", "/append", bobToken, { id: ids.alicePrivate, addition: "injected" });
    expect(denied(res.status)).toBe(true);
  });

  it("POST /forget cannot delete a colleague's private row", async () => {
    const res = await call("POST", "/forget", bobToken, { id: ids.alicePrivate });
    expect(denied(res.status)).toBe(true);
    const still = await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE id = ?`)
      .bind(ids.alicePrivate).first() as { n: number };
    expect(still.n).toBe(1);
  });

  it("POST /status cannot deprecate a colleague's private row", async () => {
    const res = await call("POST", "/status", bobToken, { id: ids.alicePrivate, status: "deprecated" });
    expect(denied(res.status)).toBe(true);
  });

  it("POST /share cannot publish a colleague's private row to the company", async () => {
    const res = await call("POST", "/share", bobToken, { id: ids.alicePrivate, workspace: "company" });
    expect(denied(res.status)).toBe(true);
  });

  it("a member cannot edit or un-share a company row they did not author", async () => {
    // Shared is not freely editable: the author or an admin, nobody else.
    expect((await call("POST", "/update", bobToken, { id: ids.shared, content: "rewritten" })).status).toBe(403);
    expect((await call("POST", "/forget", bobToken, { id: ids.shared })).status).toBe(403);
    expect((await call("POST", "/share", bobToken, { id: ids.shared, workspace: "personal" })).status).toBe(403);
  });

  it("POST /link cannot bridge into a colleague's private row", async () => {
    const res = await call("POST", "/link", bobToken, { source_id: ids.bobPrivate, target_id: ids.alicePrivate });
    expect(res.status).toBe(404);
  });
});

describe("cross-user isolation — administration", () => {
  it("every /team administration route is admin-only", async () => {
    for (const [method, path, body] of [
      ["GET", "/team/members", undefined],
      ["POST", "/team/members", { name: "Mallory" }],
      ["POST", "/team/members/suspend", { userId: "x", suspended: true }],
      ["POST", "/team/members/remove", { userId: "x" }],
      ["POST", "/team/members/token", { userId: "x" }],
      ["POST", "/team/members/default-share", { userId: "x", defaultShare: "company" }],
    ] as const) {
      const res = await call(method, path, bobToken, body);
      expect([res.status, path]).toEqual([403, path]);
    }
  });

  it("a suspended member resolves to no identity at all", async () => {
    await sqlite.db.prepare(`UPDATE users SET suspended = 1 WHERE name = 'Bob'`).run();
    expect((await call("GET", "/list", bobToken)).status).toBe(401);
  });
});

/**
 * The matrix above asks whether one member can reach another's rows through a
 * REQUEST. These ask the same question of the machinery that runs with no
 * request at all: the nightly cron, the repair routes, and the paged review
 * queues, where isolation has to hold without an identity to scope by.
 *
 * A single-workspace brain is the case every one of these must not change, so
 * each asserts the positive too — the pass still does its work, the repair
 * routes still repair every workspace.
 */
describe("cross-user isolation — maintenance passes", () => {
  // The nightly trigger from wrangler.jsonc. Routed by string in src/index.ts:
  // the integration and insight crons get their own invocation and budget, and
  // everything else falls through to maintenance.
  const NIGHTLY_CRON = "0 1 * * *";

  it("drives the cron string wrangler.jsonc actually schedules", () => {
    // The routing in src/index.ts is by string, and a cron this file no longer
    // matches falls through to maintenance anyway — so a stale constant here
    // would keep every case below green while testing a trigger that no longer
    // exists. Pinned to the deployment config rather than to a copy of it.
    const wrangler = readFileSync(resolve(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
    expect(wrangler).toContain(`"${NIGHTLY_CRON}"`);
  });

  /**
   * A Vectorize double that answers the way a real, unfiltered index answers:
   * every seeded near-duplicate is a strong neighbour of every other, whichever
   * workspace it lives in. src/graph/pass.ts queries with no filter, so this is
   * the honest double — the default mock returns no matches at all, which would
   * let the two cases below pass without the pass ever having had the chance to
   * bridge two workspaces.
   */
  /**
   * A Vectorize double that APPLIES the metadata filter rather than only
   * noticing that one is present.
   *
   * That distinction is what let a real regression through: doubles which only
   * checked `if (opts.filter)` were green against a pass that filtered on a
   * field the vectors did not carry.
   *
   * `workspaceId: undefined` models a vector with NO `workspace_id` metadata at
   * all — an entry indexed before src/capture/store.ts started stamping it. Such
   * vectors are the normal case on an upgraded brain: tenancy bootstrap
   * backfills the `entries` ROWS (src/lib/tenancy.ts) but never restamps their
   * vectors, so the row has a real workspace and the vector has none.
   *
   * `absentFieldMatches` is the thing about Vectorize this repo cannot verify
   * locally — `vectorize` has no local emulation (wrangler binds it "remote"),
   * and neither the type declarations nor the docs in this repo say whether an
   * absent field satisfies `$in`. Both readings are therefore modelled, and the
   * cases below are asserted under each.
   */
  function indexDouble(opts: {
    vectors: { id: string; workspaceId?: string; score: number }[];
    absentFieldMatches: boolean;
    rejectFilters?: boolean;
  }): VectorizeIndex {
    return {
      ...env.VECTORIZE,
      query: vi.fn().mockImplementation(async (_values: number[], o: any) => {
        if (o?.filter && opts.rejectFilters) {
          throw new Error("VECTORIZE_QUERY_ERROR (code = 40006): unsupported metadata filter");
        }
        const wanted: string[] | undefined = o?.filter?.workspace_id?.$in;
        const matches = opts.vectors
          .filter(v => {
            if (!wanted) return true;
            if (v.workspaceId === undefined) return opts.absentFieldMatches;
            return wanted.includes(v.workspaceId);
          })
          .map(v => ({
            id: v.id,
            score: v.score,
            metadata: {
              parentId: v.id,
              ...(v.workspaceId === undefined ? {} : { workspace_id: v.workspaceId }),
            },
          }));
        return { matches };
      }),
    } as unknown as VectorizeIndex;
  }

  /**
   * Alice's and Bob's near-identical rows as each other's nearest neighbour,
   * both vectors stamped — the shape a brain written entirely after stamping has.
   */
  const crossWorkspaceVectorize = (absentFieldMatches = true) => indexDouble({
    absentFieldMatches,
    vectors: [
      { id: "alice-link", workspaceId: aliceWorkspaceId, score: 0.97 },
      { id: "bob-link", workspaceId: bobWorkspaceId, score: 0.96 },
    ],
  });

  /**
   * The same index, but one that REJECTS the workspace metadata filter — the
   * documented degraded mode of `queryVectorizeScoped`, which retries unfiltered
   * and latches that per isolate.
   */
  const filterRejectingVectorize = () => indexDouble({
    absentFieldMatches: true,
    rejectFilters: true,
    vectors: [
      { id: "alice-link", workspaceId: aliceWorkspaceId, score: 0.97 },
      { id: "bob-link", workspaceId: bobWorkspaceId, score: 0.96 },
    ],
  });

  /** Two of Alice's own rows as each other's nearest neighbour. */
  const sameWorkspaceVectorize = (rejectFilters: boolean) => indexDouble({
    absentFieldMatches: true,
    rejectFilters,
    vectors: [
      { id: "alice-one", workspaceId: aliceWorkspaceId, score: 0.97 },
      { id: "alice-two", workspaceId: aliceWorkspaceId, score: 0.96 },
    ],
  });

  /**
   * A ctx that can be awaited. src/index.ts hands every nightly pass to
   * ctx.waitUntil, so the no-op double used by the request tests above would let
   * these assertions run against a database no pass had touched yet.
   */
  function collectingCtx() {
    const pending: Promise<unknown>[] = [];
    return {
      ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext,
      drain: async () => { await Promise.allSettled(pending.splice(0)); },
    };
  }

  const nightly = async () => {
    const { ctx: cronCtx, drain } = collectingCtx();
    await worker.scheduled({ cron: NIGHTLY_CRON } as unknown as ScheduledEvent, env, cronCtx);
    await drain();
  };

  const cursor = async () => await sqlite.db.prepare(
    `SELECT workspace_id FROM maintenance_cursor WHERE id = 1`,
  ).first() as { workspace_id: string } | null;

  /**
   * Park the ring immediately before `workspaceId` so the next run picks exactly
   * that slice. The cursor is set to the id with its last character dropped: that
   * sorts strictly before the id, and no other `ws-<uuid>` can fall between the
   * two without sharing all but the last character of a UUID. Deterministic
   * without reaching into rotation.ts for its internals.
   */
  async function parkCursorBefore(workspaceId: string) {
    await sqlite.db.prepare(
      `INSERT INTO maintenance_cursor (id, workspace_id, advanced_at) VALUES (1, ?, 0)
       ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id`,
    ).bind(workspaceId.slice(0, -1)).run();
  }

  it("the nightly ring moves to a different workspace each night", async () => {
    // One workspace per invocation is the whole point of the cursor (see
    // src/runtime/rotation.ts): a corpus-wide nightly pass costs more D1
    // subrequests with every team member added. A ring that never advanced would
    // process one member's memories every night and nobody else's, forever.
    await sqlite.db.prepare(
      `INSERT INTO maintenance_cursor (id, workspace_id, advanced_at) VALUES (1, ?, 0)
       ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id`,
    ).bind(aliceWorkspaceId).run();

    await nightly();
    const first = (await cursor())?.workspace_id;
    await nightly();
    const second = (await cursor())?.workspace_id;

    // Three workspaces carry entries here — Alice's, Bob's, and the company
    // layer — so two consecutive nights must land on two different ones.
    expect(first).not.toBe(aliceWorkspaceId);
    expect(second).not.toBe(first);
    expect([aliceWorkspaceId, bobWorkspaceId, companyWorkspaceId]).toContain(first);
    expect([aliceWorkspaceId, bobWorkspaceId, companyWorkspaceId]).toContain(second);
  });

  /**
   * Recorded first as `it.fails` — the defect it describes was real: the nightly
   * graph pass queried Vectorize with no workspace filter, so a near-duplicate in
   * another member's personal workspace came back as a neighbour and
   * `inferEdgesOnWrite` wrote the edge. `relates_to` is symmetric, so
   * edgeInsertStatement also reordered the endpoints — the edge was stamped with
   * the acting entry's workspace while its `source_id` might be the colleague's
   * row.
   *
   * The pass now filters to the row's own workspace, and inferEdgesOnWrite
   * refuses a pair whose endpoints disagree whatever the filter did. The
   * assertion below is exactly the one that was recorded as failing.
   */
  it("the graph pass never links a memory to one in another workspace", async () => {
    // Near-identical text on both sides, and a Vectorize double that answers the
    // way a real unfiltered index answers: every entry is a strong neighbour of
    // every other. Without that the backfill gets an empty match list and the
    // assertion below passes without the pass ever having had the chance to
    // build a cross-workspace edge.
    seed("alice-link", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    seed("bob-link", bobWorkspaceId, bobUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    env.VECTORIZE = crossWorkspaceVectorize();

    await parkCursorBefore(aliceWorkspaceId);
    await nightly();

    const { results: crossings } = await sqlite.db.prepare(
      `SELECT e.source_id, e.target_id, s.workspace_id AS sw, t.workspace_id AS tw
         FROM edges e
         JOIN entries s ON s.id = e.source_id
         JOIN entries t ON t.id = e.target_id
        WHERE s.workspace_id != t.workspace_id`,
    ).all();
    expect(crossings).toEqual([]);
  });

  it("asks the index for neighbours with no metadata filter at all, and still creates no crossing", async () => {
    // The pass deliberately does not filter (src/graph/pass.ts): its candidate
    // rows include entries whose vectors predate workspace stamping, and a
    // filter on a field those vectors do not carry can match nothing. So the
    // containment is the endpoint check's alone, and this asserts both halves —
    // that no filter is sent, and that the crossing is refused anyway.
    //
    // The double here REJECTS any filtered query, so if the pass ever starts
    // sending one again this case fails loudly rather than degrading quietly.
    seed("alice-link", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    seed("bob-link", bobWorkspaceId, bobUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    const index = filterRejectingVectorize();
    env.VECTORIZE = index;

    await parkCursorBefore(aliceWorkspaceId);
    await nightly();

    const calls = (index.query as unknown as { mock: { calls: any[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, opts] of calls) expect(opts?.filter).toBeUndefined();
    // Nothing degraded, because nothing was filtered — so the cron cannot latch
    // the isolate into unfiltered mode for the recall and capture paths.
    expect(vectorizeFilterState().supported).toBeNull();
    expect(vectorizeFilterState().degradedQueries).toBe(0);

    const { results: crossings } = await sqlite.db.prepare(
      `SELECT e.source_id, e.target_id FROM edges e
         JOIN entries s ON s.id = e.source_id
         JOIN entries t ON t.id = e.target_id
        WHERE s.workspace_id != t.workspace_id`,
    ).all();
    expect(crossings).toEqual([]);
  });

  /**
   * THE UPGRADE PATH. On a brain that predates workspace stamping, the entries
   * rows have a real workspace (tenancy bootstrap backfills them) and their
   * vectors have no `workspace_id` metadata at all, because nothing restamps
   * vectors. Asking the index for "vectors whose workspace_id is in [ws-alice]"
   * can therefore match nothing at all — and if the pass depends on that answer,
   * an upgraded brain silently stops inferring ANY edges.
   *
   * Run under both readings of `$in` against a missing field, because which one
   * Vectorize implements is not determinable from this repo: there is no local
   * Vectorize emulation (wrangler binds it "remote"), the type declarations are
   * silent, and guessing the favourable one is how this shipped in the first
   * place. The pass must be correct under either.
   */
  it.each([
    { name: "an absent field does not satisfy $in", absentFieldMatches: false },
    { name: "an absent field satisfies $in", absentFieldMatches: true },
  ])("still infers a same-workspace edge when the vectors predate stamping ($name)", async ({ absentFieldMatches }) => {
    seed("alice-one", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    seed("alice-two", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract were re-signed this quarter", ["contracts"]);
    // Neither vector carries workspace_id — the upgraded-brain shape.
    env.VECTORIZE = indexDouble({
      absentFieldMatches,
      vectors: [
        { id: "alice-one", score: 0.97 },
        { id: "alice-two", score: 0.96 },
      ],
    });

    await parkCursorBefore(aliceWorkspaceId);
    await nightly();

    const { results } = await sqlite.db.prepare(
      `SELECT source_id, target_id, workspace_id FROM edges
        WHERE type = 'relates_to' AND provenance = 'inferred'`,
    ).all();
    expect(results).toContainEqual({
      source_id: "alice-one",
      target_id: "alice-two",
      workspace_id: aliceWorkspaceId,
    });
  });

  it.each([
    { name: "an absent field does not satisfy $in", absentFieldMatches: false },
    { name: "an absent field satisfies $in", absentFieldMatches: true },
  ])("keeps two members apart when the vectors predate stamping ($name)", async ({ absentFieldMatches }) => {
    // The other half of the upgrade path: unstamped vectors mean the filter
    // cannot be doing the containment, so this is the case that shows the
    // endpoint check alone is carrying it.
    seed("alice-link", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    seed("bob-link", bobWorkspaceId, bobUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    env.VECTORIZE = indexDouble({
      absentFieldMatches,
      vectors: [
        { id: "alice-link", score: 0.97 },
        { id: "bob-link", score: 0.96 },
      ],
    });

    await parkCursorBefore(aliceWorkspaceId);
    await nightly();

    const { results: crossings } = await sqlite.db.prepare(
      `SELECT e.source_id, e.target_id FROM edges e
         JOIN entries s ON s.id = e.source_id
         JOIN entries t ON t.id = e.target_id
        WHERE s.workspace_id != t.workspace_id`,
    ).all();
    expect(crossings).toEqual([]);
  });

  // A solo brain has one workspace, so the narrowing must cost it nothing —
  // whether or not its index can filter. Both arms assert the same edge.
  it.each([
    { name: "filter accepted", rejectFilters: false },
    { name: "filter rejected", rejectFilters: true },
  ])("still links two memories in one workspace ($name)", async ({ rejectFilters }) => {
    seed("alice-one", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    seed("alice-two", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract were re-signed this quarter", ["contracts"]);
    env.VECTORIZE = sameWorkspaceVectorize(rejectFilters);

    await parkCursorBefore(aliceWorkspaceId);
    await nightly();

    const { results } = await sqlite.db.prepare(
      `SELECT source_id, target_id, workspace_id FROM edges
        WHERE type = 'relates_to' AND provenance = 'inferred'`,
    ).all();
    expect(results).toContainEqual({
      source_id: "alice-one",
      target_id: "alice-two",
      workspace_id: aliceWorkspaceId,
    });
  });

  it("a cross-workspace edge still draws no colleague's node", async () => {
    // The containment that holds independently of how the edge got there, and
    // the reason the defect above was a defect rather than an outage: GET /graph
    // hydrates nodes through the caller's scope, so the foreign endpoint drops
    // out of the drawing even though the edge row exists. Asserted here so a
    // change to the hydration cannot quietly turn a stale row into a live
    // content leak.
    //
    // The row is seeded rather than produced by the pass: the pass no longer
    // writes one. Every brain upgraded from before that fix still has rows of
    // exactly this shape, which is what this case is for.
    seed("alice-link", aliceWorkspaceId, aliceUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    seed("bob-link", bobWorkspaceId, bobUserId,
      "Renewal terms for the Ardent contract are unchanged this quarter", ["contracts"]);
    sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('stale-cross', 'alice-link', 'bob-link', 'relates_to', 0.96, 'inferred', '{}', ?, ?, ?)`,
    ).bind(SEEDED_AT, SEEDED_AT, aliceWorkspaceId).run();

    // The bridging edge really is there — otherwise this proves nothing.
    const bridged = await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM edges e
         JOIN entries s ON s.id = e.source_id
         JOIN entries t ON t.id = e.target_id
        WHERE s.workspace_id != t.workspace_id`,
    ).first() as { n: number };
    expect(bridged.n).toBeGreaterThan(0);

    const bobGraph = await jsonOf(await call("GET", "/graph", bobToken));
    const bobNodes = (bobGraph.nodes ?? []).map((n: any) => n.id);
    expect(bobNodes).not.toContain("alice-link");
    expect(JSON.stringify(bobGraph)).not.toContain("Alice private");

    const aliceGraph = await jsonOf(await call("GET", "/graph", ALICE));
    expect((aliceGraph.nodes ?? []).map((n: any) => n.id)).not.toContain("bob-link");
  });

  it("the digest pass never pools two workspaces' memories into one rollup", async () => {
    // Driven through worker.scheduled rather than compressTag directly: the unit
    // test in test/unit/team-scoping.test.ts already covers the function, and
    // what is untested is whether the cron that actually calls it every night
    // preserves the partition.
    //
    // Eleven a side, because the candidate query keeps only tags with count > 10.
    for (let i = 0; i < 11; i++) {
      seed(`a-proj-${i}`, aliceWorkspaceId, aliceUserId, `ALPHA note ${i} on the proj plan`, ["proj"]);
      seed(`b-proj-${i}`, bobWorkspaceId, bobUserId, `BETA note ${i} on the proj plan`, ["proj"]);
    }
    const prompts: string[] = [];
    env.AI = digestAI(prompts);

    await parkCursorBefore(aliceWorkspaceId);
    await nightly();

    // Not one prompt saw both sides. Asserting on the prompts rather than the
    // digest text is what makes this sharp: a rollup built from mixed rows would
    // be a leak even if the model's summary happened to name neither marker.
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p.includes("ALPHA") && p.includes("BETA")).toBe(false);

    const { results: digests } = await sqlite.db.prepare(
      `SELECT id, workspace_id FROM entries WHERE tags LIKE '%"synthesized"%'`,
    ).all() as { results: { id: string; workspace_id: string }[] };
    expect(digests.length).toBeGreaterThan(0);
    for (const d of digests) {
      expect([aliceWorkspaceId, bobWorkspaceId]).toContain(d.workspace_id);
    }
  });

  it("GET /patterns pages within the caller's own queue, not the deployment's", async () => {
    // The existing case checks page one of a two-row queue, which a broken OFFSET
    // would also pass. Sixty of Bob's ahead of Alice's one is the shape that
    // separates "scoped" from "scoped enough to look right on the first page".
    for (let i = 0; i < 60; i++) {
      seed(`bob-ins-${i}`, bobWorkspaceId, bobUserId,
        `Bob private insight ${i}: the redundancy consultation is next month`, ["auto-insight"]);
    }
    seed("alice-ins", aliceWorkspaceId, aliceUserId,
      "Alice insight: the pricing page converts better without the comparison table", ["auto-insight"]);

    const page = await jsonOf(await call("GET", "/patterns?limit=50&offset=0", ALICE));
    expect(page.patterns.map((p: any) => p.id)).toEqual(["alice-ins"]);
    expect(page.total).toBe(1);
    expect(JSON.stringify(page)).not.toContain("redundancy consultation");

    // Page two of a one-row queue is empty, not Bob's overflow.
    const second = await jsonOf(await call("GET", "/patterns?limit=50&offset=50", ALICE));
    expect(second.patterns).toEqual([]);
  });

  it("GET /stale pages within the caller's own queue too", async () => {
    for (let i = 0; i < 60; i++) {
      seed(`bob-stale-${i}`, bobWorkspaceId, bobUserId,
        `Bob private ${i}: the settlement figure was agreed in March`, ["stale:as-of"]);
    }
    seed("alice-stale", aliceWorkspaceId, aliceUserId,
      "Alice: the office lease runs to 2027", ["stale:as-of"]);

    const page = await jsonOf(await call("GET", "/stale?limit=50&offset=0", ALICE));
    expect(page.entries.map((e: any) => e.id)).toEqual(["alice-stale"]);
    expect(page.total).toBe(1);
    expect(JSON.stringify(page)).not.toContain("settlement figure");
  });

  it("the repair routes stay deployment-wide but never move a row between workspaces", async () => {
    // POST /vectorize-pending and /classify-pending are the two documented
    // exceptions to the scope rule: they must reach every workspace or a member's
    // unindexed rows stay unindexed with nothing on screen to say so. The rule
    // they still owe is that repairing a row is not a way to relocate it — a
    // repair that stamped the acting admin's workspace onto Bob's memory would
    // move it into her readable set, which is a leak written by the fix.
    const { results: before } = await sqlite.db.prepare(
      `SELECT id, workspace_id, actor_id FROM entries WHERE workspace_id = ? ORDER BY id`,
    ).bind(bobWorkspaceId).all() as { results: { id: string; workspace_id: string; actor_id: string }[] };
    expect(before.length).toBeGreaterThan(0);

    expect((await call("POST", "/vectorize-pending", ALICE)).status).toBe(200);
    expect((await call("POST", "/classify-pending", ALICE)).status).toBe(200);

    const { results: after } = await sqlite.db.prepare(
      `SELECT id, workspace_id, actor_id FROM entries WHERE id IN (${before.map(() => "?").join(",")}) ORDER BY id`,
    ).bind(...before.map(r => r.id)).all() as { results: { id: string; workspace_id: string; actor_id: string }[] };
    expect(after).toEqual(before);

    // And the repair actually reached Bob's rows: an admin whose scope silently
    // narrowed these would pass the assertion above by doing nothing at all.
    const stillPending = await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE workspace_id = ? AND vector_ids = '[]'`,
    ).bind(bobWorkspaceId).first() as { n: number };
    expect(stillPending.n).toBe(0);
  });
});
