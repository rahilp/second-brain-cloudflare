/**
 * #288 — recall must not scan the tag table on every call.
 *
 * `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value` is a
 * full table scan expanded once per tag per row, and `inferQueryTags` ran it on
 * every recall. Measured on workerd D1 through Miniflare (`meta.rows_read`), one
 * `recallEntries({ query, topK: 5 })` at four tags an entry:
 *
 *   entries   tag scan   whole recall   whole recall    GET /tags   recalls/day
 *                            (before)        (after)   before→after   before→after
 *   1,000        9,000         11,000          2,000     9,000 → 0     454 → 2,500
 *   5,000       45,000         55,000         10,000    45,000 → 0      90 →   500
 *   20,000     180,000        220,000         40,000   180,000 → 0      22 →   125
 *
 * D1's free plan allows 5M rows read per day and fails every query on the account
 * until 00:00 UTC once that is spent. The scan was 82% of a recall, and the MCP
 * clients this project ships instructions for recall at the start of every
 * conversation and every few messages after — so 90 a day on a 5,000-memory brain
 * was ordinary use, not a stress test.
 *
 * No rewrite makes that query sub-linear — every variant plans identically on real
 * SQLite (`SCAN entries`, `SCAN json_each`, temp b-tree, with or without ORDER BY, as
 * a GROUP BY, with a LIMIT, with an index on `tags`) — so the tests below are about
 * the query *not running*, and about every way it can fail to run costing a boost
 * rather than a result.
 *
 * The rebuild that remains does drop `ORDER BY value` and sort in JS, which is 44%
 * off its rows read for identical output (5,000 entries: 45,000 → 25,000; 20,000:
 * 180,000 → 100,000). Identical plans, different costs: the DISTINCT b-tree has to be
 * walked back out to emit in order. `orders the vocabulary identically to the SQL it
 * replaced` below is what keeps that honest.
 *
 * Driven against real SQLite (`test/helpers/sqlite-d1.ts`) with every statement
 * recorded, because what is under test is which statements are issued.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { inferQueryTags } from "../../src/recall/distill";
import { captureEntry } from "../../src/capture/entry";
import { handleEntriesRoutes } from "../../src/routes/entries";
import {
  getTagVocabulary,
  rememberTags,
  TAG_VOCABULARY_KEY,
  TAG_VOCABULARY_MAX_AGE_MS,
} from "../../src/tags/vocabulary";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeKVMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

/** The one statement this issue is about. */
const TAG_SCAN = /SELECT DISTINCT value FROM entries, json_each/;

let sqlite: SqliteD1 | null = null;
afterEach(() => { sqlite?.close(); sqlite = null; });

/** Collects deferred work so a test can await what the Worker would run after responding. */
function makeCtx(): ExecutionContext & { settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {},
    props: {},
    settle: async () => { await Promise.allSettled(pending.splice(0)); },
  } as unknown as ExecutionContext & { settle: () => Promise<void> };
}

interface Harness {
  env: Env;
  issued: string[];
  ctx: ExecutionContext & { settle: () => Promise<void> };
  kv: KVNamespace;
  scans: () => string[];
}

/**
 * A brain with `tags` on every entry, real SQL underneath, and a KV that remembers
 * what was written to it. `failScan` makes the tag scan — and only the tag scan —
 * fail, which is how the degraded paths are reached without breaking recall itself.
 */
function harness(
  entries: { id: string; content: string; tags: string[] }[],
  opts: { failScan?: boolean; kv?: KVNamespace } = {},
): Harness {
  sqlite = makeSqliteD1();
  // `updated_at` is added by ALTER in src/db/init.ts rather than in schema.sql, and
  // that path goes through `exec`, which this facade does not run. Capture writes it
  // and recall's hydration selects it.
  sqlite.db.prepare(`ALTER TABLE entries ADD COLUMN updated_at INTEGER`).run();
  entries.forEach((e, i) => sqlite!.seed({ ...e, createdAt: 1_700_000_000_000 + i }));

  const issued: string[] = [];
  const inner = sqlite.db;
  const DB = {
    prepare(sql: string) {
      issued.push(sql.replace(/\s+/g, " ").trim());
      if (opts.failScan && TAG_SCAN.test(sql)) {
        const boom = () => Promise.reject(new Error("D1_ERROR: network error: SQLITE_ERROR"));
        return { bind: () => ({ all: boom, first: boom, run: boom }), all: boom, first: boom, run: boom };
      }
      return inner.prepare(sql);
    },
    exec: (sql: string) => inner.exec(sql),
  } as unknown as D1Database;

  const kv = opts.kv ?? makeMemoryKV();
  return {
    env: makeTestEnv(undefined, { DB, OAUTH_KV: kv }),
    issued,
    ctx: makeCtx(),
    kv,
    scans: () => issued.filter(s => TAG_SCAN.test(s)),
  };
}

