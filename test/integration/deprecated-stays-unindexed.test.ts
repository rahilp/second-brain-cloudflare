/**
 * An empty `vector_ids` means two opposite things.
 *
 * Either the entry failed to embed and should be retried, or `deprecateEntry`
 * deleted its vectors on purpose and it must be left alone. Everything that
 * counted or repaired "unindexed" entries read only the first meaning, so
 * dismissing a pattern — the ordinary way a user says "no, that isn't a real
 * pattern" — raised the "not searchable" count, and pressing "Vectorize now"
 * embedded the dismissed pattern straight back into the index.
 *
 * These run against real SQLite rather than the SQL-matching mock, because the
 * bug was in a WHERE clause: a mock that recognises the query by substring
 * would have passed both before and after the fix.
 */
import { describe, it, expect, afterEach } from "vitest";
import worker from "../../src/index";
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
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      // Each statement's rows are kept, not discarded: a batch carries reads as
      // well as writes now — identity resolution pairs its SELECT with the
      // throttled last_used_at stamp so the pair costs one subrequest — and D1
      // returns a result per statement. `changes: 1` is preserved for the write
      // paths that read it.
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1): Env => makeTestEnv(dbOf(s) as any);

/** Older than the embedding grace window, so the repair paths consider it. */
const PAST_GRACE = Date.now() - 600_000;

const tagsOf = (s: SqliteD1, id: string) =>
  JSON.parse((s.rows().find(r => r.id === id)!.tags as string) ?? "[]") as string[];
const vectorsOf = (s: SqliteD1, id: string) =>
  JSON.parse((s.rows().find(r => r.id === id)!.vector_ids as string) ?? "[]") as string[];

describe("a dismissed pattern", () => {
  it("is not counted as not-searchable by the brief", async () => {
    sq = await migrated();
    sq.seed({ id: "genuinely-broken", content: "Failed to embed", createdAt: PAST_GRACE, vectorIds: [] });
    sq.seed({
      id: "dismissed",
      content: "You keep deferring the pricing decision",
      createdAt: PAST_GRACE,
      tags: ["auto-insight", "status:deprecated"],
      vectorIds: [],
    });

    const data = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    // One, not two: the user's own decision is not a defect to report back.
    expect(data.attention.unindexed).toBe(1);
  });

  it("is not offered for repair in the settings count", async () => {
    sq = await migrated();
    sq.seed({ id: "genuinely-broken", content: "Failed to embed", createdAt: PAST_GRACE, vectorIds: [] });
    sq.seed({ id: "dismissed", content: "Not a real pattern", createdAt: PAST_GRACE, tags: ["auto-insight", "status:deprecated"], vectorIds: [] });

    const data = await (await worker.fetch(req("GET", "/stats"), envOf(sq), ctx)).json() as any;
    expect(data.unvectorized).toBe(1);
  });

  it("is left alone by Vectorize now", async () => {
    sq = await migrated();
    sq.seed({ id: "genuinely-broken", content: "Failed to embed", createdAt: PAST_GRACE, vectorIds: [] });
    sq.seed({ id: "dismissed", content: "Not a real pattern", createdAt: PAST_GRACE, tags: ["auto-insight", "status:deprecated"], vectorIds: [] });

    const data = await (await worker.fetch(req("POST", "/vectorize-pending"), envOf(sq), ctx)).json() as any;
    expect(data.processed).toBe(1);
    expect(vectorsOf(sq, "genuinely-broken").length).toBeGreaterThan(0);
    // Still empty: the dismissal holds.
    expect(vectorsOf(sq, "dismissed")).toEqual([]);
  });

  it("does not leave the repair loop with work it refuses to do", async () => {
    // The dashboard presses this until `remaining` reaches 0. Counting rows the
    // select skips would spin until the no-progress guard gave up.
    sq = await migrated();
    sq.seed({ id: "dismissed", content: "Not a real pattern", createdAt: PAST_GRACE, tags: ["status:deprecated"], vectorIds: [] });

    const data = await (await worker.fetch(req("POST", "/vectorize-pending"), envOf(sq), ctx)).json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });
});

describe("dismissing a pattern, end to end", () => {
  it("does not raise the not-searchable count, and survives Vectorize now", async () => {
    sq = await migrated();
    sq.seed({
      id: "p1",
      content: "You keep deferring the pricing decision",
      createdAt: PAST_GRACE,
      tags: ["auto-insight"],
      vectorIds: ["p1"],
    });

    const before = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(before.attention.unindexed).toBe(0);
    expect(before.patterns.map((p: any) => p.id)).toEqual(["p1"]);

    const dismissed = await worker.fetch(
      req("POST", "/patterns/resolve", { body: { id: "p1", action: "dismiss" } }),
      envOf(sq), ctx,
    );
    expect(dismissed.status).toBe(200);
    // Deprecation is what dismissal *is* — the vectors go, deliberately.
    expect(tagsOf(sq, "p1")).toContain("status:deprecated");
    expect(vectorsOf(sq, "p1")).toEqual([]);

    const after = await (await worker.fetch(req("GET", "/brief"), envOf(sq), ctx)).json() as any;
    expect(after.attention.unindexed).toBe(0);
    expect(after.patterns).toEqual([]);

    // And the repair button does not undo the decision.
    await worker.fetch(req("POST", "/vectorize-pending"), envOf(sq), ctx);
    expect(vectorsOf(sq, "p1")).toEqual([]);
  });

  it("keeps confirming a pattern working, which must still be indexed", async () => {
    // The mirror case: confirm promotes the pattern into recall, so nothing here
    // may treat it as deprecated.
    sq = await migrated();
    sq.seed({ id: "p2", content: "You review PRs in the evening", createdAt: PAST_GRACE, tags: ["auto-insight"], vectorIds: ["p2"] });

    await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p2", action: "confirm" } }), envOf(sq), ctx);
    const tags = tagsOf(sq, "p2");
    expect(tags).not.toContain("auto-insight");
    expect(tags).not.toContain("status:deprecated");
    expect(vectorsOf(sq, "p2")).toEqual(["p2"]);
  });
});
