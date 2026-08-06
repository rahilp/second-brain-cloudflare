/**
 * All four nightly jobs are fired from a single scheduled() invocation (src/index.ts),
 * so they share ONE subrequest budget — 50 on the free plan. Each of them awaits
 * initializeDatabase, so before it was memoised the same thirteen DDL statements were paid
 * for once per job, and the pass that runs last could find the budget already spent.
 *
 * Memoisation cut that to thirteen; #282 cut the thirteen to a single catalogue read
 * on any brain that is already migrated, which every brain is after its first request.
 * The D1 mock answers the probe as a migrated brain, which is what a nightly cron always
 * runs against — a brain with no schema has no entries to compress.
 *
 * This measures the whole invocation rather than any one job, because per-job budget
 * assertions are not true in situ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { resetDatabaseInit } from "../../src/db/init";
import { SYNC_EVENT_BATCH } from "../../src/integrations/calendar";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import { makeTestDb, makeTestEnv, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/env";
import { INTEGRATION_SYNC_CRON } from "../../src/integrations/mirror";
import { INTEGRATION_PROVIDERS } from "../../src/integrations";

const FREE_PLAN_SUBREQUESTS = 50;
const MAINTENANCE_CRON = "0 1 * * *";

// D1 bills EXECUTIONS: run/first/all/exec spend one each, and a batch() spends one however
// many statements it carries. Counting prepares instead would price the batched writes in
// the compression and staleness passes as if they were still one round trip per row —
// which is exactly the cost this budget is meant to track.
function countingEnv(db: D1Mock, overrides: Partial<Env> = {}) {
  const statements: string[] = [];
  const bill = (sql: string) => statements.push(sql.replace(/\s+/g, " ").trim());
  const wrap = (stmt: any, sql: string): any => ({
    bind: (...a: any[]) => wrap(stmt.bind(...a), sql),
    run: () => { bill(sql); return stmt.run(); },
    first: (...a: any[]) => { bill(sql); return stmt.first(...a); },
    all: () => { bill(sql); return stmt.all(); },
    __inner: stmt,
  });
  const prepared: string[] = [];
  const DB = {
    prepare(sql: string) { prepared.push(sql.replace(/\s+/g, " ").trim()); return wrap(db.prepare(sql), sql); },
    exec(sql: string) { bill(sql); return db.exec(sql); },
    batch: (stmts: any[]) => { bill("BATCH"); return db.batch(stmts.map((s: any) => s.__inner ?? s)); },
  } as unknown as D1Database;
  return { env: makeTestEnv(db, { DB, VECTORIZE: makeVectorizeMock(), ...overrides }), statements, prepared };
}

// Each tag gets more than the ten eligible entries a digest needs, so nightly compression
// actually runs. Without that the budget test measures a cron with its largest job idle.
function seedCompressibleTags(db: D1Mock, tagCount: number) {
  const old = Date.now() - STALENESS_AGE_MS - 86400000;
  for (let t = 0; t < tagCount; t++) {
    for (let i = 0; i < 11; i++) {
      db.entries.push({
        id: `t${t}-e${i}`, content: `Person ${i} works at Company ${t}`, tags: JSON.stringify([`topic-${t}`]),
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
  }
}

// ─── Integration fixture ──────────────────────────────────────────────────────
// A connected calendar with a backlog far larger than one batch, so the cron is
// measured with the integration job doing as much work as it is ever allowed to.

function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsWithUpcomingEvents(count: number): string {
  const now = Date.now();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN"];
  for (let i = 0; i < count; i++) {
    const start = now + (i + 1) * 3600_000; // hourly, inside the 30-day window
    lines.push(
      "BEGIN:VEVENT", `UID:evt-${i}@test`, `DTSTAMP:${icsUtc(now)}`,
      `DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(start + 1800_000)}`,
      `SUMMARY:Event ${i}`, "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// The feed URL carries the provider id so a stubbed fetch can tell the
// connections apart when more than one is wired up.
async function connectCalendar(
  kv: KVNamespace,
  eventCount: number,
  providers: string[] = ["calendar-google"],
): Promise<ReturnType<typeof vi.fn>> {
  for (const [i, id] of providers.entries()) {
    await kv.put(`integrations:${id}`, JSON.stringify({
      provider: id,
      authKind: "token",
      credentials: { token: `https://cal.example/${id}/feed.ics` },
      config: {},
      status: "connected",
      workspaceName: id,
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 0,
      // Distinct so the rotation has a defined starting order.
      updatedAt: i,
    }));
  }
  const ics = icsWithUpcomingEvents(eventCount);
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => ics }) as any);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Consecutive runs in a test land in the same millisecond, which the real
// schedule never does — and the rotation cursor is a timestamp, so equal
// timestamps tie and registry order wins every time. Step a fake clock by an
// hour per run so a multi-run test models the schedule it is describing.
function hourlyClock(): (run: number) => void {
  const base = Date.now();
  const spy = vi.spyOn(Date, "now");
  return (run: number) => spy.mockReturnValue(base + run * 3600_000);
}

// `cron` selects which invocation is being measured — the two schedules are two
// separate budgets, so a run has to name the one it means (#290).
async function runCron(env: any, cron = MAINTENANCE_CRON) {
  const pending: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any;
  await (worker as any).scheduled({ cron } as any, env, ctx);
  await Promise.allSettled(pending);
}

describe("nightly cron D1 subrequest cost", () => {
  beforeEach(() => {
    resetDatabaseInit();
    vi.restoreAllMocks();
  });

  it("probes the schema once per invocation, not once per job, and issues no DDL", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    // The signature statement of initializeDatabase, once for the whole cron.
    expect(statements.filter(s => s.startsWith("SELECT type AS kind, name FROM sqlite_master"))).toHaveLength(1);
    // #282: the schema is already there, and the whole point is that finding that out no
    // longer costs a CREATE and an ALTER per object.
    expect(statements.filter(s => /^(CREATE|ALTER)\b/.test(s))).toEqual([]);
  });

  // The staleness pass used to be the largest consumer of this budget: one CAS per
  // candidate, and in situ it runs concurrently with the compression job's writes, so its
  // guards lose and it pays for re-reads and retries on top. Batched, the whole pass is a
  // candidate query and one write round trip.
  it("keeps a nightly run with every job busy inside the budget", async () => {
    const db = makeTestDb();
    seedCompressibleTags(db, 7);
    const { env, statements } = countingEnv(db);

    await runCron(env);

    expect(db.entries.filter(e => JSON.parse(e.tags).includes("synthesized")).length).toBeGreaterThan(0);
    expect(db.entries.filter(e => e.staleness_checked_at != null)).toHaveLength(25);
    expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  it("keeps a whole nightly run inside the free-plan subrequest budget", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    for (let i = 0; i < 25; i++) {
      db.entries.push({
        id: `job-${i}`, content: `Person ${i} works at Company ${i}`, tags: "[]",
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
      });
    }
    const { env, statements } = countingEnv(db);

    await runCron(env);

    expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  it("still leaves the staleness pass room to run after the other jobs", async () => {
    const db = makeTestDb();
    const old = Date.now() - STALENESS_AGE_MS - 86400000;
    db.entries.push({
      id: "job", content: "Bob works at Example Inc", tags: "[]",
      source: "api", created_at: old, updated_at: old, vector_ids: "[]",
    });
    const { env } = countingEnv(db);

    await runCron(env);

    const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
    expect(tags).toContain("stale:as-of");
  });

  // ─── The integration sync's own invocation (#290) ──────────────────────────
  // The mirror sync used to be the fourth job on this invocation, sized against
  // an accounting that counted only the ONE outbound fetch a sync makes. What a
  // batch actually costs is the bindings each mirrored item touches — two D1
  // queries per created entry, three per updated one — so its five batches were
  // 100 D1 queries in an invocation that allows 50 in total. Even one batch only
  // fitted while the batch was creates and exactly one provider was connected.
  // It now runs on its own schedule, so these are two budgets to keep, not one.

  describe("the integration schedule", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("runs one batch, and records the cursor the next run resumes from", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      // One batch is one feed fetch and one expansion of it — the expansion is
      // the CPU half of #290, so paying it once per run is the point.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);

      const saved = JSON.parse((await kv.get("integrations:calendar-google")) as string);
      expect(Object.keys(saved.itemMap)).toHaveLength(SYNC_EVENT_BATCH);
      expect(saved.lastSyncedAt).not.toBeNull();
    });

    it("keeps its own invocation inside the D1 budget", async () => {
      const db = makeTestDb();
      seedCompressibleTags(db, 7); // a big brain must not make the sync cost more
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120);
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);
      expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });

    // The multiplier the rotation exists to remove: syncing every connected
    // provider in one invocation measured 70 D1 queries with two calendars.
    it("syncs one provider per run however many are connected", async () => {
      const db = makeTestDb();
      seedCompressibleTags(db, 7);
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook", "calendar-icloud"]);
      const { env, statements } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.entries.filter(e => e.source.startsWith("calendar-"))).toHaveLength(SYNC_EVENT_BATCH);
      expect(statements.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    });

    it("rotates to the least recently attempted provider on the next run", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);
      resetDatabaseInit();
      await runCron(env, INTEGRATION_SYNC_CRON);

      // Each got exactly one batch — the second run did not repeat the first's
      // provider, which is what stops one connection starving the others.
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(SYNC_EVENT_BATCH);
      expect(db.entries.filter(e => e.source === "calendar-outlook")).toHaveLength(SYNC_EVENT_BATCH);
    });

    // A provider whose token has expired writes updatedAt but never lastSyncedAt.
    // Ordering the rotation by lastSyncedAt would therefore pick it every single
    // run, forever, and the working connection would never sync again.
    it("does not let a permanently failing provider starve a working one", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });
      const ics = icsWithUpcomingEvents(120);
      // calendar-google's feed is broken; calendar-outlook's is fine.
      vi.stubGlobal("fetch", vi.fn(async (url: any) => {
        if (String(url).includes("calendar-google")) throw new Error("401 Unauthorized");
        return { ok: true, status: 200, text: async () => ics } as any;
      }));

      const tick = hourlyClock();
      for (let run = 0; run < 4; run++) {
        tick(run);
        resetDatabaseInit();
        await runCron(env, INTEGRATION_SYNC_CRON);
      }

      const failing = JSON.parse((await kv.get("integrations:calendar-google")) as string);
      expect(failing.status).toBe("error");
      // The working provider kept getting turns rather than being locked out —
      // four runs, so two of them were its.
      expect(db.entries.filter(e => e.source === "calendar-outlook"))
        .toHaveLength(2 * SYNC_EVENT_BATCH);
    });

    // The case above is an error the provider's own handler catches, so the
    // provider persists updatedAt itself. This is the one where it does not:
    // a throw escaping the handler is swallowed by job() in src/index.ts, and
    // nothing about the record was written. If the rotation trusted providers to
    // advance their own cursor, this provider would be re-selected every run
    // forever — and, because its item map did not persist either, would re-mirror
    // the same batch under fresh ids each time.
    it("advances past a provider whose sync throws past its own handler", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      await connectCalendar(kv, 120, ["calendar-google", "calendar-outlook"]);
      const { env } = countingEnv(db, { OAUTH_KV: kv });
      vi.spyOn(INTEGRATION_PROVIDERS["calendar-google"], "sync")
        .mockRejectedValue(new Error("KV write failed inside saveIntegration"));

      const tick = hourlyClock();
      for (let run = 0; run < 4; run++) {
        tick(run);
        resetDatabaseInit();
        await runCron(env, INTEGRATION_SYNC_CRON);
      }

      // Two of the four runs went to the provider that works.
      expect(db.entries.filter(e => e.source === "calendar-outlook"))
        .toHaveLength(2 * SYNC_EVENT_BATCH);
      // And the thrower never mirrored anything, so there are no duplicate
      // re-creations to find.
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(0);
    });
  });

  // ─── Routing (#290) ────────────────────────────────────────────────────────
  // The split only buys anything if scheduled() actually branches. A handler
  // that ignored event.cron would run every job on BOTH triggers, which is
  // strictly worse than before: the same shared cost, now paid hourly.

  describe("cron routing", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("does not run the mirror sync on the maintenance schedule", async () => {
      const db = makeTestDb();
      const kv = makeMemoryKV();
      const fetchMock = await connectCalendar(kv, 120);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, MAINTENANCE_CRON);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.entries.filter(e => e.source === "calendar-google")).toHaveLength(0);
    });

    it("does not run the maintenance jobs on the integration schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const kv = makeMemoryKV();
      await connectCalendar(kv, 1);
      const { env } = countingEnv(db, { OAUTH_KV: kv });

      await runCron(env, INTEGRATION_SYNC_CRON);

      // The staleness pass is the cheapest maintenance job to detect: on the
      // maintenance schedule this same entry comes back tagged.
      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).not.toContain("stale:as-of");
    });

    it("falls back to maintenance for an unrecognised schedule", async () => {
      const db = makeTestDb();
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Bob works at Example Inc", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });
      const { env } = countingEnv(db);

      await runCron(env, "*/5 * * * *");

      const tags: string[] = JSON.parse(db.entries.find(e => e.id === "job")!.tags);
      expect(tags).toContain("stale:as-of");
    });
  });
});
