/**
 * users.last_used_at — when this token was last seen, for the admin roster.
 *
 * Real SQLite, because the subject is the write itself: whether it happens, what
 * it stores, and — the part that decides whether this column is affordable —
 * whether it is skipped. Identity resolution runs on EVERY request, so an
 * unthrottled timestamp would be one D1 row written per request against a plan
 * that caps writes per day. The throttle is the design; these cases are what
 * hold it in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember, listMembers } from "../../src/lib/team-admin";
import { resolveIdentityFromToken, hashToken, LAST_USED_THROTTLE_MS } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const START = 1_800_000_000_000;

let sqlite: SqliteD1;
let env: Env;
let dana: { userId: string; token: string };
let ownerUserId: string;

/** Let the un-awaited update settle. It is a floating promise by design. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const storedLastUsed = (userId: string) =>
  sqlite.db.prepare(`SELECT last_used_at FROM users WHERE id = ?`).bind(userId).first() as Promise<
    { last_used_at: number | null } | null
  >;

const updates = () => sqlite.issued.filter((s) => /UPDATE users SET last_used_at/.test(s));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
  await initializeDatabase(env);
  ownerUserId = (await ensureTenantBootstrap(env)).ownerUserId;
  const created = await createMember(env, { name: "Dana" });
  dana = { userId: created.member.userId, token: created.token };
});

afterEach(() => {
  vi.useRealTimers();
  sqlite?.close();
});

describe("the throttled write", () => {
  it("stamps the first successful resolution", async () => {
    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();

    await resolveIdentityFromToken(dana.token, env);
    await flush();

    const stored = (await storedLastUsed(dana.userId))!.last_used_at!;
    expect(Math.abs(stored - Date.now())).toBeLessThan(1000);
  });

  it("writes nothing on a second resolution within the hour", async () => {
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    const first = (await storedLastUsed(dana.userId))!.last_used_at;
    sqlite.issued.length = 0;

    vi.advanceTimersByTime(60_000);
    await resolveIdentityFromToken(dana.token, env);
    await flush();

    // Byte-identical: not merely "close enough", but never written at all.
    expect((await storedLastUsed(dana.userId))!.last_used_at).toBe(first);
    expect(updates()).toEqual([]);
  });

  it("writes again once the throttle window has passed", async () => {
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    const first = (await storedLastUsed(dana.userId))!.last_used_at!;

    vi.advanceTimersByTime(LAST_USED_THROTTLE_MS + 1);
    await resolveIdentityFromToken(dana.token, env);
    await flush();

    const second = (await storedLastUsed(dana.userId))!.last_used_at!;
    expect(second).toBe(first + LAST_USED_THROTTLE_MS + 1);
  });

  it("does not write exactly on the throttle boundary", async () => {
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    const first = (await storedLastUsed(dana.userId))!.last_used_at;

    vi.advanceTimersByTime(LAST_USED_THROTTLE_MS);
    await resolveIdentityFromToken(dana.token, env);
    await flush();

    expect((await storedLastUsed(dana.userId))!.last_used_at).toBe(first);
  });

  // The regression guard for the whole design. An informational column may not
  // cost a subrequest on a path every request takes: Workers get 50 per
  // invocation on the free plan and GET /graph already has no headroom. The
  // stamp is therefore batched with the identity read, and a D1 batch is ONE
  // subrequest whatever it carries.
  //
  // Both halves matter. The cold case is the one that would regress if someone
  // moved the write back out into its own statement — it is the request that
  // actually performs the write. The warm case is what the throttle buys.
  it("costs no extra subrequest on the cold path, where it does write", async () => {
    sqlite.issued.length = 0;

    const identity = await resolveIdentityFromToken(dana.token, env);
    await flush();

    expect(identity).not.toBeNull();
    // Exactly one round trip: the batch carrying the read and the stamp.
    expect(sqlite.issued).toEqual(["BATCH"]);
    // And the write genuinely happened — this is not "cheap because it did
    // nothing".
    expect((await storedLastUsed(dana.userId))!.last_used_at).toBe(Date.now());
  });

  it("costs no extra subrequest on the warm path, where it writes nothing", async () => {
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    vi.advanceTimersByTime(1000);
    sqlite.issued.length = 0;

    const identity = await resolveIdentityFromToken(dana.token, env);
    await flush();

    expect(identity).not.toBeNull();
    expect(sqlite.issued).toEqual(["BATCH"]);
  });

  // Batching put the stamp in the same transaction as the read, so without a
  // fallback a failing write would take authentication down with it: every
  // request in the deployment would start failing over a column nothing reads.
  it("resolves the identity even when the batched update fails", async () => {
    const realPrepare = sqlite.db.prepare.bind(sqlite.db);
    const failing = {
      ...sqlite.db,
      prepare: (sql: string) => {
        if (/SET last_used_at/.test(sql)) throw new Error("D1_ERROR: database is locked");
        return realPrepare(sql);
      },
      batch: sqlite.db.batch.bind(sqlite.db),
    };
    const brokenEnv = makeTestEnv(undefined, { DB: failing as unknown as Env["DB"] });

    const identity = await resolveIdentityFromToken(dana.token, brokenEnv);

    expect(identity).not.toBeNull();
    expect(identity!.userId).toBe(dana.userId);
    // And the column is still what it was: a lost stamp, never a wrong one.
    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
  });

  // The other shape of the same failure: prepare() succeeds and the statement
  // rejects when the batch runs it, which is what a D1 network error or a
  // breached write cap actually looks like.
  it("survives the batched update rejecting at execution time", async () => {
    const realPrepare = sqlite.db.prepare.bind(sqlite.db);
    const failing = {
      ...sqlite.db,
      prepare: (sql: string) => {
        if (!/SET last_used_at/.test(sql)) return realPrepare(sql);
        const boom = () => Promise.reject(new Error("D1_ERROR: network error"));
        return { bind: () => ({ run: boom, all: boom, first: boom }), run: boom, all: boom, first: boom };
      },
      batch: sqlite.db.batch.bind(sqlite.db),
    };
    const brokenEnv = makeTestEnv(undefined, { DB: failing as unknown as Env["DB"] });

    const identity = await resolveIdentityFromToken(dana.token, brokenEnv);

    expect(identity!.userId).toBe(dana.userId);
    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
  });

  // The stamp says "last SUCCESSFUL identity resolution", so its WHERE clause
  // mirrors IDENTITY_SQL's. The batch always carries the statement; what stops
  // it writing is the predicate, not the caller.
  it("does not stamp a token whose user cannot actually resolve an identity", async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, name, role, token_hash, suspended, created_at) VALUES ('u-orphan', 'Orphan', 'member', ?, 0, 1)`,
    ).bind(await hashToken("orphan-token")).run();

    // No personal-workspace membership, so IDENTITY_SQL's INNER JOIN finds
    // nothing and the caller is not authenticated.
    expect(await resolveIdentityFromToken("orphan-token", env)).toBeNull();
    await flush();

    expect((await storedLastUsed("u-orphan"))?.last_used_at).toBeNull();
  });

  it("does not stamp a suspended member's still-valid token", async () => {
    await env.DB.prepare(`UPDATE users SET suspended = 1 WHERE id = ?`).bind(dana.userId).run();

    expect(await resolveIdentityFromToken(dana.token, env)).toBeNull();
    await flush();

    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
  });

  // `removed_at` is the predicate most likely to be dropped in a future edit:
  // removal is the rarer of the two account states, and the read-side filter
  // lives in a different statement, so nothing else in this file would notice.
  //
  // The flag is set directly rather than through removeMember, and that is the
  // whole point of the case. removeMember also deletes the member's personal
  // workspace and memberships, so the stamp's EXISTS clause refuses it anyway —
  // a test driven that way passes with `removed_at` deleted from the statement
  // and proves nothing about it. Setting the column alone is the only state in
  // which this predicate is the thing doing the work.
  it("does not stamp a removed member whose memberships are still in place", async () => {
    await env.DB.prepare(`UPDATE users SET removed_at = ? WHERE id = ?`)
      .bind(Date.now(), dana.userId).run();

    expect(await resolveIdentityFromToken(dana.token, env)).toBeNull();
    await flush();

    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
  });

  it("does not stamp a member who is both suspended and removed", async () => {
    // removeMember does not clear `suspended`, so both flags set is the ordinary
    // shape of a removed row; neither predicate may be relied on alone.
    await env.DB.prepare(`UPDATE users SET suspended = 1, removed_at = ? WHERE id = ?`)
      .bind(Date.now(), dana.userId).run();

    expect(await resolveIdentityFromToken(dana.token, env)).toBeNull();
    await flush();

    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
  });

  it("stops stamping a member the moment they are removed, having stamped before", async () => {
    // The transition, so the case above cannot pass merely because nothing was
    // ever written for this member.
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    const stamped = (await storedLastUsed(dana.userId))!.last_used_at!;

    vi.advanceTimersByTime(LAST_USED_THROTTLE_MS + 1);
    await env.DB.prepare(`UPDATE users SET removed_at = ? WHERE id = ?`)
      .bind(Date.now(), dana.userId).run();
    await resolveIdentityFromToken(dana.token, env);
    await flush();

    // The throttle would have allowed a write; removal is what stopped it.
    expect((await storedLastUsed(dana.userId))!.last_used_at).toBe(stamped);
  });

  it("is not stamped by the OAuth grant path, which says nothing about token use", async () => {
    const { resolveIdentityByUserId } = await import("../../src/lib/identity");
    await resolveIdentityByUserId(env, dana.userId);
    await flush();
    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
  });
});

describe("what the admin roster sees", () => {
  it("reports null for a member who has never authenticated, then the timestamp", async () => {
    const before = (await listMembers(env)).find((m) => m.userId === dana.userId)!;
    expect(before.lastUsedAt).toBeNull();

    await resolveIdentityFromToken(dana.token, env);
    await flush();

    const after = (await listMembers(env)).find((m) => m.userId === dana.userId)!;
    expect(typeof after.lastUsedAt).toBe("number");
    expect(after.lastUsedAt).toBe(Date.now());
  });
});
