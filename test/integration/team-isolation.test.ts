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
    // Bob: his own row plus the company row. Not Alice's.
    expect((await jsonOf(await call("GET", "/count", bobToken))).count).toBe(2);
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
      .toEqual(["handbook", "job-hunting"]);

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
    expect(stats.unclassified).toBe(3);
  });

  it("GET /graph draws only nodes the caller can read", async () => {
    const graph = await jsonOf(await call("GET", "/graph", bobToken));
    const nodeIds = (graph.nodes ?? []).map((n: any) => n.id);
    expect(nodeIds).not.toContain(ids.alicePrivate);
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
