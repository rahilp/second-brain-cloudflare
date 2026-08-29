/**
 * Real membership is a FLOOR on TEAM_MODE.
 *
 * The guardrail on `PATCH /config` (test/integration/team-mode-config.test.ts)
 * is one-directional: it refuses "turn it off while colleagues are here". It
 * says nothing about "acquire colleagues while it is off", and that sequence is
 * reachable one legal step at a time:
 *
 *   1. the owner is alone, so `TEAM_MODE: "off"` is permitted — correctly,
 *      there is nobody to contradict;
 *   2. two people are invited through `POST /team/members` — permitted,
 *      correctly, nothing about inviting is gated on the flag;
 *   3. the brain now stores "off" with three active users, and `/health`
 *      answers `team: false`.
 *
 * Every step was allowed and the resulting state is invalid: the dashboard
 * drops the sharing controls, the layer pickers and the shared-layer filter,
 * while colleagues hold working tokens and the company workspace still holds
 * shared memories. A member can share into a layer their own admin's UI does
 * not render.
 *
 * The fix is not another write-time check. isTeamBrain() floors "off" against
 * the live headcount, so the invariant holds BY CONSTRUCTION — it cannot be
 * defeated by ordering, by a hand-edited KV blob, by a config written by an
 * older release, or by a future code path that creates a member without going
 * through the route.
 *
 * Real SQLite, because the floor IS the tombstone-aware COUNT.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { removeMember, setMemberSuspended } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };

function patchConfig(body: Record<string, unknown>): Promise<Response> {
  return worker.fetch(
    new Request("http://localhost/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

/** A colleague, invited the way the dashboard invites one. */
async function addMember(name: string): Promise<string> {
  const res = await worker.fetch(
    new Request("http://localhost/team/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.com` }),
    }),
    env,
    ctx,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as any).member.userId;
}

/** The flag under test, read the way the dashboard reads it. */
async function teamFlag(): Promise<boolean> {
  const res = await worker.fetch(
    new Request("http://localhost/health", { headers: { Authorization: `Bearer ${ADMIN}` } }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as any).team;
}

/** The headcount the floor is built on, straight from SQLite. */
async function activeUsers(): Promise<number> {
  const row = (await sqlite.db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL OR removed_at = 0`)
    .first()) as { n: number };
  return row.n;
}

/** The sparse override blob exactly as KV holds it. */
async function stored(): Promise<Record<string, unknown>> {
  const raw = await env.OAUTH_KV.get(CONFIG_KEY);
  return raw ? JSON.parse(raw) : {};
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

describe('a stored TEAM_MODE "off" cannot outlive the arrival of a team', () => {
  it("the live sequence: off while alone, then two colleagues — /health reports a team", async () => {
    // 1. Alone. The write is permitted, and correctly so.
    expect((await patchConfig({ TEAM_MODE: "off" })).status).toBe(200);
    expect(await teamFlag()).toBe(false);

    // 2. Two colleagues, through the route the dashboard uses.
    await addMember("Bob");
    await addMember("Carol");
    expect(await activeUsers()).toBe(3);

    // 3. Three people with tokens, a company workspace they can all read — and
    // therefore a team, whatever the stored key says.
    expect(await teamFlag()).toBe(true);

    // And it stays a team when the "off" comes BACK by a path no route sees —
    // a hand-edited KV blob, a restore from backup, a config written by an
    // older release. This second half is the floor alone: the correction on
    // POST /team/members cannot reach a write it never observed.
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "off" }));
    expect(await teamFlag()).toBe(true);
  });

  it("floors at exactly two active people, and not at one", async () => {
    await patchConfig({ TEAM_MODE: "off" });
    expect(await activeUsers()).toBe(1);
    expect(await teamFlag()).toBe(false);

    await addMember("Bob");
    expect(await activeUsers()).toBe(2);
    // Two is the whole floor: one colleague is a shared layer with a reader in
    // it, which is the entire thing the controls exist for.
    expect(await teamFlag()).toBe(true);
  });

  it("drops back to the stored off when the team dissolves — the intent is not overwritten", async () => {
    // Written out of band, exactly as a hand-edited KV blob or an older release
    // would leave it: PATCH would refuse this once Bob exists.
    const bob = await addMember("Bob");
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "off" }));
    expect(await teamFlag()).toBe(true);

    await removeMember(env, roots.ownerUserId, bob);
    // The floor lifts and the recorded intent takes effect again. A floor that
    // rewrote the stored value could not do this.
    expect(await teamFlag()).toBe(false);
  });

  it("does not count a tombstoned member towards the floor", async () => {
    const bob = await addMember("Bob");
    const carol = await addMember("Carol");
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "off" }));
    expect(await teamFlag()).toBe(true);

    await removeMember(env, roots.ownerUserId, bob);
    await removeMember(env, roots.ownerUserId, carol);
    // The rows are still there — removeMember tombstones rather than deletes,
    // so shared memories stay attributable to a name. A floor built on a bare
    // COUNT(*) would read three and hold "off" down forever.
    const all = (await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM users`).first()) as { n: number };
    expect(all.n).toBe(3);
    expect(await activeUsers()).toBe(1);
    expect(await teamFlag()).toBe(false);
  });

  it("does count a suspended member towards the floor", async () => {
    const bob = await addMember("Bob");
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "off" }));
    await setMemberSuspended(env, roots.ownerUserId, bob, true);
    // Suspension locks someone out of their token; it does not take them off
    // the team. Their memberships, personal workspace and shared entries are
    // all still there, so the layer controls have to stay on screen.
    expect(await activeUsers()).toBe(2);
    expect(await teamFlag()).toBe(true);
  });

  it('leaves "on" and "auto" exactly as they were', async () => {
    // "on" — a team before anyone is invited, which the floor must not touch in
    // either direction.
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "on" }));
    expect(await activeUsers()).toBe(1);
    expect(await teamFlag()).toBe(true);

    // "auto" — inference, in both directions.
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "auto" }));
    expect(await teamFlag()).toBe(false);
    await addMember("Bob");
    expect(await teamFlag()).toBe(true);
  });

  it("still refuses the write itself — the two mechanisms are both there", async () => {
    await addMember("Bob");
    const res = await patchConfig({ TEAM_MODE: "off" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("2");
    // And nothing was stored, so the refusal explains rather than silently
    // correcting.
    expect(await stored()).toEqual({});
  });
});

