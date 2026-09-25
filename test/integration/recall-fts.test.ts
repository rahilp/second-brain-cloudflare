/**
 * Task 3 (#374 FTS5 lexical arm): keywordSearch's FTS path with LIKE fallback.
 *
 * The dense arm is forced down (VECTORIZE.query rejects) so the keyword arm's
 * SQL is the entire candidate source, same idiom as
 * test/integration/team-recall-scoping.test.ts. These run against real SQLite
 * (test/helpers/sqlite-d1.ts) because the thing under test — bm25 ranking,
 * trigram substring matching, scope/time SQL against entries_fts — cannot be
 * evaluated by the D1 mock's string matcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetFtsReadyMemo } from "../../src/recall/fts";
import { FTS_READY_CACHE_MS, FTS_READY_KV_KEY, KEYWORD_MAX_TOKENS } from "../../src/constants";
import { DEFAULTS } from "../../src/config";
import { CJK_RECALL_FIXTURE } from "../fixtures/cjk-recall";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";
import type { RecallDiagnostics, RecallInternalOptions } from "../../src/recall/types";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

/** Dense arm always fails: the keyword arm's SQL becomes the entire candidate source. */
function recallEnv(sqlite: SqliteD1): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
  });
}

const memberOf = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: ["ws-co"],
  defaultShare: "" as const,
});

/** Seed through the normal insert, then relocate — mirrors team-recall-scoping.test.ts. */
function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

