/**
 * The users.email unique-index migration.
 *
 * The constraint cannot ship as a plain CREATE UNIQUE INDEX against a brain that
 * already holds two members with the same email — the check-then-INSERT race
 * idx_users_email exists to close — because the CREATE itself would throw,
 * applySchema would reject, and every later request would fail against a
 * database that is otherwise fine. applySchema therefore builds the index with a
 * repair path: try the CREATE, and only if it trips over duplicates, collapse
 * them (earliest created keeps the address) and build again.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

/** The v3 users shape as first provisioned, before the email index existed. */
const LEGACY_USERS =
  `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`;

const insertUser = (id: string, email: string | null, createdAt: number) =>
  `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at)
   VALUES ('${id}', '${id}', ${email ? `'${email}'` : "NULL"}, 'member', 'hash-${id}', 0, ${createdAt})`;

describe("the users.email unique-index migration", () => {
  let d1: SqliteD1;
  const envFor = (sqlite: SqliteD1) => makeTestEnv(undefined, { DB: sqlite.db as unknown as D1Database });

  beforeEach(resetDatabaseInit);
  afterEach(() => d1?.close());

  it("resolves duplicate emails, keeping the earliest holder, then builds the index", async () => {
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(LEGACY_USERS);
    // Alice duplicated by Carol, who was created later; Bob is untouched; Dana
    // has no email at all and must stay exempt.
    await d1.db.exec(insertUser("usr-alice", "shared@co.io", 100));
    await d1.db.exec(insertUser("usr-carol", "shared@co.io", 200));
    await d1.db.exec(insertUser("usr-bob", "bob@co.io", 150));
    await d1.db.exec(insertUser("usr-dana", null, 300));

    await initializeDatabase(envFor(d1));

    const rows = (await d1.db.prepare(`SELECT id, email FROM users ORDER BY created_at`).all())
      .results as { id: string; email: string | null }[];
    expect(rows).toEqual([
      { id: "usr-alice", email: "shared@co.io" },
      { id: "usr-bob", email: "bob@co.io" },
      { id: "usr-carol", email: null },
      { id: "usr-dana", email: null },
    ]);

    // The constraint is live afterwards: a fourth writer cannot resurrect the
    // duplicate, while a fresh address and NULL both land.
    await expect(
      d1.db.prepare(insertUser("usr-echo", "shared@co.io", 400)).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
    await expect(d1.db.prepare(insertUser("usr-frank", "frank@co.io", 500)).run()).resolves.toBeTruthy();
  });

  it("builds the index on a clean legacy brain without touching any row", async () => {
    d1 = makeSqliteD1({ schema: false });
    await d1.db.exec(LEGACY_USERS);
    await d1.db.exec(insertUser("usr-alice", "alice@co.io", 100));

    await initializeDatabase(envFor(d1));

    const index = await d1.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_email'`,
    ).first();
    expect(index).toBeTruthy();
    const rows = (await d1.db.prepare(`SELECT id, email FROM users`).all())
      .results as { id: string; email: string | null }[];
    expect(rows).toEqual([{ id: "usr-alice", email: "alice@co.io" }]);
  });
});
