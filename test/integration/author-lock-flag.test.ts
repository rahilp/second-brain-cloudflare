/**
 * The author lock, told to the client in advance.
 *
 * `assertCanMutateEntry` (src/lib/entry-access.ts) refuses an edit or a delete on
 * a company-layer row the caller did not write, unless they are an admin. Until
 * `can_edit` shipped, no read surface said so, and the dashboard offered Edit and
 * Forget on a colleague's shared memory and discovered the rule by getting a 403.
 *
 * The assertion that matters throughout is not that the flag has some value but
 * that it AGREES with the server: every case that reads `can_edit` also issues
 * the mutation and checks the two answers match. A flag that disagrees with the
 * enforcement is worse than no flag, because the UI would then be confidently
 * wrong instead of merely uninformed.
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
const FORBIDDEN = "Only the entry's author or an admin can modify a shared company memory";

let sqlite: SqliteD1;
let env: Env;
let statements: string[];
const ADMIN = "test-token"; // the bootstrap owner, per makeTestEnv's AUTH_TOKEN
let aliceToken = "";
let bobToken = "";
let aliceUserId = "";
let aliceWorkspaceId = "";
let bobUserId = "";
let bobWorkspaceId = "";
let companyWorkspaceId = "";

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

/** Capture through the real route, so the row lands with the identity's own workspace and actor. */
async function capture(token: string, content: string, workspace?: "personal" | "company"): Promise<string> {
  const res = await call("POST", "/capture", token, { content, tags: ["work"], workspace });
  const body = await jsonOf(res);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.id as string;
}

const entryOf = async (id: string, token: string) => (await jsonOf(await call("GET", `/entry?id=${id}`, token))).entry;

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

  const roots = await ensureTenantBootstrap(env);
  companyWorkspaceId = roots.companyWorkspaceId;
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

describe("GET /entry — can_edit", () => {
  it("is true on the caller's own personal memory, and the edit goes through", async () => {
    const id = await capture(aliceToken, "Alice private: sabbatical plan");

    expect((await entryOf(id, aliceToken)).can_edit).toBe(true);
    expect((await call("POST", "/update", aliceToken, { id, content: "Alice private: sabbatical, revised" })).status).toBe(200);
  });

  it("is false for a colleague on a shared memory, and the edit is refused with that exact 403", async () => {
    const id = await capture(aliceToken, "Company: releases ship behind a flag");
    expect((await call("POST", "/share", aliceToken, { id, workspace: "company" })).status).toBe(200);

    expect((await entryOf(id, bobToken)).can_edit).toBe(false);

    const refused = await call("POST", "/update", bobToken, { id, content: "Company: releases ship however Bob likes" });
    expect(refused.status).toBe(403);
    expect((await jsonOf(refused)).error).toBe(FORBIDDEN);
  });

  it("stays true for the author after sharing, and the edit still goes through", async () => {
    const id = await capture(aliceToken, "Company: on-call rota is weekly");
    await call("POST", "/share", aliceToken, { id, workspace: "company" });

    expect((await entryOf(id, aliceToken)).can_edit).toBe(true);
    expect((await call("POST", "/update", aliceToken, { id, content: "Company: on-call rota is fortnightly" })).status).toBe(200);
  });

  it("is true for an admin on a colleague's shared memory — the admin escape", async () => {
    const id = await capture(aliceToken, "Company: handbook lives in the wiki");
    await call("POST", "/share", aliceToken, { id, workspace: "company" });

    expect((await entryOf(id, ADMIN)).can_edit).toBe(true);
    expect((await call("POST", "/update", ADMIN, { id, content: "Company: handbook lives in the repo" })).status).toBe(200);
  });
});