/**
 * Ten entries rather than three: `distillToRareTerms` drops any term occurring in
 * more than QUERY_SATURATION_FRACTION of the corpus, and on a three-row brain a term
 * in one row is already saturated — the query would be distilled to nothing and the
 * recall assertions below would pass on an empty result set.
 */
const CORPUS = [
  { id: "e1", content: "Signed the office lease renewal for the Dublin site", tags: ["work", "legal", "kind:semantic"] },
  { id: "e2", content: "Quarterly planning session moved to Thursday", tags: ["work", "planning", "status:canonical"] },
  { id: "e3", content: "Booked the dentist for next month", tags: ["health", "personal"] },
  { id: "e4", content: "Ran five kilometres before breakfast", tags: ["health"] },
  { id: "e5", content: "Drafted the supplier contract amendment", tags: ["legal"] },
  { id: "e6", content: "Reviewed the hiring pipeline with the team", tags: ["work"] },
  { id: "e7", content: "Bought a bicycle at the weekend", tags: ["personal"] },
  { id: "e8", content: "Trip to the coast in autumn", tags: ["planning", "personal"] },
  { id: "e9", content: "Filed the annual accounts", tags: ["legal", "work"] },
  { id: "e10", content: "Renewed the gym membership", tags: ["health", "personal"] },
];

const ALL_TAGS = ["health", "kind:semantic", "legal", "personal", "planning", "status:canonical", "work"];

