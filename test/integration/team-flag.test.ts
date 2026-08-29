/**
 * `GET /health`'s `team` flag — the dashboard's only signal for "show the
 * layer controls".
 *
 * The subject is the COUNT that flag is derived from, so this runs against
 * real SQLite rather than the string-matching D1 double: the bug it pins was a
 * missing WHERE clause, and a double that answers a canned row for
 * `SELECT COUNT(*) ... FROM users` cannot tell the two queries apart.
 *
 * `removeMember` does not delete the `users` row — it deletes the member's
 * entries, edges, memberships and personal workspace and then tombstones the
 * row (`removed_at`), so shared memories the person wrote stay attributable to
 * a name. A bare `COUNT(*) FROM users` therefore counts people who are gone,
 * and a brain that ever had a second member could never read as solo again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember, removeMember, setMemberSuspended } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };

/** Store an explicit TEAM_MODE the way PATCH /config would. */
function setTeamMode(value: string) {
  return env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: value }));
}

/** The flag under test, read the way the dashboard reads it. */
async function teamFlag(): Promise<boolean> {
  const res = await worker.fetch(
    new Request("http://localhost/health", { headers: { Authorization: `Bearer ${ADMIN}` } }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json() as any).team;
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
});

afterEach(() => sqlite?.close());

describe("GET /health team flag counts only people who are still on the team", () => {
  it("goes true when a member is added and back to false when they are removed", async () => {
    // Seeded FALSE on purpose: the bootstrap owner alone is one row, so an
    // assertion that only ever saw `true` would pass on a hard-coded flag.
    expect(await teamFlag()).toBe(false);

    const bob = await createMember(env, { name: "Bob", email: "bob@example.com" });
    expect(await teamFlag()).toBe(true);

    await removeMember(env, roots.ownerUserId, bob.member.userId);
    // The row is still there — that is the point. If this reads `true`, the
    // count is seeing a tombstone.
    const surviving = await sqlite.db
      .prepare(`SELECT COUNT(*) AS n FROM users`)
      .first() as { n: number };
    expect(surviving.n).toBe(2);
    expect(await teamFlag()).toBe(false);
  });

  it("still counts a suspended member — they are on the team, merely locked out", async () => {
    const bob = await createMember(env, { name: "Bob", email: "bob@example.com" });
    await setMemberSuspended(env, roots.ownerUserId, bob.member.userId, true);
    expect(await teamFlag()).toBe(true);
  });
});

/**
 * Inference alone cannot express "set this up before anyone is invited", so
 * TEAM_MODE records the intent. Three values, and `/health` is where they are
 * read — no caller of `team` branches on the raw key.
 *
 * The default is "auto" and that is load-bearing rather than cosmetic: DEFAULTS
 * is static, so a default of "off" would turn every existing team brain solo
 * the moment this deploys and colleagues would lose the shared layer with no
 * warning. "auto" is exactly the behaviour above.
 */
describe("TEAM_MODE drives GET /health's team flag", () => {
  it('"on" makes a solo brain a team', async () => {
    // Seeded from the state that answers the OPPOSITE way: one active member,
    // which "auto" resolves to false two tests up.
    expect(await teamFlag()).toBe(false);
    await setTeamMode("on");
    expect(await teamFlag()).toBe(true);
  });

  it('"off" makes a real team read as solo', async () => {
    await createMember(env, { name: "Bob", email: "bob@example.com" });
    expect(await teamFlag()).toBe(true);
    await setTeamMode("off");
    expect(await teamFlag()).toBe(false);
  });

  it('"auto" infers from active membership, in both directions', async () => {
    await setTeamMode("auto");
    expect(await teamFlag()).toBe(false);
    await createMember(env, { name: "Bob", email: "bob@example.com" });
    expect(await teamFlag()).toBe(true);
  });

  it("defaults to auto, so an upgrade changes nothing for an existing team", async () => {
    await createMember(env, { name: "Bob", email: "bob@example.com" });
    // No override blob at all — the state every brain is in on the day this
    // ships.
    expect(await env.OAUTH_KV.get(CONFIG_KEY)).toBeNull();
    expect(await teamFlag()).toBe(true);
  });
});