describe("GET /list — can_edit", () => {
  it("marks a colleague's shared row false and the caller's own rows true, in one response", async () => {
    const shared = await capture(aliceToken, "Company: releases ship behind a flag");
    await call("POST", "/share", aliceToken, { id: shared, workspace: "company" });
    const mine = await capture(bobToken, "Bob private: interviewing elsewhere");
    const alsoMine = await capture(bobToken, "Bob private: recruiter call Thursday");

    const rows = await jsonOf(await call("GET", "/list?n=50", bobToken));
    const flagOf = (id: string) => rows.find((r: any) => r.id === id)?.can_edit;

    expect(flagOf(shared)).toBe(false);
    expect(flagOf(mine)).toBe(true);
    expect(flagOf(alsoMine)).toBe(true);
  });

  it("agrees with the server on every row it returns", async () => {
    // The property, not the sample: for each row Bob can see, the flag and the
    // 403 have to be the same answer.
    const shared = await capture(aliceToken, "Company: releases ship behind a flag");
    await call("POST", "/share", aliceToken, { id: shared, workspace: "company" });
    await capture(bobToken, "Bob private: interviewing elsewhere");
    const bobShared = await capture(bobToken, "Bob shared: the deploy runbook");
    await call("POST", "/share", bobToken, { id: bobShared, workspace: "company" });

    const rows = await jsonOf(await call("GET", "/list?n=50", bobToken));
    expect(rows.length).toBe(3);

    for (const row of rows) {
      const res = await call("POST", "/update", bobToken, { id: row.id, content: `${row.content} (edited)` });
      expect([row.id, row.can_edit, res.status]).toEqual([row.id, row.can_edit, row.can_edit ? 200 : 403]);
    }
  });

  it("costs no extra query — the columns it needs were already in the projection", async () => {
    for (let i = 0; i < 5; i++) await capture(bobToken, `Bob private memory ${i}`);
    const shared = await capture(aliceToken, "Company: releases ship behind a flag");
    await call("POST", "/share", aliceToken, { id: shared, workspace: "company" });

    // Warm first: identity bootstrap and the schema probe are one-offs, and this
    // is a claim about the list read, not about a cold isolate.
    await call("GET", "/list?n=50", bobToken);
    statements = [];
    const rows = await jsonOf(await call("GET", "/list?n=50", bobToken));

    expect(rows).toHaveLength(6);
    // Three: the identity read, the throttled last_used_at stamp that rides in
    // its batch, and the list query itself — plus the one actor lookup the
    // shared row already required before can_edit existed.
    expect(statements).toHaveLength(4);
    expect(statements.filter(s => /FROM entries/.test(s))).toHaveLength(1);
  });
});

describe("can_edit on a brain with no team", () => {
  it("is true on the legacy '' rows a pre-team brain is made of", async () => {
    // The shape a solo brain upgrades from: workspace_id and actor_id both '',
    // read by the owner. Nothing here is a company workspace, so nothing is
    // locked — constraint 3, identical behaviour to before teams existed.
    sqlite.db
      .prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
         VALUES ('legacy-1', 'A memory from before teams', '[]', 'api', 1, 1, '[]', '', '')`,
      )
      .run();

    expect((await entryOf("legacy-1", ADMIN)).can_edit).toBe(true);
    const rows = await jsonOf(await call("GET", "/list?n=50", ADMIN));
    expect(rows.find((r: any) => r.id === "legacy-1").can_edit).toBe(true);
    expect((await call("POST", "/update", ADMIN, { id: "legacy-1", content: "Still editable" })).status).toBe(200);
  });

  it("is true for a member who belongs to no company workspace at all", async () => {
    // companyWorkspaceIds is empty, so isCompanyWorkspace can never match and the
    // lock can never engage — the same answer the flag has to give.
    sqlite.db.prepare(`DELETE FROM memberships WHERE user_id = ? AND workspace_id = ?`)
      .bind(bobUserId, companyWorkspaceId).run();
    const id = await capture(bobToken, "Bob private: still mine");

    expect((await entryOf(id, bobToken)).can_edit).toBe(true);
    const rows = await jsonOf(await call("GET", "/list?n=50", bobToken));
    expect(rows.every((r: any) => r.can_edit === true)).toBe(true);
    expect((await call("POST", "/update", bobToken, { id, content: "Bob private: edited" })).status).toBe(200);
  });
});