/**
 * What the floor costs. "on" is recorded intent and needs no headcount; "off"
 * and "auto" both resolve against one, which is the same single query /health
 * issued before TEAM_MODE existed.
 */
describe("the floor costs one headcount, and only where it has to", () => {
  const headcounts = () =>
    sqlite.issued.filter((sql) => /COUNT\(\*\)\s+AS n FROM users/i.test(sql)).length;

  it('issues no headcount for "on"', async () => {
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "on" }));
    sqlite.issued.length = 0;
    await teamFlag();
    expect(headcounts()).toBe(0);
  });

  it('issues exactly one for "auto" — the solo default, unchanged', async () => {
    sqlite.issued.length = 0;
    expect(await teamFlag()).toBe(false);
    expect(headcounts()).toBe(1);
  });

  it('issues exactly one for "off" — the price of the floor', async () => {
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "off" }));
    sqlite.issued.length = 0;
    await teamFlag();
    expect(headcounts()).toBe(1);
  });
});

/**
 * The floor makes the EFFECTIVE value right. The stored value is a separate
 * problem: "off" sitting in KV on a three-person brain is a trap for the next
 * reader, and inviting someone is an unambiguous statement that this is a team.
 *
 * The correction CLEARS the key rather than writing "on". "on" would replace
 * one recorded intent with another the owner never stated, and would then
 * survive the team dissolving — a solo brain pinned to team mode, needing a
 * second manual write to undo. Clearing hands the decision back to "auto",
 * which is right at every future headcount, including one.
 */
describe("inviting someone clears a stored off, so the blob stops lying", () => {
  it("clears the override the first time a colleague is invited", async () => {
    expect((await patchConfig({ TEAM_MODE: "off" })).status).toBe(200);
    expect(await stored()).toEqual({ TEAM_MODE: "off" });

    await addMember("Bob");
    expect(await stored()).toEqual({});
    // And the effective value agrees, by inference now rather than by the floor.
    expect(await teamFlag()).toBe(true);
  });

  it('never touches a stored "on"', async () => {
    await patchConfig({ TEAM_MODE: "on" });
    await addMember("Bob");
    expect(await stored()).toEqual({ TEAM_MODE: "on" });
  });

  it("leaves every other setting in the blob alone", async () => {
    await patchConfig({ TEAM_MODE: "off", MMR_LAMBDA: 0.42 });
    await addMember("Bob");
    expect(await stored()).toEqual({ MMR_LAMBDA: 0.42 });
  });

  it("writes nothing at all when there is no override to correct", async () => {
    const puts: string[] = [];
    const kv = env.OAUTH_KV;
    env.OAUTH_KV = {
      ...kv,
      get: (k: string) => (kv as any).get(k),
      put: (k: string, v: string) => { puts.push(k); return (kv as any).put(k, v); },
    } as unknown as KVNamespace;

    await addMember("Bob");
    // A brain that never overrode the key — the state every brain ships in —
    // gains no config write from inviting someone.
    expect(puts).toEqual([]);
  });
});