describe("recall keyword arm: FTS5 with LIKE fallback", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    resetFtsReadyMemo();
    sqlite = makeSqliteD1();
    env = recallEnv(sqlite);
    await initializeDatabase(env);
    sqlite.issued.length = 0; // init's own DDL is not part of what these tests assert on
  });
  afterEach(() => sqlite.close());

  it("selects candidates by relevance, not recency", async () => {
    // Three recent rows share the query term once amid a long filler body (low
    // bm25); one very old row repeats the term in a short body (high bm25).
    // LIKE + ORDER BY created_at DESC LIMIT 3 keeps the three recent rows and
    // drops the old one; FTS + bm25 LIMIT 3 keeps the old one instead.
    const now = 2_000_000;
    sqlite.seed({ id: "recentA", content: "the widget shipped to customer alpha along with many other long descriptive words filler filler filler filler filler filler", createdAt: now });
    sqlite.seed({ id: "recentB", content: "the widget shipped to customer beta along with many other long descriptive words filler filler filler filler filler filler", createdAt: now - 1000 });
    sqlite.seed({ id: "recentC", content: "the widget shipped to customer gamma along with many other long descriptive words filler filler filler filler filler filler", createdAt: now - 2000 });
    sqlite.seed({ id: "oldRare", content: "widget widget widget", createdAt: now - 1_000_000 });

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 3 };

    const likeDiagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: likeDiagnostics });
    expect(likeDiagnostics.ftsUsed).toBe(false);
    expect(likeDiagnostics.keywordIds).not.toContain("oldRare");

    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const ftsDiagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: ftsDiagnostics });
    expect(ftsDiagnostics.ftsUsed).toBe(true);
    expect(ftsDiagnostics.keywordIds).toContain("oldRare");
  });

  it("matches CJK substrings through the trigram index", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // jp-29's query tokens ("データベース", "バックアップ") are both >= 3
    // codepoints, so they survive the trigram floor — unlike most of this
    // fixture's 2-character word segments (see jp-01/jp-02, used as distractors).
    const target = CJK_RECALL_FIXTURE.find(item => item.id === "jp-29")!;
    const distractorA = CJK_RECALL_FIXTURE.find(item => item.id === "jp-01")!;
    const distractorB = CJK_RECALL_FIXTURE.find(item => item.id === "jp-02")!;
    let t = 1000;
    for (const item of [target, distractorA, distractorB]) sqlite.seed({ id: item.id, content: item.content, createdAt: t++ });

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: target.query, topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    // v2.2: the FTS query now rides in a batch alongside the liveness check
    // (one subrequest), so its SQL text is in sqlite.batches, not sqlite.issued.
    expect(sqlite.batches.some(batch => batch.some(sql => sql.includes("entries_fts MATCH")))).toBe(true);
    expect(res.matches[0]?.id).toBe(target.id);
  });

  it("applies time bounds and tenancy scope to FTS results", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const now = 100_000;
    seedIn(sqlite, "in-scope", "ws-a", "quarterly roadmap notes", now);
    seedIn(sqlite, "foreign", "ws-b", "quarterly roadmap notes", now);
    seedIn(sqlite, "too-old", "ws-a", "quarterly roadmap notes", now - 100_000);

    const diagnostics: RecallDiagnostics = {};
    const internal: RecallInternalOptions = { identity: memberOf("ws-a"), diagnostics };
    await recallEntries({ query: "roadmap", topK: 10, after: now - 1000, synthesize: false }, env, ctx, undefined, internal);

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toEqual(["in-scope"]);
  });

  it("keeps serving FTS within the readiness TTL after the flag clears, then reverts", async () => {
    // Documented behavior: the readiness answer is cached for
    // FTS_READY_CACHE_MS in both directions, so a cleared flag is observed at
    // most one TTL after the integrity check clears it — the isolate keeps
    // using FTS until then (even with the index row deleted, the match still
    // answers via its shadow row) and must be back on LIKE after the TTL.
    sqlite.seed({ id: "answer", content: "violet marker", createdAt: 1000 });
    sqlite.seed({ id: "peer", content: "violet residue", createdAt: 1001 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "violet", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.ftsUsed).toBe(true);

    // Clear the flag and delete the FTS row: within the TTL the cached true
    // still routes to FTS, and the deleted-content row match (kept) survives
    // only because the join now keys on rowid — this exercises the stale
    // window, documented above.
    await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
    const rowids = (await sqlite.db.prepare(`SELECT rowid FROM entries_fts WHERE rowid = (SELECT rowid FROM entries WHERE id = 'answer')`).first()) as { rowid: number } | null;
    expect(rowids).not.toBeNull();
    await sqlite.db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`).bind(rowids!.rowid).run();

    vi.useFakeTimers();
    try {
      const before = Date.now();
      vi.setSystemTime(before);
      // Fresh cache was set moments ago in real time: still inside the TTL.
      resetFtsReadyMemo();
      await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
      const withinTtl: RecallDiagnostics = {};
      await recallEntries({ query: "violet", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics: withinTtl });
      expect(withinTtl.ftsUsed).toBe(true);

      // Past the TTL the cached true expires: LIKE path serves the candidates.
      resetFtsReadyMemo();
      await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
      vi.setSystemTime(Date.now() + FTS_READY_CACHE_MS + 1);
      const afterTtl: RecallDiagnostics = {};
      const res = await recallEntries({ query: "violet", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics: afterTtl });
      expect(afterTtl.ftsUsed).toBe(false);
      expect(res.matches.map(m => m.id)).toContain("peer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to LIKE when the FTS query throws", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    sqlite.seed({ id: "e1", content: "fallback safety content", createdAt: 1000 });
    await sqlite.db.exec(`DROP TABLE entries_fts`);

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "fallback", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toContain("e1");
  });

  // v2.2 review: the "stale-read" case. A hot-path repair drops a corrupt
  // trigger but the KV ready flag stays "1" (KV was down when the repair
  // tried to clear it). Before the liveness check, entries_fts MATCH still
  // ran fine against a table that had simply stopped syncing — no exception,
  // just silently stale results forever. The liveness check is the fix:
  // correctness never depends on KV.
  it("stale read: ready flag still says 1 but a trigger is gone — recall discards FTS rows and uses LIKE", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    sqlite.seed({ id: "old", content: "searchable marker", createdAt: 1000 });
    await sqlite.db.exec(`DROP TRIGGER entries_fts_insert`);
    // No trigger fires for this insert: entries_fts never learns about it,
    // yet the query itself would still succeed against the live table —
    // exactly why an exception-based fallback alone cannot catch this.
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at) VALUES ('new','new searchable marker','[]','api',1)`,
    ).run();

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "searchable marker", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toContain("new");
  });

  // S1 (v2.2 re-review): a trigger present under the RIGHT name but with a
  // wrong (tampered/drifted) body still "exists" — a names-only liveness
  // check would call this live, and the MATCH query would still run
  // successfully (poisoned content is still content), silently serving an
  // index that stopped syncing correctly. The trigger's exact body — not
  // just its name — is what the liveness check now compares.
  it("wrong-body trigger: right name, tampered body — recall discards FTS rows and uses LIKE", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    sqlite.seed({ id: "old", content: "old searchable", createdAt: 1000 });
    await sqlite.db.exec("DROP TRIGGER entries_fts_insert");
    await sqlite.db.exec(
      `CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
         INSERT INTO entries_fts (rowid,id,content) VALUES (NEW.rowid,NEW.id,'poisoned');
       END`,
    );
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at) VALUES ('new','new searchable','[]','api',1)`,
    ).run();

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "searchable", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toEqual(expect.arrayContaining(["old", "new"]));
  });

  // S1: an ordinary table named entries_fts, with correctly-NAMED triggers,
  // still fools a names-only liveness count (4 objects, right names) — the
  // definition check now catches it directly (wrong table body), and even
  // if it did not, MATCH against a non-fts5 table throws and the existing
  // catch falls back to LIKE regardless.
  it("ordinary table plus named triggers: liveness rejects it on definition, MATCH would have failed anyway", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    await sqlite.db.exec(
      "DROP TRIGGER entries_fts_insert; DROP TRIGGER entries_fts_update; DROP TRIGGER entries_fts_delete; DROP TABLE entries_fts;",
    );
    await sqlite.db.exec(`CREATE TABLE entries_fts (id TEXT, content TEXT)`);
    await sqlite.db.exec(`CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN INSERT INTO entries_fts VALUES (NEW.id,NEW.content); END`);
    await sqlite.db.exec(`CREATE TRIGGER entries_fts_update AFTER UPDATE ON entries BEGIN SELECT 1; END`);
    await sqlite.db.exec(`CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN SELECT 1; END`);
    sqlite.db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at) VALUES ('ordinary','ordinary searchable','[]','api',1)`,
    ).run();

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "searchable", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toContain("ordinary");
  });

  it("keys the FTS join on rowid as well as id", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // Live peer must survive in the LIMIT window, and an id with several FTS
    // rows (a stale duplicate at another rowid) may not fill two slots.
    sqlite.seed({ id: "duplicate", content: "violet marker", createdAt: 1000 });
    sqlite.seed({ id: "peer", content: "violet marker", createdAt: 1001 });
    await sqlite.db.prepare(`INSERT INTO entries_fts (rowid, id, content) VALUES (?, ?, ?)`)
      .bind(50000, "duplicate", "violet marker").run();

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 2 };
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "violet", topK: 5, synthesize: false }, env, ctx, cfg, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toContain("peer");
    expect(diagnostics.keywordIds!.filter(id => id === "duplicate")).toHaveLength(1);

    // A drifted row — an FTS id at a rowid whose entries.id differs — must be
    // excluded rather than resurrecting whatever that rowid maps to now.
    sqlite.db.prepare(`UPDATE entries SET content = 'orchid drift' WHERE id = 'peer'`).run();
    sqlite.db.prepare(`INSERT INTO entries_fts (rowid, id, content) VALUES (?, ?, ?)`)
      .bind(50001, "duplicate", "orchid drift real text").run();
    const driftedDiagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "orchid", topK: 5, synthesize: false }, env, ctx, cfg, { diagnostics: driftedDiagnostics });
    expect(res.matches.map(m => m.id)).toEqual(["peer"]);
    expect(driftedDiagnostics.keywordIds).toEqual(["peer"]);
  });

  it("drops an FTS row whose id disagrees with the entry at its rowid", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // This drift variant occupies the rowid of a live entry but claims another
    // id. Only the id half of the join can tell it apart from that entry, so a
    // rowid-only join would resurrect the wrong entry.
    sqlite.seed({ id: "clean", content: "orchid note", createdAt: 1000 });
    sqlite.seed({ id: "peer", content: "violet marker", createdAt: 1001 });
    await sqlite.db.prepare(`UPDATE entries_fts SET id = 'impostor', content = 'orchid drift real text' WHERE rowid = (SELECT rowid FROM entries WHERE id = 'peer')`).run();

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "orchid", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toEqual(["clean"]);
    expect(res.matches.map(m => m.id)).toEqual(["clean"]);
  });

  it("keeps before exclusive and honors the exact candidate limit", async () => {
    // before is exclusive: the row at exactly `before` is out, the row one
    // tick earlier is in.
    sqlite.seed({ id: "at-before", content: "violet marker", createdAt: 102 });
    sqlite.seed({ id: "before-1", content: "violet marker", createdAt: 101 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "violet", topK: 5, before: 102, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toEqual(["before-1"]);
  });

  it("returns exactly KEYWORD_CANDIDATE_LIMIT keyword candidates", async () => {
    sqlite.seed({ id: "at-before", content: "placeholder", createdAt: 1 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const limit = 5;
    for (let i = 0; i < limit + 3; i++) sqlite.seed({ id: `row-${i}`, content: "violet marker", createdAt: 1000 + i });

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "violet", topK: 20, synthesize: false }, env, ctx, { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: limit }, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    expect(new Set(diagnostics.keywordIds).size).toBe(diagnostics.keywordIds!.length);
    expect(diagnostics.keywordIds).toHaveLength(limit);
  });

  it("stays on LIKE when the ready flag is absent", async () => {
    sqlite.seed({ id: "e1", content: "default path content", createdAt: 1000 });

    const diagnostics: RecallDiagnostics = {};
    const res = await recallEntries({ query: "default", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(res.matches.map(m => m.id)).toContain("e1");
    expect(sqlite.issued.some(sql => sql.includes("entries_fts"))).toBe(false);
  });

  it("routes queries with any sub-trigram-floor token to the LIKE path", async () => {
    // The old builder silently dropped tokens under FTS_MIN_TOKEN_LENGTH, so
    // ftsMatchQuery("v1 widget") searched only "widget" on the FTS path and
    // short-only was unretrievable while ftsUsed read true.
    sqlite.seed({ id: "short-only", content: "v1 release note", createdAt: 1001 });
    sqlite.seed({ id: "long-only", content: "release note about widget", createdAt: 1000 });
    sqlite.seed({ id: "cjk-short", content: "東京 release notes", createdAt: 1002 });
    sqlite.seed({ id: "cjk-long", content: "release notes about widget", createdAt: 1003 });

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: KEYWORD_MAX_TOKENS };
    for (const query of ["v1 widget", "東京 widget"]) {
      resetFtsReadyMemo();
      await env.OAUTH_KV.delete(FTS_READY_KV_KEY);
      const likeDiagnostics: RecallDiagnostics = {};
      await recallEntries({ query, topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: likeDiagnostics });
      expect(likeDiagnostics.ftsUsed).toBe(false);

      resetFtsReadyMemo();
      await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
      const ftsDiagnostics: RecallDiagnostics = {};
      await recallEntries({ query, topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: ftsDiagnostics });

      expect(ftsDiagnostics.ftsUsed).toBe(false);
      expect([...ftsDiagnostics.keywordIds!].sort()).toEqual([...likeDiagnostics.keywordIds!].sort());
    }
    resetFtsReadyMemo();
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "v1 widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics });
    expect(diagnostics.keywordIds).toContain("short-only");
  });

  it("routes queries with a NUL-bearing token to the LIKE path", async () => {
    // "ab\0cd" cleared the old routing check (it is long enough) but
    // ftsMatchQuery still drops it for NUL, so the ready path searched only
    // "widget" and nul-only vanished while ftsUsed read true.
    sqlite.seed({ id: "nul-only", content: "the ab\0cd spec shipped", createdAt: 1001 });
    sqlite.seed({ id: "long", content: "the widget spec shipped", createdAt: 1000 });

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: KEYWORD_MAX_TOKENS };
    const likeDiagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "ab\0cd widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: likeDiagnostics });
    expect(likeDiagnostics.ftsUsed).toBe(false);

    resetFtsReadyMemo();
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    const readyDiagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "ab\0cd widget", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: readyDiagnostics });

    expect(readyDiagnostics.ftsUsed).toBe(false);
    expect(readyDiagnostics.keywordIds).toContain("nul-only");
    expect([...readyDiagnostics.keywordIds!].sort()).toEqual([...likeDiagnostics.keywordIds!].sort());
  });

  it("keeps the 3-codepoint floor token eligible and routes only below it to LIKE", async () => {
    // FTS_MIN_TOKEN_LENGTH is inclusive: "cat" is exactly the floor and the
    // trigram index can match it, so it must stay on FTS; "ca" cannot and must
    // not be silently dropped from the match.
    sqlite.seed({ id: "cat-only", content: "cat scratch fever", createdAt: 1000 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: KEYWORD_MAX_TOKENS };
    const three: RecallDiagnostics = {};
    await recallEntries({ query: "cat", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: three });
    expect(three.ftsUsed).toBe(true);
    expect(three.keywordIds).toEqual(["cat-only"]);

    const two: RecallDiagnostics = {};
    await recallEntries({ query: "ca", topK: 10, synthesize: false }, env, ctx, cfg, { diagnostics: two });
    expect(two.ftsUsed).toBe(false);
    expect(two.keywordIds).toEqual(["cat-only"]);
  });

  it("uses FTS when every token clears the trigram floor", async () => {
    sqlite.seed({ id: "only", content: "quarterly roadmap notes", createdAt: 1000 });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "quarterly roadmap", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toEqual(["only"]);
  });

  it("keeps bm25 order as the fusion rank when FTS serves the rows", async () => {
    // Same distinct-token JS weight for query token "dashboard": one token,
    // word-boundary match in both. A is newer, so the JS weight's created_at
    // tiebreak (and LIKE's newest-first window) put it first; B repeats the
    // token in a much shorter doc, so bm25 ranks it first. The embed mock
    // returns a vector orthogonal to both entries' vectors (which are never
    // queried anyway: VECTORIZE.query rejects, so the dense arm contributes
    // nothing and both entries are keyword-only candidates).
    sqlite.seed({ id: "kw-a", content: "the dashboard redesign shipped last sprint with plenty of filler words padding the document body", createdAt: 2000 });
    sqlite.seed({ id: "kw-b", content: "dashboard dashboard dashboard", createdAt: 1000 });

    const cfg = { ...DEFAULTS, KEYWORD_CANDIDATE_LIMIT: 5 };

    // LIKE: recency decides, A leads.
    const likeDiagnostics: RecallDiagnostics = {};
    const like = await recallEntries({ query: "dashboard", topK: 5, synthesize: false }, env, ctx, cfg, { diagnostics: likeDiagnostics });
    expect(likeDiagnostics.ftsUsed).toBe(false);
    expect(like.matches[0]?.id).toBe("kw-a");

    // FTS: bm25 rank position must survive fusion, B leads.
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    const ftsDiagnostics: RecallDiagnostics = {};
    const fts = await recallEntries({ query: "dashboard", topK: 5, synthesize: false }, env, ctx, cfg, { diagnostics: ftsDiagnostics });
    expect(ftsDiagnostics.ftsUsed).toBe(true);
    expect(fts.matches[0]?.id).toBe("kw-b");
  });

  // Combined review of Tasks 4-6 (FIX 3): the reviewer's FUSION_E2E probe.
  // Pure bm25 rank position buried the exact two-token match — fusion rank 32
  // out of 121, out of the final top 5 — because 120 one-token notes all sit
  // above it in bm25's length-normalized order. The JS boundary/coverage
  // weight is the PRIMARY sort key again; bm25 order only breaks ties within
  // an equal-weight tier.
  it("keeps the exact multi-token match ahead of the one-token crowd when FTS serves rows", async () => {
    const now = Date.now();
    for (let i = 0; i < 60; i++) sqlite.seed({ id: `alpha-${i}`, content: "alpha", createdAt: now });
    for (let i = 0; i < 60; i++) sqlite.seed({ id: `beta-${i}`, content: "beta", createdAt: now });
    sqlite.seed({ id: "strong-exact", content: `alpha beta ${"filler ".repeat(1000)}`, createdAt: now });
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: "alpha beta", topK: 5, hops: 0, synthesize: false },
      env,
      ctx,
      undefined,
      { diagnostics },
    );

    expect(diagnostics.ftsUsed).toBe(true);
    expect(diagnostics.keywordIds).toContain("strong-exact");
    expect(result.matches.map(match => match.id).slice(0, 5)).toContain("strong-exact");
  });

  // The reviewer's LIKE_WEIGHT_ORDER probe, as a permanent mutation guard:
  // the LIKE path must keep its full weight/created_at/id sort. Forcing
  // keywordPreRanked=true onto the LIKE call site is the mutation the
  // combined review found still live; its signature is a fused list ordered
  // by recency (the incoming LIKE order) instead of by weight, which the
  // final RRF score alone can mask.
  it("keeps the LIKE path's weight-first order under a forced pre-ranked flag", async () => {
    // old-strong matches both query tokens (higher JS weight); new-weak is
    // newer but matches only one.
    sqlite.seed({ id: "new-weak", content: "alpha", createdAt: 2000 });
    sqlite.seed({ id: "old-strong", content: "alpha beta", createdAt: 1000 });

    const readOrder = async (internal?: RecallInternalOptions) => {
      const diagnostics: RecallDiagnostics = {};
      const result = await recallEntries(
        { query: "alpha beta", topK: 2, hops: 0, synthesize: false },
        env,
        ctx,
        undefined,
        { diagnostics, ...internal },
      );
      expect(diagnostics.ftsUsed).toBe(false);
      return { ids: result.matches.map(match => match.id), fused: diagnostics.fusedIds ?? [] };
    };

    const strong = await readOrder();
    expect(strong.ids).toEqual(["old-strong", "new-weak"]);
    expect(strong.fused).toEqual(["old-strong", "new-weak"]);
    // Forcing the flag must not change what the fusion produces either.
    expect((await readOrder({ keywordPreRankedOverride: true })).ids).toEqual(["old-strong", "new-weak"]);
  });

  // The mutation's second signature: an equal-weight, equal-created_at tie
  // seeded in reverse id order. Only the id tiebreak can order it, so a
  // pre-ranked passthrough (which keeps the incoming LIKE order) flips the
  // result — this shape is what fails under the mutation even when RRF's
  // weight dominance hides the first one.
  it("orders an equal-weight tie by id, not by the incoming LIKE order", async () => {
    sqlite.seed({ id: "z-tie", content: "violet marker note", createdAt: 1000 });
    sqlite.seed({ id: "a-tie", content: "violet marker note", createdAt: 1000 });

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: "violet", topK: 2, hops: 0, synthesize: false },
      env,
      ctx,
      undefined,
      { diagnostics },
    );
    expect(diagnostics.ftsUsed).toBe(false);
    expect(diagnostics.fusedIds).toEqual(["a-tie", "z-tie"]);
    expect(result.matches.map(match => match.id)).toEqual(["a-tie", "z-tie"]);
  });

  // T-0058 cost-aware routing: distillation's df scan estimates exactly how
  // many rows bm25 would have to score. Past FTS_MATCH_BUDGET, LIKE wins —
  // it stops after KEYWORD_CANDIDATE_LIMIT recency-ordered hits while bm25
  // scores every match.
  it("routes a query whose df sum exceeds the budget to LIKE with ftsRoute like-match-budget", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: "widget gadget ledger", createdAt: i + 1 });

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget gadget", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    // df = 2100 + 2100 = 4200, well over the 2,000 budget.
    expect(diagnostics.ftsRoute).toBe("like-match-budget");
    expect(diagnostics.ftsUsed).toBe(false);
  });

  it("keeps a rare-token query on FTS with ftsRoute fts", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    sqlite.seed({ id: "hit", content: "violet orchid ledger", createdAt: 1 });
    sqlite.seed({ id: "filler", content: "unrelated remark", createdAt: 2 });

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "violet orchid", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsRoute).toBe("fts");
    expect(diagnostics.ftsUsed).toBe(true);
  });

  it("routes a single-token query over the df budget to LIKE", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // A 2,100-row corpus of the query's own token exceeds the same df budget
    // used for multi-token queries.
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: "widget gadget ledger", createdAt: i + 1 });

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    // Every term is saturated, so capped FTS counts fall back to exact LIKE df.
    expect(diagnostics.distillSource).toBe("like");
    expect(diagnostics.ftsRoute).toBe("like-match-budget");
    expect(diagnostics.ftsUsed).toBe(false);
  });

  it("sits exactly on the budget: sum == budget stays on FTS, sum == budget+1 routes to LIKE", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    // Two tokens at df 1,000 each: the sum is exactly FTS_MATCH_BUDGET.
    for (let i = 0; i < 1000; i++) sqlite.seed({ id: `row-${i}`, content: "widget gadget ledger", createdAt: i + 1 });

    const atBudget: RecallDiagnostics = {};
    await recallEntries({ query: "widget gadget", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics: atBudget });
    expect(atBudget.ftsRoute).toBe("fts");
    expect(atBudget.ftsUsed).toBe(true);

    // One more widget-only row pushes the sum to 2,001 — the first value
    // over the budget — so the same query flips to LIKE.
    sqlite.seed({ id: "extra", content: "widget only", createdAt: 0 });
    const oneOver: RecallDiagnostics = {};
    await recallEntries({ query: "widget gadget", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics: oneOver });
    expect(oneOver.ftsRoute).toBe("like-match-budget");
    expect(oneOver.ftsUsed).toBe(false);
  });

  // Final fix round: distillation's df scan counts the deterministic variants
  // retrieval appends, so a plural query estimates like its singular — the
  // same over-budget corpus routes both spellings to LIKE, not just one.
  it("routes the plural form like its singular once variants are counted", async () => {
    await env.OAUTH_KV.put(FTS_READY_KV_KEY, "1");
    resetFtsReadyMemo();
    for (let i = 0; i < 2100; i++) sqlite.seed({ id: `row-${i}`, content: "widgets gadgets ledger", createdAt: i + 1 });

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widgets gadgets", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });

    // widgets 2100 + gadgets 2100, plus the folded widget/gadget variants.
    expect(diagnostics.ftsRoute).toBe("like-match-budget");
    expect(diagnostics.ftsUsed).toBe(false);
  });

  // Final fix round (review item 5): memberFirst recalls never reach
  // keywordSearch, so the route is named at the branch — ftsRoute is set on
  // every recall path.
  it("records ftsRoute like-member-first on a tag-scoped recall", async () => {
    const scopedEnv = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockRejectedValue(new Error("index unavailable")),
        getByIds: vi.fn().mockResolvedValue([{ id: "v1", values: new Array(384).fill(0.1), metadata: { parentId: "tagged-1" } }]),
      }),
    });
    sqlite.seed({ id: "tagged-1", content: "widget gadget", createdAt: 1, tags: ["project:x"], vectorIds: ["v1"] });

    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "widget", topK: 5, tag: "project:x", synthesize: false }, scopedEnv, ctx, undefined, { diagnostics });

    expect(diagnostics.ftsUsed).toBe(false);
    expect(diagnostics.ftsRoute).toBe("like-member-first");
  });

  // FIX 2 (final review): a tag/project recall used to return zero matches
  // whenever every member row had no vector yet (vector_ids = []), even when
  // its content matched the query exactly. It now continues with empty
  // dense results and allows keyword-only fusion, the same degrade the
  // non-memberFirst path already applies when Vectorize itself is down.
  it("returns an exact tag match that has no vector yet, instead of dropping it", async () => {
    const scopedEnv = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockRejectedValue(new Error("index unavailable")),
        getByIds: vi.fn().mockResolvedValue([]),
      }),
    });
    sqlite.seed({ id: "tagged-vectorless", content: "exact tagged memory", createdAt: 1, tags: ["work"] });

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: "exact tagged memory", topK: 5, tag: "work", synthesize: false },
      scopedEnv, ctx, undefined, { diagnostics },
    );

    expect(result.matches.map(m => m.id)).toContain("tagged-vectorless");
    expect(diagnostics.ftsRoute).toBe("like-member-first");
  });

  // A tag that matches no member rows at all is a genuinely different case
  // from "matched rows with no vector" above — it must still return empty,
  // but with diagnostics initialized the same as every other path (FIX 2).
  it("still returns empty for a tag with no matching rows, diagnostics initialized", async () => {
    const scopedEnv = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
    });

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query: "missing tag query", topK: 5, tag: "does-not-exist", synthesize: false },
      scopedEnv, ctx, undefined, { diagnostics },
    );

    expect(result.matches).toEqual([]);
    expect(diagnostics.ftsRoute).toBe("like-member-first");
    expect(diagnostics.ftsUsed).toBe(false);
    expect(diagnostics.keywordIds).toEqual([]);
  });
});
