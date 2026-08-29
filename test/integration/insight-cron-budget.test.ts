import { describe, it, expect, vi, beforeEach } from "vitest";
import { runInsightAccrual, ACCRUAL_SEED_LIMIT } from "../../src/insight/candidates";
import { runWeeklyInsights, WEEKLY_CANDIDATE_LIMIT, MAX_INSIGHTS_PER_RUN } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeInsightFixture, FIXTURE_NOW } from "../helpers/insight-fixture";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { handleAdminRoutes } from "../../src/routes/admin";
import { req } from "../helpers/make-request";

/**
 * A Worker invocation gets 50 D1 subrequests on the free plan, and every
 * binding call counts against it — D1, Vectorize, Workers AI and KV alike.
 * `sqlite.issued` records one entry per D1 call, including one per batch;
 * the other three are counted directly off each mock's own call log below.
 */
const SUBREQUEST_BUDGET = 50;

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const DAY = 86400000;

const drawnFrom = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT source_id, target_id, provenance FROM edges WHERE type = 'drawn_from'`,
  ).all()).results) as { source_id: string; target_id: string; provenance: string }[];

/**
 * A reasoning call that always accepts. The default AI mock (makeAIMock in
 * test/helpers/make-env.ts) returns the literal text "3" for every non-embedding
 * call, which parseInsightResponse (src/insight/reason.ts) can never parse as
 * JSON — so with the default mock reasonOverPair returns null for every
 * candidate and captureEntry is never reached at all. That measures the cheap
 * branch of the weekly pass (rejections only), not the expensive one: up to
 * MAX_INSIGHTS_PER_RUN real captures, each paying duplicate detection,
 * embedding and storage. This mock (same shape as test/unit/insight-weekly.
 * test.ts's makeAI) answers the reasoning prompt — identified by "Memory A:",
 * the one string only that prompt contains — with a well-formed insight, so
 * the pass actually exercises captureEntry the number of times production
 * would on a night where every candidate is a real one.
 */
function makeReasoningAI() {
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
      // Keyed off the candidate's own tier number so every accepted insight's
      // text — and therefore captureEntry's stored content — is distinct per
      // candidate, not a repeat of the same string three times over. Distinct
      // means genuinely different wording, not a shared template with the
      // tier digit swapped in: distinctiveTokens (reason.ts) drops a bare
      // digit entirely, and even where it didn't, one differing word among
      // nine tokens is still ~89% overlap — restatesRecent (wired into
      // weekly.ts by the same task this fixture had to be corrected for)
      // would treat that as the same conclusion restated and this run would
      // stop writing after the first candidate instead of three. Only tiers
      // 0-2 need to clear both the vocabulary floor (against their own
      // entries) and mutual novelty (against each other), since only the top
      // three by score are ever reasoned over.
      const tier = prompt.match(/tier (\d+)/)?.[1] ?? "0";
      const perTier: Record<string, string> = {
        "0": "You priced this tier at nine dollars flat, then moved it entirely to usage-based billing.",
        "1": "This tier's predictable monthly amount got swapped for pricing tied to actual usage instead.",
        "2": "That flat monthly price got left behind once usage-based charges took over instead.",
      };
      const insight = `{"insight": true, "shape": "contradiction", "text": "${perTier[tier] ?? perTier["0"]}"}`;
      return sse(prompt.includes("Memory A:") ? insight : "3");
    }),
  } as unknown as Ai;
}

describe("insight crons stay inside one invocation's budget", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    // initializeDatabase memoizes its promise at module scope (src/db/init.ts).
    // Every test here builds a brand-new in-memory database, so without this
    // reset the second test to reach a runtime-ALTER column (captureEntry's
    // INSERT below writes updated_at, which lives only in the ALTER, not in
    // db/schema.sql) inherits an "already migrated" memo for a database that
    // was never altered, and the insert fails against real SQLite.
    resetDatabaseInit();
  });

  it("accrual stays under budget at a full seed batch", async () => {
    // The fixture holds a handful of entries; a real night can present
    // ACCRUAL_SEED_LIMIT of them, so pad it to the worst case.
    //
    // Padding with a vector id the fixture's VECTORIZE mock has never heard of
    // (e.g. `vec-pad-${i}`) makes getByIds silently drop it — the mock's
    // getByIds filters to ids it recognises — so the padded seed never reaches
    // a query() call at all, and the measured run is dominated by the handful
    // of real fixture entries rather than a full 25-seed batch. Pointing each
    // pad entry's vector id at one of the fixture's own (real, registered)
    // vectors keeps every padded seed resolvable, so this actually drives
    // ACCRUAL_SEED_LIMIT worth of VECTORIZE.query calls — the cost line item
    // that dominates the budget (see src/insight/candidates.ts's own comment:
    // "25 queries" of the ~34 total) — rather than measuring a run that quietly
    // does almost nothing.
    const fx = makeInsightFixture();
    for (let i = 0; i < ACCRUAL_SEED_LIMIT; i++) {
      fx.sqlite.seed({
        id: `pad-${i}`, createdAt: FIXTURE_NOW - i * DAY, tags: ["pricing"],
        content: `A padding decision about the pricing model number ${i}, long enough to be eligible.`,
        vectorIds: [`vec-${fx.all[i % fx.all.length].id}`],
      });
    }
    // The fixture's KV (test/helpers/make-env.ts's makeMemoryKV) is a plain
    // object, not a vi.fn(), so its calls have to be spied on explicitly —
    // runInsightAccrual reads and writes the accrual cursor through it, and
    // that read/write is as real a subrequest as a D1 or Vectorize call.
    const kvGet = vi.spyOn(fx.env.OAUTH_KV, "get");
    const kvPut = vi.spyOn(fx.env.OAUTH_KV, "put");

    await runInsightAccrual(fx.env, ctx);

    const bindingCalls =
      (fx.env.VECTORIZE.query as any).mock.calls.length +
      (fx.env.VECTORIZE.getByIds as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    expect(fx.sqlite.issued.length + bindingCalls).toBeLessThan(SUBREQUEST_BUDGET);
    fx.sqlite.close();
  });

  it("the weekly pass stays under budget at a full candidate slate", async () => {
    // Every candidate content string is parameterised by `i` so that, once
    // reasoning starts accepting (below), the entries captureEntry writes are
    // not identical to one another — an identical-content run would let
    // duplicate detection block the second and third capture, which would
    // measure that path's cost instead of three genuinely separate writes.
    const sqlite: SqliteD1 = makeSqliteD1();
    for (let i = 0; i < WEEKLY_CANDIDATE_LIMIT; i++) {
      sqlite.seed({
        id: `a-${i}`, createdAt: FIXTURE_NOW - 120 * DAY, tags: ["pricing"],
        content: `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`,
      });
      sqlite.seed({
        id: `b-${i}`, createdAt: FIXTURE_NOW, tags: ["pricing"],
        content: `Decision: move tier ${i} to usage-based billing instead of flat pricing.`,
      });
      sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`c-${i}`, `a-${i}`, `b-${i}`, 120 * DAY, 10 - i, FIXTURE_NOW).run();
    }
    const before = sqlite.issued.length;   // seeding is not the pass

    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeReasoningAI(),
    });
    // Same reasoning as the accrual test: KV is a plain object, not a vi.fn(),
    // so it needs an explicit spy. runWeeklyInsights itself reads it once
    // (config, via resolveConfig) — but each successful captureEntry call
    // fires its own KV read too, for the tag-vocabulary cache (rememberTags,
    // src/tags/vocabulary.ts), via a fire-and-forget ctx.waitUntil() call
    // whose body still runs (and still spends the read) synchronously up to
    // its first await regardless of whether anything ever awaits the result.
    // Measured: 1 config read + 3 vocabulary reads (one per capture) = 4.
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    await runWeeklyInsights(env, ctx);

    // Confirms this actually measured the expensive branch (real captures)
    // rather than the cheap one (every candidate declined) — otherwise the
    // budget assertion below would hold trivially, the way it did against
    // the default AI mock.
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls =
      (env.AI.run as any).mock.calls.length +
      (env.VECTORIZE.query as any).mock.calls.length +
      // captureEntry's storage path calls VECTORIZE.upsert, not .insert
      // (src/capture/store.ts) — counting only .insert left the actual
      // vector write completely untracked. Both are counted, rather than
      // one replacing the other, so this stays correct if that ever changes.
      (env.VECTORIZE.insert as any).mock.calls.length +
      (env.VECTORIZE.upsert as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    const measured = (sqlite.issued.length - before) + bindingCalls;
    expect(measured).toBeLessThan(SUBREQUEST_BUDGET);
    // The <SUBREQUEST_BUDGET check above has 12 requests of slack at this
    // candidate slate (measured 38 of 50) — comfortably wide enough that
    // spending six more unbatched subrequests here (two drawn_from edges per
    // insight via createEdge, rather than joining the batch below) would
    // still read as "under budget" and this test would not catch the
    // regression edgeInsertStatement exists to prevent. Pinned to the
    // measured value so that regression fails loudly instead of quietly
    // eating slack.
    expect(measured).toBe(38);

    // Verified after the budget assertion, not before: this SELECT is a test
    // check, not something runWeeklyInsights() itself issues, and including
    // it above would charge the measurement for a subrequest production
    // never spends. Two drawn_from edges per stored insight — the whole
    // reason edgeInsertStatement exists is so these join the batch above
    // rather than costing MAX_INSIGHTS_PER_RUN * 2 extra subrequests via
    // createEdge.
    expect(await drawnFrom(sqlite)).toHaveLength(MAX_INSIGHTS_PER_RUN * 2);
    sqlite.close();
  });

  it("the sliced team pass stays under budget at a full candidate slate", async () => {
    // The team pass is its own invocation and therefore its own 50, and this
    // is the measurement the fifth cron trigger is justified by: if the two
    // passes shared one invocation the total would be the sum of this number
    // and the one above, which is well past the ceiling and would leave the
    // second pass dead half-written.
    //
    // A FULL slate inside the slice, plus personal candidates outscoring every
    // one of them — the worst case, and the shape a real team brain has. The
    // personal rows are what make the measurement honest: a slice that cost
    // less only because it drew fewer candidates would prove nothing.
    const sqlite: SqliteD1 = makeSqliteD1();
    const seedIn = (id: string, workspaceId: string, content: string, createdAt: number) => {
      sqlite.seed({ id, content, createdAt, tags: ["pricing"] });
      return sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
    };
    for (let i = 0; i < WEEKLY_CANDIDATE_LIMIT; i++) {
      await seedIn(`co-a-${i}`, "ws-co",
        `Decision: price tier ${i} flat at nine dollars a month for predictable billing.`, FIXTURE_NOW - 120 * DAY);
      await seedIn(`co-b-${i}`, "ws-co",
        `Decision: move tier ${i} to usage-based billing instead of flat pricing.`, FIXTURE_NOW);
      await sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`co-c-${i}`, `co-a-${i}`, `co-b-${i}`, 120 * DAY, 10 - i, FIXTURE_NOW).run();
      // A higher-scoring personal pair per company pair, which the slice must
      // remove in the query rather than after drawing it.
      await seedIn(`p-a-${i}`, "ws-alice",
        `Decision: price plan ${i} flat at nine dollars a month for predictable billing.`, FIXTURE_NOW - 120 * DAY);
      await seedIn(`p-b-${i}`, "ws-alice",
        `Decision: move plan ${i} to usage-based billing instead of flat pricing.`, FIXTURE_NOW);
      await sqlite.db.prepare(
        `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
      ).bind(`p-c-${i}`, `p-a-${i}`, `p-b-${i}`, 120 * DAY, 100 - i, FIXTURE_NOW).run();
    }
    const before = sqlite.issued.length;   // seeding is not the pass

    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as any, OAUTH_KV: kv, VECTORIZE: makeVectorizeMock(),
      AI: makeReasoningAI(),
    });
    const kvGet = vi.spyOn(kv, "get");
    const kvPut = vi.spyOn(kv, "put");

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: ["ws-co"] });

    // The expensive branch: three real captures, all of them in the slice.
    const written = (await sqlite.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%' AND workspace_id = 'ws-co'`,
    ).first()) as { n: number };
    expect(written.n).toBe(MAX_INSIGHTS_PER_RUN);

    const bindingCalls =
      (env.AI.run as any).mock.calls.length +
      (env.VECTORIZE.query as any).mock.calls.length +
      (env.VECTORIZE.insert as any).mock.calls.length +
      (env.VECTORIZE.upsert as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    const measured = (sqlite.issued.length - before) + bindingCalls;
    expect(measured).toBeLessThan(SUBREQUEST_BUDGET);
    // Pinned, like the unsliced case above: the slice is a WHERE predicate on
    // a query that already ran, so it costs the same 38 the personal pass
    // costs. A future change that made the team pass more expensive than the
    // personal one is exactly what this number is here to surface.
    expect(measured).toBe(38);

    // What the scheduled() branch spends AROUND the pass, so the pinned number
    // above is not mistaken for the whole invocation: one KV read for the
    // config flag and one D1 read for companyWorkspaceIds. The team
    // invocation's real total is therefore 40 of 50.
    expect(measured + 2).toBeLessThan(SUBREQUEST_BUDGET);

    expect(await drawnFrom(sqlite)).toHaveLength(MAX_INSIGHTS_PER_RUN * 2);
    sqlite.close();
  });
});

