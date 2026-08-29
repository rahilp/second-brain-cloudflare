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
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
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
