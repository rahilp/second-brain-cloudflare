import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWeeklyInsights, MAX_INSIGHTS_PER_RUN } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// Split out so the cross-run restatement test can seed an already-persisted
// insight entry with the exact same reasoned text without duplicating it.
const GOOD_TEXT = "You priced that tier at nine dollars flat, then reversed course to usage-based pricing instead.";
const GOOD = `{"insight": true, "shape": "contradiction", "text": "${GOOD_TEXT}"}`;

/** The AI mock must serve three callers: embeddings, the classifier inside
 *  captureEntry (streaming SSE), and the reasoning call (also streaming). */
function makeAI(insightPayload: string) {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      // The reasoning prompt is the only one that mentions two memories.
      return sse(prompt.includes("Memory A:") ? insightPayload : "3");
    }),
  } as unknown as Ai;
}

/** Seed n candidates, each with both of its entries present. */
function seedCandidates(sqlite: SqliteD1, n: number) {
  for (let i = 0; i < n; i++) {
    sqlite.seed({
      id: `a-${i}`, createdAt: NOW - 120 * DAY, tags: ["pricing"],
      content: `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`,
    });
    sqlite.seed({
      id: `b-${i}`, createdAt: NOW, tags: ["pricing"],
      content: `Decision: move tier ${i} to usage-based billing; flat pricing left money on the table.`,
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
    ).bind(`cand-${i}`, `a-${i}`, `b-${i}`, 120 * DAY, 10 - i, NOW).run();
  }
}

const statusOf = async (sqlite: SqliteD1, id: string) =>
  ((await sqlite.db.prepare(
    `SELECT status FROM insight_candidates WHERE id = ?`,
  ).bind(id).first()) as { status: string }).status;

const drawnFrom = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT source_id, target_id, provenance FROM edges WHERE type = 'drawn_from'`,
  ).all()).results) as { source_id: string; target_id: string; provenance: string }[];

const insightCount = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
  ).first()) as { n: number }).n;

describe("runWeeklyInsights()", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // initializeDatabase() memoizes its promise at module scope (src/db/init.ts)
    // so the runtime ALTERs (updated_at among them) only ever run once per
    // process. Each test here gets a brand new :memory: database, so without
    // this reset the second test to reach captureEntry's INSERT inherits a
    // stale "already migrated" memo for a database that was never altered.
    resetDatabaseInit();
    sqlite = makeSqliteD1();
  });

  afterEach(() => sqlite.close());

  it("writes at most MAX_INSIGHTS_PER_RUN even when every candidate qualifies", async () => {
    seedCandidates(sqlite, 8);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBeLessThanOrEqual(MAX_INSIGHTS_PER_RUN);
    expect(await insightCount(sqlite)).toBeGreaterThan(0);
  });

  it("writes nothing when every candidate is declined", async () => {
    seedCandidates(sqlite, 2);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(`{"insight": false}`), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
  });

  it("marks a declined candidate rejected so it is never re-proposed", async () => {
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(`{"insight": false}`), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await statusOf(sqlite, "cand-0")).toBe("rejected");
  });

  it("leaves a candidate pending, not rejected, when the model call itself fails", async () => {
    // A refusal is settled; a thrown call is not. Marking this one `rejected`
    // would be the exact bug this behaviour guards against: a transient model
    // outage (a 503, a timeout) would permanently destroy every candidate it
    // touched, and re-accrual cannot resurrect a `rejected` row — the UNIQUE
    // constraint's `ON CONFLICT DO NOTHING` leaves its status untouched.
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any,
      AI: { run: vi.fn().mockRejectedValue(new Error("AI down")) } as unknown as Ai,
      OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await statusOf(sqlite, "cand-0")).toBe("pending");
    expect(await insightCount(sqlite)).toBe(0);
  });

  it("marks an accepted candidate used", async () => {
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("marks a duplicate-blocked candidate used, not rejected, and writes nothing", async () => {
    // A blocked capture is not a refusal from reasonOverPair — the insight was
    // good, but captureEntry found it duplicates an earlier one. This is the
    // non-`stored` path ambiguity resolution #2 calls out: leaving the
    // candidate `pending` would re-propose and re-reason over the same pair
    // every week forever, so it must be `used` even though nothing was written.
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any,
      AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "existing", score: 0.99, metadata: {} }] }),
      }),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("skips a candidate whose entries have since been forgotten", async () => {
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('orphan', 'gone-a', 'gone-b', 0.9, 1, 9.0, 'vector', 'pending', ?)`,
    ).bind(NOW).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "orphan")).toBe("pending");
  });

  it("never re-reads a candidate the model has already declined", async () => {
    // The design's central dedupe (docs/superpowers/specs/2026-08-10-insight-
    // pass-design.md): "a candidate the model has already declined is never
    // re-proposed, and never paid for twice." The test above ("marks a
    // declined candidate rejected") only pins the WRITE half of that — that a
    // decline gets persisted as `rejected`. It says nothing about the READ
    // half: whether a `rejected` row is excluded from the next run's slice at
    // all, as opposed to being re-read and re-declined into the same status
    // every time. This seeds a candidate as already `rejected` and uses an AI
    // mock that would accept every candidate it is asked about, so any read of
    // the rejected row is directly observable as a written insight.
    seedCandidates(sqlite, 1);
    await sqlite.db.prepare(
      `UPDATE insight_candidates SET status = 'rejected' WHERE id = 'cand-0'`,
    ).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("rejected");
  });

  it("reasons over the highest-scored candidates first, not insertion order", async () => {
    // Scoring happens at accrual time solely so this read can be an ordered
    // slice — ORDER BY c.score DESC is the entire reason a candidate earns a
    // score at all. Seeded out of score order on purpose, the same technique
    // test/integration/insight-dry-run.test.ts uses for the same query shape:
    // inserting the top-scoring candidate first would let an ORDER BY bug hide
    // behind insertion order already agreeing with it. Content is tier-keyed
    // so each accepted insight's text is distinct, or captureEntry would block
    // the second and third as duplicates of the first and the test would not
    // be able to tell "read in the right order" apart from "read at all."
    // Distinct means genuinely distinct wording below, not a shared template
    // with the tier digit swapped in: distinctiveTokens (reason.ts) drops a
    // bare digit entirely (it only matches tokens that START with a letter),
    // and even where it didn't, a single differing word out of nine tokens is
    // still ~89% overlap. restatesRecent (wired into weekly.ts by this task)
    // would treat that as the same conclusion restated, collapsing every
    // candidate after the first into "used" without a genuine write and
    // reading past the top three by score to compensate for it — defeating
    // this test's premise. Only tiers 0-2 need to clear both floors (the
    // vocabulary floor against their own entries, and mutual novelty against
    // each other) since 3 and 4 must never be reasoned over at all.
    const tiersInInsertionOrder: [tier: number, score: number][] = [
      [3, 6.6], [0, 9.9], [4, 5.5], [1, 8.8], [2, 7.7],
    ];
    for (const [tier, score] of tiersInInsertionOrder) {
      sqlite.seed({
        id: `a-${tier}`, createdAt: NOW - 120 * DAY, tags: ["pricing"],
        content: `Decision: price tier ${tier} flat at nine dollars a month for predictable billing.`,
      });
      sqlite.seed({
        id: `b-${tier}`, createdAt: NOW, tags: ["pricing"],
        content: `Decision: move tier ${tier} to usage-based billing; flat pricing left money on the table.`,
      });
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`cand-${tier}`, `a-${tier}`, `b-${tier}`, 120 * DAY, score, NOW).run();
    }
    const tieredAI = {
      run: vi.fn().mockImplementation(async (model: string, opts: any) => {
        const sse = (text: string) => new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        const prompt = String(opts?.messages?.[0]?.content ?? "");
        if (!prompt.includes("Memory A:")) return sse("3");
        const tier = prompt.match(/tier (\d+)/)?.[1] ?? "0";
        // Each entry from seed() reads "price tier N flat at nine dollars a
        // month for predictable billing" / "move tier N to usage-based
        // billing; flat pricing left money on the table" — the same for every
        // tier bar the digit distinctiveTokens drops. sharesVocabulary needs
        // one word from {price, nine, dollars, month, predictable} and one
        // from {move, usage-based, pricing, left, money, table} in each text
        // below; restatesRecent needs the three texts to share under 60% of
        // their OWN distinctive tokens pairwise, which a shared template
        // cannot give no matter which single word varies.
        const perTier: Record<string, string> = {
          "0": "You priced this tier at nine dollars flat, then moved it entirely to usage-based billing.",
          "1": "This tier's predictable monthly amount got swapped for money tied to actual usage.",
          "2": "That flat monthly price got left behind once usage-based charges took over.",
          "3": "A fixed quarterly fee here was dropped in favor of billing that scales with usage.",
          "4": "The old flat charge on this plan gave way to invoicing based on money actually spent.",
        };
        return sse(
          `{"insight": true, "shape": "contradiction", "text": "${perTier[tier] ?? perTier["0"]}"}`,
        );
      }),
    } as unknown as Ai;
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: tieredAI, OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    // Score order (desc): tier 0 (9.9), 1 (8.8), 2 (7.7), 3 (6.6), 4 (5.5).
    // MAX_INSIGHTS_PER_RUN is 3, so only the top three by score should ever be
    // read far enough to be reasoned over and written; the bottom two must be
    // untouched.
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
    expect(await statusOf(sqlite, "cand-1")).toBe("used");
    expect(await statusOf(sqlite, "cand-2")).toBe("used");
    expect(await statusOf(sqlite, "cand-3")).toBe("pending");
    expect(await statusOf(sqlite, "cand-4")).toBe("pending");
    expect(await insightCount(sqlite)).toBe(3);
  });

  it("excludes a candidate whose entry was deprecated after it was accrued", async () => {
    // Accrual is nightly and reasoning is weekly, so up to seven days of drift
    // is normal: an entry deprecated on Monday (a contradiction resolution, a
    // dismissed pattern) can still be joined by a candidate accrued the
    // Sunday before. The gap floor and eligibility check at accrual time
    // cannot see a deprecation that has not happened yet, so this has to be
    // enforced again here, at read time.
    seedCandidates(sqlite, 1);
    await sqlite.db.prepare(
      `UPDATE entries SET tags = '["pricing","status:deprecated"]' WHERE id = 'b-0'`,
    ).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("pending");
  });

  it("does not write a second insight that only restates the first", async () => {
    // Two candidate pairs reasoning to the same text is exactly what a corpus
    // full of near-duplicates produces: different pairs, one conclusion.
    // makeAI returns a fixed payload, so both pairs land on identical text —
    // the strongest form of the case, and the one the Aug 16 run produced in
    // weaker form. Default VECTORIZE mock returns no matches (make-env.ts), so
    // captureEntry's own duplicate detection cannot be what blocks the second
    // write — only restatesRecent can.
    seedCandidates(sqlite, 2);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(1);
    // Used, not rejected: the pair reasoned fine, it just landed where the
    // reader has already been. Rejected would re-pay for it on a later run.
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
    expect(await statusOf(sqlite, "cand-1")).toBe("used");
  });

  it("does not write an insight that restates one from an earlier run still in the queue", async () => {
    // The spec's own motivating case: the 2026-08-16 run restated an insight
    // the 2026-08-12 dry run had already produced — a DIFFERENT run, still
    // sitting unreviewed. Within-run tracking alone cannot catch this; the
    // seed list has to include what a reader would already have seen in the
    // queue, not just what this run is about to add to it.
    seedCandidates(sqlite, 1);
    sqlite.seed({
      id: "prior-insight", createdAt: NOW - 4 * DAY, tags: ["auto-insight"],
      content: `${GOOD_TEXT}\n\n[Insight: contradiction — drawn from 2 memories]`,
    });
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    // Only the pre-existing insight is present — the pass wrote nothing new.
    expect(await insightCount(sqlite)).toBe(1);
    // Used, not rejected, for the same reason as the within-run case: the
    // pair reasoned fine, it just landed where the reader has already been.
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  // Measured on the real brain the day D2 shipped: the dry run reported ZERO
  // restatements suppressed, and the queue held ZERO unreviewed insights. The
  // guard had nothing to compare against, because a reviewer who acts on the
  // queue empties the very window the guard reads. A diligent reviewer was
  // switching D2 off.
  //
  // Both exits have to stay in the window, and they leave by different doors:
  // dismiss keeps `auto-insight` and adds `status:deprecated`; confirm STRIPS
  // `auto-insight` outright (admin.ts, so the entry becomes recallable), which
  // leaves no tag saying it was ever an insight. What survives confirmation is
  // the `drawn_from` edges the insight is the source of.
  it("still compares against an insight the reviewer has dismissed", async () => {
    seedCandidates(sqlite, 1);
    sqlite.seed({
      id: "dismissed-insight", createdAt: NOW - 4 * DAY,
      tags: ["auto-insight", "status:deprecated"],
      content: `${GOOD_TEXT}\n\n[Insight: contradiction — drawn from 2 memories]`,
    });
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    // Nothing new written: re-proposing something the reviewer already threw
    // away is the same waste as restating something still in the queue.
    // Counted as "only the seed survives" rather than insightCount() === 0 —
    // the dismissed seed keeps its `auto-insight` tag, so it is itself counted.
    const rows = (await sqlite.db.prepare(
      `SELECT id FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).all()).results as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(["dismissed-insight"]);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("still compares against an insight the reviewer has confirmed", async () => {
    seedCandidates(sqlite, 1);
    // Exactly what confirm leaves behind: no `auto-insight` tag at all, plus
    // the promotion tags. Only its drawn_from edges identify it as an insight.
    sqlite.seed({
      id: "confirmed-insight", createdAt: NOW - 4 * DAY,
      tags: ["kind:semantic", "status:canonical"],
      content: `${GOOD_TEXT}\n\n[Insight: contradiction — drawn from 2 memories]`,
    });
    await sqlite.db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("e1", "confirmed-insight", "some-source", "drawn_from", 1, "system", "{}", NOW - 4 * DAY, NOW - 4 * DAY).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    // A confirmed insight is a real recallable memory now. Writing it again is
    // pure duplication — the worst of the three cases, not the most forgivable.
    expect(await insightCount(sqlite)).toBe(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("does not treat an ordinary memory as a recent insight", async () => {
    // The window must widen to reach confirmed insights without swallowing the
    // whole corpus — every memory would otherwise become a restatement target.
    seedCandidates(sqlite, 1);
    sqlite.seed({
      id: "ordinary", createdAt: NOW - 4 * DAY, tags: ["work", "pricing"],
      content: GOOD_TEXT,
    });
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(1);
  });

  it("records the two memories an insight was drawn from", async () => {
    seedCandidates(sqlite, 1); // seeds candidate cand-0 over entries a-0 and b-0
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    const edges = await drawnFrom(sqlite);
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.target_id).sort()).toEqual(["a-0", "b-0"]);
    expect(new Set(edges.map(e => e.source_id)).size).toBe(1);
    expect(edges.every(e => e.provenance === "system")).toBe(true);
  });

  it("records nothing for an insight that was not stored", async () => {
    // captureEntry declines when duplicate detection blocks the write — the
    // same technique "marks a duplicate-blocked candidate used, not
    // rejected, and writes nothing" above uses to force a non-`stored`
    // result deterministically (a VECTORIZE match scored above the block
    // threshold), rather than relying on restatesRecent, which never reaches
    // captureEntry at all and so cannot exercise this branch. An edge from
    // an entry that was never created would be a dangling row every later
    // reader has to defend against.
    seedCandidates(sqlite, 1);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any,
      AI: makeAI(GOOD),
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [{ id: "existing", score: 0.99, metadata: {} }] }),
      }),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(0);
    expect(await drawnFrom(sqlite)).toHaveLength(0);
  });

  it("does not reason over a candidate whose pair is both assistant-authored, and marks it used", async () => {
    // D1 (isEligiblePair, src/insight/candidates.ts) is wired in at accrual —
    // this pins that the WEEKLY DRAW applies it too, not just accrual. Every
    // candidate accrued before that guard existed is still sitting in the
    // pool under the old rule, so without this check the weekly pass would
    // keep drawing and reasoning over exactly the pairs D1 exists to refuse.
    // Both sides carry the assistant-authored axis tag, and nothing else in
    // this candidate's shape (score, gap, content) is what should block it —
    // only the tag combination.
    sqlite.seed({
      id: "a-0", createdAt: NOW - 120 * DAY, tags: ["work", "claude-response"],
      content: "Decision: price tier 0 flat at nine dollars a month for predictable billing.",
    });
    sqlite.seed({
      id: "b-0", createdAt: NOW, tags: ["work", "codex-response"],
      content: "Decision: move tier 0 to usage-based billing; flat pricing left money on the table.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-0', 'b-0', 0.87, ?, 9.9, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    const ai = makeAI(GOOD);
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: ai, OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    // Never reasoned over: the only AI.run calls left are embeddings, none of
    // which carry the reasoning prompt's distinguishing "Memory A:" string.
    const reasoningCalls = (ai.run as any).mock.calls.filter(
      (c: any) => String(c[1]?.messages?.[0]?.content ?? "").includes("Memory A:"),
    );
    expect(reasoningCalls).toHaveLength(0);
    expect(await insightCount(sqlite)).toBe(0);
    // Used, not pending and not rejected: re-accrual would just re-insert the
    // exact same pair (ON CONFLICT DO NOTHING is keyed on a_id/b_id), so a
    // pending or rejected status here would have the pass re-discover and
    // re-skip this pair forever rather than paying for it once.
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("still reasons over a pair where only one side is assistant-authored", async () => {
    // The case a blunt per-entry exclusion would have destroyed, and the one
    // the spec calls out as most likely to regress (D1's own comment,
    // src/insight/candidates.ts): an assistant's note connected to something
    // the user wrote is a legitimate insight, so the weekly draw must not
    // reject this pair the way it rejects two assistant notes.
    sqlite.seed({
      id: "a-0", createdAt: NOW - 120 * DAY, tags: ["work", "claude-response"],
      content: "Decision: price tier 0 flat at nine dollars a month for predictable billing.",
    });
    sqlite.seed({
      id: "b-0", createdAt: NOW, tags: ["work"],
      content: "Decision: move tier 0 to usage-based billing; flat pricing left money on the table.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-0', 'a-0', 'b-0', 0.87, ?, 9.9, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
    });

    await runWeeklyInsights(env, ctx);

    expect(await insightCount(sqlite)).toBe(1);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("logs one structured line counting candidates reasoned, declined, restatement-suppressed and written", async () => {
    // Spec D2: "D2 is instrumented to make that measurable — if it starts
    // rejecting often, the corpus is telling us D3 is due." Nothing recorded
    // it before this. Four candidates by score (10, 9, 8, 7), each exercising
    // a different outcome so the four counters can't be satisfied by
    // coincidence:
    //  - cand-0 (tier 0): accepted and written.
    //  - cand-1 (tier 1): the model declines it.
    //  - cand-2 (tier 2): accepted by the model, but its text is
    //    byte-identical to cand-0's, so restatesRecent suppresses it.
    //  - cand-3: both sides assistant-authored — D1 (this task's FIX 3)
    //    rejects the pair before reasonOverPair is ever called, so it must
    //    NOT inflate "candidates reasoned".
    const TIER0_TEXT = "You priced this tier at nine dollars flat, then moved it entirely to usage-based billing.";
    const tieredAI = {
      run: vi.fn().mockImplementation(async (model: string, opts: any) => {
        const sse = (text: string) => new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
        const prompt = String(opts?.messages?.[0]?.content ?? "");
        if (!prompt.includes("Memory A:")) return sse("3");
        const tier = prompt.match(/tier (\d+)/)?.[1] ?? "0";
        if (tier === "1") return sse(`{"insight": false}`);
        if (tier === "2") {
          return sse(`{"insight": true, "shape": "contradiction", "text": ${JSON.stringify(TIER0_TEXT)}}`);
        }
        return sse(`{"insight": true, "shape": "contradiction", "text": ${JSON.stringify(TIER0_TEXT)}}`);
      }),
    } as unknown as Ai;

    for (const tier of [0, 1, 2]) {
      sqlite.seed({
        id: `a-${tier}`, createdAt: NOW - 120 * DAY, tags: ["pricing"],
        content: `Decision: price tier ${tier} flat at nine dollars a month for predictable billing.`,
      });
      sqlite.seed({
        id: `b-${tier}`, createdAt: NOW, tags: ["pricing"],
        content: `Decision: move tier ${tier} to usage-based billing; flat pricing left money on the table.`,
      });
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`cand-${tier}`, `a-${tier}`, `b-${tier}`, 120 * DAY, 10 - tier, NOW).run();
    }
    sqlite.seed({
      id: "a-3", createdAt: NOW - 120 * DAY, tags: ["work", "claude-response"],
      content: "Decision: price tier 3 flat at nine dollars a month for predictable billing.",
    });
    sqlite.seed({
      id: "b-3", createdAt: NOW, tags: ["work", "codex-response"],
      content: "Decision: move tier 3 to usage-based billing; flat pricing left money on the table.",
    });
    sqlite.db.prepare(
      `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
       VALUES ('cand-3', 'a-3', 'b-3', 0.87, ?, 7, 'vector', 'pending', ?)`,
    ).bind(120 * DAY, NOW).run();

    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, AI: tieredAI, OAUTH_KV: makeMemoryKV(),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runWeeklyInsights(env, ctx);

    const insightLogs = logSpy.mock.calls.filter(c => String(c[0]).includes("insight"));
    expect(insightLogs).toHaveLength(1);
    const [, payload] = insightLogs[0];
    expect(payload).toMatchObject({
      candidatesReasoned: 3,
      declinedByModel: 1,
      restatementsSuppressed: 1,
      written: 1,
    });
    logSpy.mockRestore();
  });

  /**
   * Task 18. The workspace comparison used to sit BELOW `reasonOverPair`: the
   * pair went into one prompt first, and `inputWorkspaces` then decided only
   * where to file the sentence that came back. So two members' private memories
   * could be synthesised into a single sentence — and the insight's vocabulary
   * floor requires that sentence to name something particular to each side, so
   * the text carries specifics from both. It was then written to "", which
   * `readableWorkspaces` grants to admins, and printed on /patterns.
   *
   * Accrual refuses cross-workspace pairs in both of its paths, so the reachable
   * shape is a candidate row accrued before tenancy — exactly what a v2 brain
   * carries into an upgrade, which is what these cases seed.
   */
  describe("workspaces are compared before the pair is reasoned over", () => {
    const A_TEXT = "Decision: price the Meridian tier flat at nine dollars a month.";
    const B_TEXT = "Decision: move the Meridian tier to usage-based billing instead.";

    // No `updated_at`: that column arrives by runtime ALTER inside
    // initializeDatabase, which runWeeklyInsights has not called yet when these
    // rows are seeded. Every other column is in db/schema.sql.
    function seedInWorkspace(id: string, workspaceId: string, content: string, createdAt: number) {
      sqlite.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
         VALUES (?, ?, '["pricing"]', 'api', ?, '[]', ?, '')`,
      ).bind(id, content, createdAt, workspaceId).run();
    }

    function seedPair(aWorkspace: string, bWorkspace: string) {
      seedInWorkspace("a-x", aWorkspace, A_TEXT, NOW - 120 * DAY);
      seedInWorkspace("b-x", bWorkspace, B_TEXT, NOW);
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES ('cand-x', 'a-x', 'b-x', 0.87, ?, 9, 'vector', 'pending', ?)`,
      ).bind(120 * DAY, NOW).run();
    }

    /** Records every prompt so the model's INPUT can be asserted on. */
    function recordingAI(prompts: string[]): Ai {
      const sse = (text: string) => new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return {
        run: vi.fn().mockImplementation(async (model: string, opts: any) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          const prompt = String(opts?.messages?.[0]?.content ?? "");
          prompts.push(prompt);
          return sse(prompt.includes("Memory A:") ? GOOD : "3");
        }),
      } as unknown as Ai;
    }

    const insightRows = async () =>
      ((await sqlite.db.prepare(
        `SELECT id, content, workspace_id FROM entries WHERE tags LIKE '%"auto-insight"%'`,
      ).all()).results) as { id: string; content: string; workspace_id: string }[];

    it("never puts two workspaces' memories into one prompt", async () => {
      seedPair("ws-alice", "ws-bob");
      const prompts: string[] = [];
      const env = makeTestEnv(undefined, {
        DB: sqlite.db as any, AI: recordingAI(prompts), OAUTH_KV: makeMemoryKV(),
      });

      await runWeeklyInsights(env, ctx);

      // Asserted on what the model was GIVEN, not on how often it was called: a
      // sentence synthesised from both sides is the leak, whatever it then says.
      expect(prompts.join("\n")).not.toContain(A_TEXT);
      expect(prompts.join("\n")).not.toContain(B_TEXT);
      expect(prompts.filter(p => p.includes("Memory A:"))).toEqual([]);
    });

    it("writes no insight to the legacy/system workspace from such a pair", async () => {
      seedPair("ws-alice", "ws-bob");
      const env = makeTestEnv(undefined, {
        DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
      });

      await runWeeklyInsights(env, ctx);

      // "" is the space readableWorkspaces hands to admins, so an insight filed
      // there is one an admin reads on /patterns.
      expect(await insightRows()).toEqual([]);
      // Settled rather than left pending, so the pass does not re-draw and
      // re-skip the same disqualified row every week.
      expect(await statusOf(sqlite, "cand-x")).toBe("used");
      expect(await drawnFrom(sqlite)).toEqual([]);
    });

    it("still reasons over — and files — a pair that shares a workspace", async () => {
      // The narrowing must not stop weekly insights working. Both sides in one
      // team workspace: reasoned, written, and filed to that workspace.
      seedPair("ws-alice", "ws-alice");
      const prompts: string[] = [];
      const env = makeTestEnv(undefined, {
        DB: sqlite.db as any, AI: recordingAI(prompts), OAUTH_KV: makeMemoryKV(),
      });

      await runWeeklyInsights(env, ctx);

      expect(prompts.filter(p => p.includes("Memory A:"))).toHaveLength(1);
      const rows = await insightRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].workspace_id).toBe("ws-alice");
      expect(rows[0].content).toContain(GOOD_TEXT);
      expect(await statusOf(sqlite, "cand-x")).toBe("used");
    });

    it("is unchanged on a solo brain, where every candidate is one workspace", async () => {
      // A pre-tenancy brain has "" on both sides. The comparison is size-1 there,
      // so the pass reasons and files exactly as it did.
      seedPair("", "");
      const prompts: string[] = [];
      const env = makeTestEnv(undefined, {
        DB: sqlite.db as any, AI: recordingAI(prompts), OAUTH_KV: makeMemoryKV(),
      });

      await runWeeklyInsights(env, ctx);

      expect(prompts.filter(p => p.includes("Memory A:"))).toHaveLength(1);
      const rows = await insightRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].workspace_id).toBe("");
      expect(rows[0].content).toContain(GOOD_TEXT);
      expect(await drawnFrom(sqlite)).toEqual([
        { source_id: rows[0].id, target_id: "a-x", provenance: "system" },
        { source_id: rows[0].id, target_id: "b-x", provenance: "system" },
      ]);
    });

    it("does not count a skipped cross-workspace pair as reasoned over", async () => {
      // candidatesReasoned is the D2 instrumentation the spec reads to decide
      // whether the corpus is running dry. A pair that never reached the model
      // must not inflate it, the same rule the D1 pair-rule rejection follows.
      seedPair("ws-alice", "ws-bob");
      const env = makeTestEnv(undefined, {
        DB: sqlite.db as any, AI: makeAI(GOOD), OAUTH_KV: makeMemoryKV(),
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await runWeeklyInsights(env, ctx);

      const [, payload] = logSpy.mock.calls.filter(c => String(c[0]).includes("insight"))[0];
      expect(payload).toMatchObject({ candidatesDrawn: 1, candidatesReasoned: 0, written: 0 });
      logSpy.mockRestore();
    });
  });

  it("does not throw when the pass fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as any;
    await expect(
      runWeeklyInsights(makeTestEnv(undefined, { DB: broken, OAUTH_KV: makeMemoryKV() }), ctx),
    ).resolves.toBeUndefined();
  });
});