describe("POST /insights/accrue stays inside one invocation's budget", () => {
  // The on-demand endpoint (src/routes/admin.ts) runs the exact same
  // runInsightAccrual pass the nightly cron does, plus two cheap COUNT(*)
  // queries against insight_candidates (before/after) to report what
  // changed. It has to fit the same 50-subrequest ceiling — the platform
  // does not grant fetch handlers a bigger budget than scheduled ones — so
  // this measures the endpoint's total cost, not just the accrual pass
  // underneath it.
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    resetDatabaseInit();
  });

  it("stays under budget at a full seed batch", async () => {
    // Same worst-case padding as "accrual stays under budget at a full seed
    // batch" above — see that test's comment for why each pad seed points at
    // a real, registered fixture vector rather than an unresolvable one.
    const fx = makeInsightFixture();
    for (let i = 0; i < ACCRUAL_SEED_LIMIT; i++) {
      fx.sqlite.seed({
        id: `pad-${i}`, createdAt: FIXTURE_NOW - i * DAY, tags: ["pricing"],
        content: `A padding decision about the pricing model number ${i}, long enough to be eligible.`,
        vectorIds: [`vec-${fx.all[i % fx.all.length].id}`],
      });
    }
    const kvGet = vi.spyOn(fx.env.OAUTH_KV, "get");
    const kvPut = vi.spyOn(fx.env.OAUTH_KV, "put");

    const res = await handleAdminRoutes(
      req("POST", "/insights/accrue"),
      new URL("http://localhost/insights/accrue"),
      fx.env,
      ctx,
    );
    expect(res?.status).toBe(200);

    const bindingCalls =
      (fx.env.VECTORIZE.query as any).mock.calls.length +
      (fx.env.VECTORIZE.getByIds as any).mock.calls.length +
      kvGet.mock.calls.length +
      kvPut.mock.calls.length;
    // Measured: 37 (runInsightAccrual's own ~34-37 plus the endpoint's two
    // COUNT(*) queries) — comfortably inside the 50-subrequest ceiling.
    expect(fx.sqlite.issued.length + bindingCalls).toBeLessThan(SUBREQUEST_BUDGET);
    fx.sqlite.close();
  });
});
