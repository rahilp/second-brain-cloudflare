/**
 * GET /brief against real SQLite: what it returns, and what it costs.
 *
 * The brief runs on every app open, so its cost is a product decision, not an
 * implementation detail — a free-plan Worker invocation gets roughly 50 D1
 * queries, and an endpoint that quietly grew to a dozen would eat a quarter of
 * that before the user typed anything. The count is pinned here for the same
 * reason /import's is: the way this regresses is by someone adding "just one
 * more" query to a Promise.all.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
import { withStaleAsOf } from "../../src/memory/stale";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import type { Env } from "../../src/env";

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      for (const st of stmts) await st.run();
      s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true); // the brief must not pay for schema init on every open
  s.issued.length = 0;
  return s;
}

function envOf(s: SqliteD1): Env {
  return makeTestEnv(dbOf(s) as any);
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("GET /brief", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/brief", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("costs a fixed handful of D1 queries regardless of how much is there", async () => {
    sq = await migrated();
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      sq.seed({
        id: `id-${i}`,
        content: `Memory ${i}`,
        createdAt: now - (i % 5) * HOUR,
        source: i % 2 ? "claude-desktop" : "email-gmail",
      });
    }
    sq.issued.length = 0;

    const res = await worker.fetch(req("GET", "/brief"), envOf(sq), ctx);
    expect(res.status).toBe(200);

    // Six reads, run concurrently, plus v3's fixed identity cost on this first
    // request against a fresh database: one token→identity join, and the
    // one-time tenant bootstrap (two lookups + one provisioning batch — memoised
    // per database, so later app opens pay only the join). 6 + 1 + 3 = 10, and
    // one more for the users.last_used_at stamp, which this request owes because
    // the column is NULL on a brain nobody has authenticated against yet. If
    // this goes up further, the endpoint got more expensive for every user on
    // every app open — that is the decision this assertion asks you to make
    // deliberately.
    expect(sq.issued).toHaveLength(11);
  });

  it("does not pay the last_used_at stamp again on the next app open", async () => {
    // The throttle is what keeps the line above a once-an-hour cost rather than
    // a permanent one. Without it every request in the deployment would carry
    // an extra D1 write, which is the version of this feature that would not be
    // worth shipping.
    sq = await migrated();
    sq.seed({ id: "id-0", content: "Memory", createdAt: Date.now() - HOUR });
    // One env, so the tenant bootstrap memo (keyed on env.DB) survives between
    // the two requests the way it does in production.
    const env = envOf(sq);
    await worker.fetch(req("GET", "/brief"), env, ctx);
    await new Promise((resolve) => setImmediate(resolve)); // the stamp is un-awaited
    const cold = sq.issued.length;
    sq.issued.length = 0;

    const res = await worker.fetch(req("GET", "/brief"), env, ctx);

    expect(res.status).toBe(200);
    expect(sq.issued.filter(s => /SET last_used_at/.test(s))).toEqual([]);
    // Six reads and the identity join. Everything else the first open paid for
    // — the bootstrap and the stamp — is gone.
    expect(sq.issued).toHaveLength(7);
    expect(cold).toBeGreaterThan(sq.issued.length);
  });

  it("reports what arrived and where it came from", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "a", content: "From Claude", createdAt: now - HOUR, source: "claude-desktop" });
    sq.seed({ id: "b", content: "From Claude too", createdAt: now - 2 * HOUR, source: "claude-desktop" });
    sq.seed({ id: "c", content: "From mail", createdAt: now - 3 * HOUR, source: "email-gmail" });
    // Older than the window: counted by nobody.
    sq.seed({ id: "old", content: "Last week", createdAt: now - 8 * DAY, source: "cli" });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.captured).toBe(3);
    expect(data.sources).toEqual([
      { source: "claude-desktop", count: 2 },
      { source: "email-gmail", count: 1 },
    ]);
  });

  it("surfaces patterns awaiting a decision, and skips dismissed ones", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "p1", content: "You keep deferring the pricing decision", createdAt: now - HOUR, tags: ["auto-insight"] });
    sq.seed({ id: "p2", content: "Dismissed already", createdAt: now - HOUR, tags: ["auto-insight", "status:deprecated"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.patterns.map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("resurfaces an old important memory, never a recent or trivial one", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "old-important", content: "The pricing floor is $6k", createdAt: now - 200 * DAY, importanceScore: 4 });
    sq.seed({ id: "old-trivial", content: "Renewed the domain", createdAt: now - 200 * DAY, importanceScore: 1 });
    sq.seed({ id: "new-important", content: "Shipped today", createdAt: now - HOUR, importanceScore: 5 });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("old-important");
  });

  it("returns a complete activity strip, including the days nothing happened", async () => {
    sq = await migrated();
    const now = Date.now();
    const todayBucket = Math.floor(now / 86400000);
    const todayStart = todayBucket * 86400000;
    sq.seed({ id: "today", content: "Today", createdAt: todayStart + HOUR });
    sq.seed({ id: "older", content: "Four days ago", createdAt: todayStart - 4 * DAY + HOUR });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    // Absent days would compress a quiet fortnight into a busy-looking one.
    expect(data.activity).toHaveLength(14);
    const todayEntry = data.activity.find((d: any) => d.day === todayBucket);
    expect(todayEntry?.count).toBe(1);
    expect(data.activity.filter((d: any) => d.count === 0).length).toBe(12);
  });

  it("reports this week's topics in the user's own vocabulary", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "t1", content: "A", createdAt: now - HOUR, tags: ["signpath", "kind:episodic", "5118"] });
    sq.seed({ id: "t2", content: "B", createdAt: now - 2 * HOUR, tags: ["signpath", "status:canonical"] });
    sq.seed({ id: "old", content: "C", createdAt: now - 30 * DAY, tags: ["ancient-topic"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.topics).toEqual([{ tag: "signpath", count: 2 }]);
  });

  it("counts what quietly degrades recall", async () => {
    sq = await migrated();
    const now = Date.now();
    sq.seed({ id: "u", content: "Never embedded", createdAt: now - HOUR, vectorIds: [] });
    // Tagged through the production writer, not a literal. This fixture used to
    // say "stale:as-of:2026-01-01" — a dated form nothing has ever written — and
    // passed only because the count matched a bare substring. The predicate is
    // exact now, so a fixture that invents a tag shape fails instead of quietly
    // agreeing with itself.
    sq.seed({ id: "s", content: "Possibly out of date", createdAt: now - HOUR, vectorIds: ["v"], tags: withStaleAsOf([]) });
    sq.seed({ id: "ok", content: "Fine", createdAt: now - HOUR, vectorIds: ["v"] });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.attention.unindexed).toBe(1);
    expect(data.attention.stale).toBe(1);
    expect(data.total).toBe(3);
  });

  it("keeps resurfacing something when there are fewer candidates than days", async () => {
    // OFFSET past the end returns no rows, so wrapping against a fixed
    // constant instead of the candidate count would show nothing on most days
    // for a small brain — silently, which is the worst kind.
    sq = await migrated();
    sq.seed({
      id: "only-one",
      content: "The one old important memory",
      createdAt: Date.now() - 200 * DAY,
      importanceScore: 4,
    });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.resurface?.id).toBe("only-one");
  });

  it("answers cleanly on a brain with nothing to say", async () => {
    sq = await migrated();
    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(data.ok).toBe(true);
    expect(data.captured).toBe(0);
    expect(data.sources).toEqual([]);
    expect(data.patterns).toEqual([]);
    expect(data.resurface).toBeNull();
  });
});
