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
import { resolveIdentityFromToken, LAST_USED_THROTTLE_MS } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const START = 1_800_000_000_000;

let sqlite: SqliteD1;
let env: Env;
let dana: { userId: string; token: string };

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
  await ensureTenantBootstrap(env);
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

  it("costs one extra statement when it writes and none when it does not", async () => {
    sqlite.issued.length = 0;
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    expect(updates()).toHaveLength(1);

    sqlite.issued.length = 0;
    vi.advanceTimersByTime(1000);
    await resolveIdentityFromToken(dana.token, env);
    await flush();
    expect(sqlite.issued).toHaveLength(1); // the identity read, and nothing else
  });

  it("resolves the identity even when the update fails", async () => {
    const realPrepare = sqlite.db.prepare.bind(sqlite.db);
    const failing = {
      ...sqlite.db,
      prepare: (sql: string) => {
        if (/UPDATE users SET last_used_at/.test(sql)) throw new Error("D1_ERROR: database is locked");
        return realPrepare(sql);
      },
    };
    const brokenEnv = makeTestEnv(undefined, { DB: failing as unknown as Env["DB"] });

    const identity = await resolveIdentityFromToken(dana.token, brokenEnv);
    await flush();

    expect(identity).not.toBeNull();
    expect(identity!.userId).toBe(dana.userId);
    // And the column is still what it was: a lost stamp, never a wrong one.
    expect((await storedLastUsed(dana.userId))?.last_used_at).toBeNull();
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