describe("the tag vocabulary is scanned once, not per recall", () => {
  it("scans on the first recall and never again while the cache is warm", async () => {
    const h = harness(CORPUS);

    await recallEntries({ query: "what did I decide about the office lease", topK: 5 }, h.env, h.ctx);
    await h.ctx.settle();
    expect(h.scans()).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      await recallEntries({ query: `notes on the quarterly planning session ${i}`, topK: 5 }, h.env, h.ctx);
      await h.ctx.settle();
    }
    expect(h.scans()).toHaveLength(1);
  });

  it("caches what the scan found, under its own key", async () => {
    const h = harness(CORPUS);
    await getTagVocabulary(h.env);

    const raw = await h.kv.get(TAG_VOCABULARY_KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw!);
    expect(stored.tags).toEqual(ALL_TAGS);
    expect(stored.rebuiltAt).toBeGreaterThan(0);
  });

  it("orders the vocabulary identically to the SQL it replaced", async () => {
    // The rebuild drops `ORDER BY value` and sorts in JS instead, for 44% off its
    // rows read. That is only free if the order is the same, and this asserts it
    // against SQLite's own answer rather than against a hand-written expectation —
    // a JS sort that disagreed with BINARY collation would reorder the dashboard's
    // dropdown and pass a literal list quite happily.
    const h = harness(CORPUS);
    const { results } = await h.env.DB.prepare(
      `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
    ).all();
    const fromSql = (results as { value: string }[]).map(r => r.value);

    expect(await getTagVocabulary(h.env)).toEqual(fromSql);
  });

  it("never freezes on a timestamp from the future, however far ahead", async () => {
    // `now - rebuiltAt < MAX_AGE` is satisfied by every future timestamp, so one that
    // is merely clamped to `Date.now()` re-anchors on each read and passes forever:
    // no rebuild is ever scheduled, so nothing can correct it, and a tag deleted from
    // the brain stays in the dropdown for good. Clock skew between the writing isolate
    // and the reading one can produce one; a hand-edited blob certainly can.
    for (const rebuiltAt of [Date.now() + 365 * 86400000, Number.MAX_SAFE_INTEGER]) {
      const h = harness(CORPUS);
      await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["frozen"], rebuiltAt }));

      expect(await getTagVocabulary(h.env)).toEqual(ALL_TAGS);
      expect(h.scans()).toHaveLength(1);
      sqlite?.close();
      sqlite = null;
    }
  });

  it("serves the future-dated list meanwhile rather than answering empty", async () => {
    // Rejecting the timestamp must not reject the vocabulary with it: this is the
    // same degradation as any other aged-out copy, so the caller gets something and
    // the correction happens behind the response.
    const h = harness(CORPUS);
    await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({
      tags: ["frozen"],
      rebuiltAt: Date.now() + 365 * 86400000,
    }));

    expect(await getTagVocabulary(h.env, h.ctx)).toEqual(["frozen"]);
    await h.ctx.settle();
    expect(await getTagVocabulary(h.env, h.ctx)).toEqual(ALL_TAGS);
  });

  it("rebuilds behind the response once the cached copy ages out", async () => {
    const h = harness(CORPUS);
    await getTagVocabulary(h.env);
    expect(h.scans()).toHaveLength(1);

    await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({
      tags: ["stale-only"],
      rebuiltAt: Date.now() - TAG_VOCABULARY_MAX_AGE_MS - 1,
    }));

    // The aged copy is what the caller gets — it is handed back before the rebuild
    // this call scheduled can have finished, which is the whole point of deferring it.
    expect(await getTagVocabulary(h.env, h.ctx)).toEqual(["stale-only"]);

    await h.ctx.settle();
    expect(h.scans()).toHaveLength(2);
    expect(await getTagVocabulary(h.env, h.ctx)).toContain("work");
  });
});

describe("recall results are unchanged — only their cost", () => {
  it("infers the same tags warm as it did cold", async () => {
    const h = harness(CORPUS);

    const cold = await inferQueryTags("notes about legal work", h.env);
    expect(h.scans()).toHaveLength(1);

    const warm = await inferQueryTags("notes about legal work", h.env);
    expect(h.scans()).toHaveLength(1);
    expect(warm).toEqual(cold);
    expect(warm).toEqual(expect.arrayContaining(["legal", "work"]));
  });

  it("returns the same ordered matches warm as cold", async () => {
    const h = harness(CORPUS);
    const ids = async () => (await recallEntries({ query: "office lease renewal", topK: 5 }, h.env, h.ctx)).matches.map(m => m.id);

    const cold = await ids();
    await h.ctx.settle();
    const warm = await ids();

    expect(cold.length).toBeGreaterThan(0);
    expect(warm).toEqual(cold);
  });
});

describe("a tag captured just now is inferable on the next recall", () => {
  it("write-through admits it without waiting for a rebuild", async () => {
    const h = harness(CORPUS);
    await getTagVocabulary(h.env); // the brain has been used before
    expect(h.scans()).toHaveLength(1);

    const result = await captureEntry("Moving the warehouse to #lakehouse next spring", [], "api", h.env, h.ctx);
    expect(result.status).toBe("stored");
    await h.ctx.settle();

    const tags = await inferQueryTags("what is happening with lakehouse", h.env);
    expect(tags).toContain("lakehouse");
    // The whole point: no second scan bought that.
    expect(h.scans()).toHaveLength(1);
  });

  it("does not revert a rebuild that landed while it was working", async () => {
    // Write-through reads, merges, and writes. A rebuild that puts between that read
    // and that write would be undone by it: the older `rebuiltAt` goes back, aging
    // the cache out and buying a second full scan, and the older tag list resurrects
    // whatever the rebuild had just pruned. Re-reading before the put narrows both.
    const h = harness(CORPUS);
    await getTagVocabulary(h.env);
    const aged = Date.now() - TAG_VOCABULARY_MAX_AGE_MS - 1;
    await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["gone", "work"], rebuiltAt: aged }));

    // A rebuild lands in the middle of the write-through: after its read, before its put.
    // Bound before the spy replaces the property, or the double would call itself.
    // `get` is overloaded (single key vs bulk), so it is installed untyped.
    const realGet = (h.kv.get as (k: string) => Promise<string | null>).bind(h.kv);
    let interleaved = false;
    vi.spyOn(h.kv, "get").mockImplementation((async (key: string) => {
      const value = await realGet(key);
      if (!interleaved) {
        interleaved = true;
        await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["work"], rebuiltAt: Date.now() }));
      }
      return value;
    }) as never);

    await rememberTags(h.env, ["lakehouse"]);

    const after = JSON.parse((await realGet(TAG_VOCABULARY_KEY))!);
    expect(after.tags).toEqual(["lakehouse", "work"]);   // the pruned tag stays pruned
    expect(after.rebuiltAt).toBeGreaterThan(aged);        // and the cache is still fresh
  });

  it("does not postpone the rebuild by touching rebuiltAt", async () => {
    // Advancing it on every capture would let an actively used brain never
    // reconcile, so a deleted tag's last mention would never be pruned.
    const h = harness(CORPUS);
    await getTagVocabulary(h.env);
    const before = JSON.parse((await h.kv.get(TAG_VOCABULARY_KEY))!).rebuiltAt;

    await rememberTags(h.env, ["freshly-invented"]);

    const after = JSON.parse((await h.kv.get(TAG_VOCABULARY_KEY))!);
    expect(after.tags).toContain("freshly-invented");
    expect(after.rebuiltAt).toBe(before);
  });

  it("leaves the cache alone when there is nothing cached yet", async () => {
    // The row is already committed by then, so the scan that builds the first
    // cache finds the tag by itself — writing a partial vocabulary would only
    // invent a second source of truth.
    const h = harness(CORPUS);
    await rememberTags(h.env, ["lakehouse"]);
    expect(await h.kv.get(TAG_VOCABULARY_KEY)).toBeNull();
  });
});

describe("every way the cache can fail degrades, and none of them fails a request", () => {
  it("answers recall when the scan itself is broken and nothing is cached", async () => {
    const h = harness(CORPUS, { failScan: true });

    const { matches } = await recallEntries({ query: "office lease renewal", topK: 5 }, h.env, h.ctx);

    // Results, just without the tag boost that vocabulary would have fed.
    expect(matches.length).toBeGreaterThan(0);
    expect(await inferQueryTags("notes about legal work", h.env)).toEqual([]);
  });

  it("answers GET /tags with an empty list rather than a 500", async () => {
    const h = harness(CORPUS, { failScan: true });

    const res = await handleEntriesRoutes(req("GET", "/tags"), new URL("http://localhost/tags"), h.env, h.ctx);

    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it("serves the last good vocabulary when a later scan breaks", async () => {
    const h = harness(CORPUS);
    await getTagVocabulary(h.env);

    await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({
      tags: ["work", "legal"],
      rebuiltAt: Date.now() - TAG_VOCABULARY_MAX_AGE_MS - 1,
    }));
    const broken = harness([], { kv: h.kv, failScan: true });

    expect(await getTagVocabulary(broken.env)).toEqual(["work", "legal"]);
  });

  it("falls back to scanning when KV is unavailable, which is exactly the old cost", async () => {
    // makeKVMock reads null and swallows writes — the shape of a KV outage.
    const h = harness(CORPUS, { kv: makeKVMock() });

    expect(await inferQueryTags("notes about legal work", h.env)).toEqual(expect.arrayContaining(["legal", "work"]));
    expect(await inferQueryTags("notes about legal work", h.env)).toEqual(expect.arrayContaining(["legal", "work"]));
    expect(h.scans()).toHaveLength(2);
  });

  it("rebuilds rather than trusting a blob it cannot read", async () => {
    for (const blob of ["not json at all", '{"tags":"work"}', "null", '{"rebuiltAt":123}']) {
      const h = harness(CORPUS);
      await h.kv.put(TAG_VOCABULARY_KEY, blob);
      expect(await getTagVocabulary(h.env)).toContain("work");
      expect(h.scans()).toHaveLength(1);
      sqlite?.close();
      sqlite = null;
    }
  });

  it("serves a blob whose timestamp is unusable, and reconciles it", async () => {
    const h = harness(CORPUS);
    await h.kv.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags: ["kept"], rebuiltAt: "yesterday" }));

    expect(await getTagVocabulary(h.env, h.ctx)).toEqual(["kept"]);
    await h.ctx.settle();
    expect(await getTagVocabulary(h.env, h.ctx)).toContain("work");
  });

  it("still answers when the cache write fails", async () => {
    const kv = makeMemoryKV();
    vi.spyOn(kv, "put").mockRejectedValue(new Error("KV unavailable"));
    const h = harness(CORPUS, { kv });

    expect(await getTagVocabulary(h.env)).toContain("work");
  });

  it("keeps serving the aged copy when the rebuild behind the response fails", async () => {
    // A rejection inside waitUntil is not a failed request, but it is an unhandled
    // rejection unless it is caught — and the vocabulary it was refreshing has to
    // survive the attempt rather than be cleared by it.
    const kv = makeMemoryKV();
    await kv.put(TAG_VOCABULARY_KEY, JSON.stringify({
      tags: ["work", "legal"],
      rebuiltAt: Date.now() - TAG_VOCABULARY_MAX_AGE_MS - 1,
    }));
    const h = harness(CORPUS, { kv, failScan: true });

    expect(await getTagVocabulary(h.env, h.ctx)).toEqual(["work", "legal"]);
    await expect(h.ctx.settle()).resolves.toBeUndefined();
    expect(await getTagVocabulary(h.env, h.ctx)).toEqual(["work", "legal"]);
  });

  it("swallows a failed write-through rather than failing the capture behind it", async () => {
    const kv = makeMemoryKV();
    const h = harness(CORPUS, { kv });
    await getTagVocabulary(h.env);
    vi.spyOn(kv, "put").mockRejectedValue(new Error("KV unavailable"));

    await expect(rememberTags(h.env, ["lakehouse"])).resolves.toBeUndefined();
  });
});

describe("system tags", () => {
  const SYSTEM = [
    { id: "s1", content: "A rolled-up digest of several older memories", tags: ["synthesized", "rolled-up", "work"] },
    { id: "s2", content: "A memory the staleness pass has looked at", tags: ["volatility:state", "stale:as-of", "work"] },
  ];

  it("are not part of the vocabulary query inference matches against", async () => {
    // They say what the system did to an entry, not what it is about, and the only
    // thing a query tag does is boost entries whose subject overlaps the question.
    const h = harness(SYSTEM);

    const tags = await inferQueryTags("show me the synthesized rolled-up notes", h.env);

    expect(tags).not.toContain("synthesized");
    expect(tags).not.toContain("rolled-up");
  });

  it("still reach GET /tags, which is a browse affordance rather than a ranking input", async () => {
    const h = harness(SYSTEM);

    const res = await handleEntriesRoutes(req("GET", "/tags"), new URL("http://localhost/tags"), h.env, h.ctx);

    expect(await res!.json()).toEqual(["rolled-up", "stale:as-of", "synthesized", "volatility:state", "work"]);
  });
});

describe("GET /tags", () => {
  it("reads the vocabulary a recall warmed, and scans nothing of its own", async () => {
    const h = harness(CORPUS);
    await recallEntries({ query: "office lease renewal", topK: 5 }, h.env, h.ctx);
    await h.ctx.settle();
    expect(h.scans()).toHaveLength(1);

    const res = await handleEntriesRoutes(req("GET", "/tags"), new URL("http://localhost/tags"), h.env, h.ctx);

    expect(await res!.json()).toEqual(ALL_TAGS);
    expect(h.scans()).toHaveLength(1);
  });

  it("warms the same vocabulary recall then reads", async () => {
    const h = harness(CORPUS);
    await handleEntriesRoutes(req("GET", "/tags"), new URL("http://localhost/tags"), h.env, h.ctx);
    expect(h.scans()).toHaveLength(1);

    await inferQueryTags("notes about legal work", h.env);

    expect(h.scans()).toHaveLength(1);
  });
});
