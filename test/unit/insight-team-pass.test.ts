/**
 * The company-scoped weekly pass (spec 4.5).
 *
 * ONE implementation, two invocations. `runWeeklyInsights` gains an optional
 * workspace slice and nothing else: the eligibility gate, the same-workspace
 * gate, the novelty floor, the three-per-run cap and the drawn_from edges are
 * behaviour both invocations need and neither may drift on, so these cases
 * drive the SAME function twice and compare the two runs rather than
 * describing a second code path.
 *
 * Real SQLite, not the SQL-matching mock: the whole subject is a WHERE
 * predicate over `workspace_id`, and a mock that recognises statements by
 * substring cannot tell a correct predicate from a broken one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWeeklyInsights, companyWorkspaceIds, MAX_INSIGHTS_PER_RUN, MAX_SLICE_STATEMENTS, RECENT_INSIGHT_WINDOW } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
import type { Env } from "../../src/env";

const DAY = 86400000;
const NOW = 400 * DAY;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const WS_ALICE = "ws-alice";
const WS_BOB = "ws-bob";
const WS_CO = "ws-co";
const WS_CO2 = "ws-co2";

/**
 * One accepted insight per candidate tier, each genuinely differently worded.
 *
 * Not a shared template with the digit swapped in: `distinctiveTokens`
 * (src/insight/reason.ts) drops a bare digit entirely, so a template would
 * make every proposal a ~100% restatement of the previous one and the run
 * would stop after the first write instead of exercising the cap. Each text
 * also has to clear the asymmetric vocabulary floor against its own pair, so
 * every one of them names something from A alone ("nine"/"dollars"/
 * "predictable") and something from B alone ("usage-based"/"pricing").
 */
const PER_TIER: Record<string, string> = {
  "0": "You priced this tier at nine dollars flat, then moved it entirely to usage-based billing.",
  "1": "This tier's predictable monthly amount got swapped for pricing tied to actual usage instead.",
  "2": "That flat monthly price got left behind once usage-based charges took over instead.",
  "3": "The predictable dollars per seat gave way to usage-based pricing on the shared plan.",
  // Tiers 4 and 5 reason to the SAME sentence on purpose, so a run can hold two
  // candidates in two different companies whose answers collide. Nothing else
  // in this file seeds them together with tiers 0-3.
  "4": "Nine dollars a month was predictable, then you chose to move it to usage-based charging instead.",
  "5": "Nine dollars a month was predictable, then you chose to move it to usage-based charging instead.",
};

function makeAI() {
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
      const tier = prompt.match(/tier (\d+)/)?.[1] ?? "0";
      const payload = `{"insight": true, "shape": "contradiction", "text": "${PER_TIER[tier] ?? PER_TIER["0"]}"}`;
      // "Memory A:" is the one string only the reasoning prompt contains; the
      // classifier inside captureEntry gets the plain importance digit.
      return sse(prompt.includes("Memory A:") ? payload : "3");
    }),
  } as unknown as Ai;
}

/** sqlite-d1's seed() does not take a workspace, and the workspace is the subject. */
function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string, createdAt: number) {
  sqlite.seed({ id, content, createdAt, tags: ["pricing"] });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

/** A pending candidate whose two entries live in the named workspaces. */
function seedPair(sqlite: SqliteD1, tier: number, wsA: string, wsB: string, score: number) {
  seedIn(sqlite, `a-${tier}`, wsA,
    `Decision: price tier ${tier} flat at nine dollars a month for predictable billing.`, NOW - 120 * DAY);
  seedIn(sqlite, `b-${tier}`, wsB,
    `Decision: move tier ${tier} to usage-based billing instead of flat pricing.`, NOW);
  sqlite.db.prepare(
    `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
     VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
  ).bind(`cand-${tier}`, `a-${tier}`, `b-${tier}`, 120 * DAY, score, NOW).run();
}

/**
 * Three personal pairs outscoring one company pair — the ordering a real team
 * brain has, and the reason 4.5 exists: the shared layer competes for the same
 * ten-candidate slice and the same MAX_INSIGHTS_PER_RUN write slots as every
 * personal pair, so it is the layer least likely to produce anything.
 */
function seedTeamBrain(sqlite: SqliteD1) {
  seedPair(sqlite, 0, WS_ALICE, WS_ALICE, 10);
  seedPair(sqlite, 1, WS_ALICE, WS_ALICE, 9);
  seedPair(sqlite, 2, WS_BOB, WS_BOB, 8);
  seedPair(sqlite, 3, WS_CO, WS_CO, 7);
}

/**
 * A D1 facade that enforces the ONE limit real D1 enforces and this file's
 * subject can break: at most D1_MAX_BOUND_PARAMS bound parameters per
 * statement. `node:sqlite` accepts far more (its own ceiling is in the
 * thousands), so a test driven against the bare facade passes while the
 * deployed Worker's statement is rejected outright — and the rejection is
 * swallowed by runWeeklyInsights's own try/catch, so the only symptom in
 * production is a pass that silently stops producing anything.
 *
 * Records every statement's parameter count so a test can assert the ceiling
 * was respected rather than merely not tripped.
 */
function withBoundParamLimit(inner: SqliteD1["db"], executed: { sql: string; params: number }[]) {
  const check = (sql: string, params: unknown[]) => {
    executed.push({ sql, params: params.length });
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
  };
  const wrap = (sql: string, stmt: any, params: unknown[]): any => ({
    bind: (...args: unknown[]) => wrap(sql, stmt.bind(...args), args),
    all: async () => { check(sql, params); return stmt.all(); },
    first: async () => { check(sql, params); return stmt.first(); },
    run: async () => { check(sql, params); return stmt.run(); },
  });
  return {
    prepare: (sql: string) => wrap(sql, inner.prepare(sql), []),
    exec: (sql: string) => inner.exec(sql),
    batch: (statements: any[]) => inner.batch(statements),
  } as unknown as SqliteD1["db"];
}

const envOf = (sqlite: SqliteD1): Env => makeTestEnv(undefined, {
  DB: sqlite.db as any, AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
}) as Env;

const insights = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT id, workspace_id, actor_id, content FROM entries
     WHERE tags LIKE '%"auto-insight"%' ORDER BY id`,
  ).all()).results) as { id: string; workspace_id: string; actor_id: string; content: string }[];

const statusOf = async (sqlite: SqliteD1, id: string) =>
  ((await sqlite.db.prepare(
    `SELECT status FROM insight_candidates WHERE id = ?`,
  ).bind(id).first()) as { status: string }).status;

const drawnFromCount = async (sqlite: SqliteD1) =>
  ((await sqlite.db.prepare(
    `SELECT COUNT(*) AS n FROM edges WHERE type = 'drawn_from'`,
  ).first()) as { n: number }).n;

describe("runWeeklyInsights — the workspace slice", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // initializeDatabase memoises its promise at module scope, and each test
    // here gets a brand-new :memory: database.
    resetDatabaseInit();
    sqlite = makeSqliteD1();
  });

  afterEach(() => sqlite.close());

  // ── Content ────────────────────────────────────────────────────────────────

  it("without a slice, spends every write slot on the higher-scoring personal pairs", async () => {
    // Today's behaviour, asserted first so the regression case exists: the
    // company pair is last by score and there is no slot left for it.
    seedTeamBrain(sqlite);

    await runWeeklyInsights(envOf(sqlite), ctx);

    const written = await insights(sqlite);
    expect(written).toHaveLength(MAX_INSIGHTS_PER_RUN);
    expect(written.map(r => r.workspace_id).sort()).toEqual([WS_ALICE, WS_ALICE, WS_BOB]);
    expect(written.some(r => r.workspace_id === WS_CO)).toBe(false);
  });

  it("with a company slice, writes the company pair and none of the personal ones", async () => {
    seedTeamBrain(sqlite);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    const written = await insights(sqlite);
    expect(written).toHaveLength(1);
    expect(written[0].workspace_id).toBe(WS_CO);
    // System-authored regardless of whose workspace it inherits.
    expect(written[0].actor_id).toBe("");
    // And the personal candidates were never drawn, so they are still waiting
    // for the unsliced pass rather than settled by this one.
    expect(await statusOf(sqlite, "cand-0")).toBe("pending");
    expect(await statusOf(sqlite, "cand-1")).toBe("pending");
    expect(await statusOf(sqlite, "cand-2")).toBe("pending");
    expect(await statusOf(sqlite, "cand-3")).toBe("used");
  });

  it("still records the drawn_from provenance the unsliced pass records", async () => {
    // The edges are behaviour both invocations need; a slice that dropped them
    // would leave a company insight with no sources on /patterns.
    seedTeamBrain(sqlite);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    expect(await drawnFromCount(sqlite)).toBe(2);
  });

  // ── Non-interference ───────────────────────────────────────────────────────

  it("an empty slice list is not a slice — it reasons over the whole corpus", async () => {
    // `[]` is what a solo brain's companyWorkspaceIds() returns; it must mean
    // "no restriction was asked for", not "restrict to nothing".
    seedTeamBrain(sqlite);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [] });

    const written = await insights(sqlite);
    expect(written).toHaveLength(MAX_INSIGHTS_PER_RUN);
    expect(written.map(r => r.workspace_id).sort()).toEqual([WS_ALICE, WS_ALICE, WS_BOB]);
  });

  it("a slice naming a workspace with no candidates writes nothing and settles nothing", async () => {
    seedTeamBrain(sqlite);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: ["ws-nope"] });

    expect(await insights(sqlite)).toHaveLength(0);
    for (const id of ["cand-0", "cand-1", "cand-2", "cand-3"]) {
      expect(await statusOf(sqlite, id)).toBe("pending");
    }
  });

  // ── Gating: the Phase 1 same-workspace gate, re-asserted ────────────────────

  it("skips and settles a cross-workspace pair inside the slice, exactly as the unsliced pass does", async () => {
    // The `inputWorkspaces.size !== 1` gate is what stops a pre-tenancy pair
    // reaching the model, and it is correct on BOTH invocations. Two company
    // workspaces is how it can still fire under a slice: both sides pass the
    // new IN predicate and the gate is the only thing left between the pair
    // and reasonOverPair. Re-asserted here because this task edits the query
    // directly above it.
    seedPair(sqlite, 0, WS_CO, WS_CO2, 10);
    const env = envOf(sqlite);

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: [WS_CO, WS_CO2] });

    expect(await insights(sqlite)).toHaveLength(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
    // Never reasoned over: the gate sits before the model call, so the pair's
    // two contents were never put in one prompt.
    const prompts = (env.AI.run as any).mock.calls.map((c: any[]) => String(c[1]?.messages?.[0]?.content ?? ""));
    expect(prompts.some((p: string) => p.includes("Memory A:"))).toBe(false);
  });

  it("leaves a pair straddling the slice boundary for the unsliced pass rather than settling it", async () => {
    // Distinct from the case above, and worth stating: when only ONE side is
    // in the slice the query removes the pair before the gate ever sees it, so
    // it stays `pending`. The team pass must not settle candidates that are
    // not its business.
    seedPair(sqlite, 0, WS_CO, WS_ALICE, 10);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    expect(await insights(sqlite)).toHaveLength(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("pending");
  });

  // ── The novelty floor ──────────────────────────────────────────────────────

  /**
   * An already-written insight, in the shape the pass stores one.
   *
   * `createdAt` is explicit because the floor's window is ordered by it: a
   * case about WHICH ten of a workspace's insights the floor reads cannot be
   * written against a helper that stamps them all with one timestamp.
   */
  const seedWrittenInsight = (
    id: string, workspaceId: string, text: string, createdAt = NOW - DAY,
  ) => {
    sqlite.seed({
      id, createdAt, tags: ["auto-insight"],
      content: `${text}\n\n[Insight: contradiction — drawn from 2 memories]`,
    });
    sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
  };

  /**
   * Prior insights about a subject nothing else in this file mentions, so they
   * fill the window without restating anything a candidate reasons to.
   */
  const seedFiller = (workspaceId: string, n: number, at: (i: number) => number) => {
    for (let i = 0; i < n; i++) {
      seedWrittenInsight(
        `filler-${workspaceId}-${String(i).padStart(2, "0")}`, workspaceId,
        "The weekend support rota stopped relying on volunteers and became a paid on-call roster.",
        at(i),
      );
    }
  };

  it("does not let a member's personal insight suppress a company one", async () => {
    // The floor asks "has this reader already seen this?", and under a slice
    // the reader is the company workspace — everyone in it. An insight one
    // member happened to receive privately is not something the team has seen,
    // and suppressing on it does not merely skip the pair: it settles the
    // candidate `used`, so the company insight is lost permanently rather than
    // deferred. One layer's state must not decide another layer's output.
    seedWrittenInsight("prior", WS_ALICE, PER_TIER["0"]);
    seedPair(sqlite, 0, WS_CO, WS_CO, 10);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    const written = await insights(sqlite);
    expect(written.filter(r => r.workspace_id === WS_CO)).toHaveLength(1);
  });

  it("still lets an earlier company insight suppress a restatement of itself", async () => {
    // The other half, and the reason this is a SLICE and not a deletion: the
    // floor has to keep firing on what the team pass itself wrote last week.
    seedWrittenInsight("prior", WS_CO, PER_TIER["0"]);
    seedPair(sqlite, 0, WS_CO, WS_CO, 10);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    expect((await insights(sqlite)).filter(r => r.id !== "prior")).toHaveLength(0);
    // Settled `used`, not `rejected`: the pair reasoned fine, it just landed
    // where the reader has already been.
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("does not let one company's insight suppress another company's candidate", async () => {
    // THE FLOOR IS PER-COMPANY, NOT PER-SLICE. companyWorkspaceIds() returns
    // every company on the deployment and src/index.ts hands the whole list to
    // ONE runWeeklyInsights call, so "the reader" under a slice is not a
    // company — it is all of them at once. Company A's written insights then
    // sit in company B's novelty floor, and suppression here does not defer a
    // candidate, it settles it `used`: B's insight is destroyed by content B's
    // members have never been able to read, and cannot come back next week.
    //
    // This is NOT the write-slot competition documented and deferred at
    // src/index.ts — losing a write slot leaves a candidate `pending`.
    seedWrittenInsight("prior", WS_CO, PER_TIER["0"]);
    seedPair(sqlite, 0, WS_CO2, WS_CO2, 10);
    // A second candidate keeps company A in the drawn slate, so the floor read
    // really does return A's rows and the per-candidate keying is what has to
    // keep them away from B. Without it the floor would be narrow only because
    // the query happened not to ask about A.
    seedPair(sqlite, 1, WS_CO, WS_CO, 9);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO, WS_CO2] });

    const written = (await insights(sqlite)).filter(r => r.id !== "prior");
    expect(written.map(r => r.workspace_id).sort()).toEqual([WS_CO, WS_CO2]);
  });

  it("does not let an insight this run writes for one company suppress another's", async () => {
    // The within-run half of the same rule. Two companies, two candidates, one
    // sentence: whichever is reasoned first must not take the other's slot,
    // because an insight written into company A this minute is no more visible
    // to company B than one written last week.
    seedPair(sqlite, 4, WS_CO, WS_CO, 10);
    seedPair(sqlite, 5, WS_CO2, WS_CO2, 9);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO, WS_CO2] });

    const written = await insights(sqlite);
    expect(written.map(r => r.workspace_id).sort()).toEqual([WS_CO, WS_CO2]);
    // Both settled, neither destroyed.
    expect(await statusOf(sqlite, "cand-4")).toBe("used");
    expect(await statusOf(sqlite, "cand-5")).toBe("used");
  });

  it("still suppresses a within-run collision inside ONE company", async () => {
    // And the guard is not switched off by the keying: two candidates in the
    // SAME workspace reasoning to the same sentence is what the within-run half
    // was written for, and the second is still settled `used` rather than
    // written a second time.
    seedPair(sqlite, 4, WS_CO, WS_CO, 10);
    seedPair(sqlite, 5, WS_CO, WS_CO, 9);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    expect(await insights(sqlite)).toHaveLength(1);
    expect(await statusOf(sqlite, "cand-5")).toBe("used");
  });

  it("gives the same answer whether or not the other company exists at all", async () => {
    // The two runs differ in exactly one thing — whether company A is on the
    // deployment — and company B's data is identical in both. A floor that
    // reads across companies makes those two runs disagree, which is the
    // property that makes this a tenancy defect rather than a tuning choice.
    const runB = async (withOtherCompany: boolean) => {
      resetDatabaseInit();
      const db = makeSqliteD1();
      const seedWritten = (id: string, ws: string, text: string) => {
        db.seed({
          id, createdAt: NOW - DAY, tags: ["auto-insight"],
          content: `${text}\n\n[Insight: contradiction — drawn from 2 memories]`,
        });
        db.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(ws, id).run();
      };
      if (withOtherCompany) seedWritten("prior", WS_CO, PER_TIER["0"]);
      seedPair(db, 0, WS_CO2, WS_CO2, 10);
      const slice = withOtherCompany ? [WS_CO, WS_CO2] : [WS_CO2];
      await runWeeklyInsights(envOf(db), ctx, { onlyWorkspaceIds: slice });
      const out = {
        written: ((await db.db.prepare(
          `SELECT COUNT(*) AS n FROM entries WHERE tags LIKE '%"auto-insight"%' AND workspace_id = ?`,
        ).bind(WS_CO2).first()) as { n: number }).n,
        status: ((await db.db.prepare(
          `SELECT status FROM insight_candidates WHERE id = 'cand-0'`,
        ).first()) as { status: string }).status,
      };
      db.close();
      return out;
    };

    expect(await runB(true)).toEqual(await runB(false));
  });

  it("still lets a company's OWN earlier insight suppress it under a multi-company slice", async () => {
    // The other half. Narrowing the floor to the candidate's own workspace must
    // not switch it off: an insight the same company received last week is
    // exactly what the floor exists to catch, slice width notwithstanding.
    seedWrittenInsight("prior", WS_CO2, PER_TIER["0"]);
    seedPair(sqlite, 0, WS_CO2, WS_CO2, 10);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO, WS_CO2] });

    expect((await insights(sqlite)).filter(r => r.id !== "prior")).toHaveLength(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("holds EVERY drawn workspace's floor, not one workspace's on behalf of all", async () => {
    // WHY ROW_NUMBER AND NOT A BARE LIMIT, asserted as an outcome instead of
    // as a string in the SQL. Two companies, each with its own prior insight
    // restating its own candidate: both candidates must be suppressed, which
    // requires the floor read to return a row for BOTH workspaces.
    //
    // A single shared window — an outer `LIMIT 1` on this statement, or the
    // `ORDER BY created_at DESC LIMIT ?` this replaced — can only carry one of
    // the two, so exactly one candidate would survive its own company's floor
    // and be written. The assertion is deliberately blind to WHICH one: it
    // fails whichever row the shared window happens to keep, so it cannot pass
    // by accident of the seed order.
    seedWrittenInsight("prior-co", WS_CO, PER_TIER["0"]);
    seedWrittenInsight("prior-co2", WS_CO2, PER_TIER["1"]);
    seedPair(sqlite, 0, WS_CO, WS_CO, 10);
    seedPair(sqlite, 1, WS_CO2, WS_CO2, 9);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO, WS_CO2] });

    expect((await insights(sqlite)).filter(r => !r.id.startsWith("prior"))).toHaveLength(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
    expect(await statusOf(sqlite, "cand-1")).toBe("used");
  });

  it("reads a workspace's NEWEST insights into the floor, not its oldest", async () => {
    // The other half of what the window function buys, also as an outcome
    // rather than as a spelling. RECENT_INSIGHT_WINDOW is a RECENCY window:
    // the floor asks "is this a restatement of something this reader was given
    // LATELY", and a candidate that restates last week's insight has to be
    // caught even in a workspace with a long history behind it.
    //
    // One workspace holding exactly RECENT_INSIGHT_WINDOW older insights about
    // an unrelated subject, plus a newer one the candidate restates. Ordered
    // newest-first the restatement is in the window and the candidate is
    // suppressed; ordered oldest-first the window is spent entirely on the
    // filler and the restatement is written. No other case in this file seeds
    // more than one insight into a workspace, so nothing else can tell those
    // two orderings apart.
    seedFiller(WS_CO, RECENT_INSIGHT_WINDOW, (i) => NOW - 30 * DAY + i);
    seedWrittenInsight("prior", WS_CO, PER_TIER["0"], NOW - DAY);
    seedPair(sqlite, 0, WS_CO, WS_CO, 10);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    expect((await insights(sqlite)).filter(r => r.id === "cand-0" || !/^(prior|filler)/.test(r.id)))
      .toHaveLength(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  it("settles a tie in the floor window by id, so the same data suppresses the same way", async () => {
    // TIES ARE PRODUCED HERE, not imagined: a run writes up to
    // MAX_INSIGHTS_PER_RUN insights in one batch off one Date.now(), and the
    // pass is a cron that has run every week since the brain was made. With
    // `ORDER BY created_at DESC` alone, which of a tie group falls inside
    // `rn <= RECENT_INSIGHT_WINDOW` is whatever order the engine happened to
    // emit — and unlike the activity feed's boundary, where the cost of an
    // arbitrary order is a row shown on two pages, this boundary decides
    // whether a candidate is DESTROYED: a suppressed pair is settled `used`
    // and never comes back.
    //
    // `id DESC` is the same disposal /team/activity took with `event_id DESC`:
    // a per-row primary key, unique in the table, making the sort a total
    // order — arbitrary within a tie, but the SAME arbitrary order for every
    // run over the same data, which is the whole requirement.
    //
    // The window here is exactly full of filler and the restatement is the
    // ELEVENTH row of the tie group, so the tiebreaker is what decides the
    // case: `zz-prior` sorts first under `id DESC` and is read into the floor;
    // with no tiebreaker at all the engine emits it last, it falls outside the
    // window, and the candidate is written instead of suppressed.
    const TIED = NOW - DAY;
    seedFiller(WS_CO, RECENT_INSIGHT_WINDOW, () => TIED);
    seedWrittenInsight("zz-prior", WS_CO, PER_TIER["0"], TIED);
    seedPair(sqlite, 0, WS_CO, WS_CO, 10);

    await runWeeklyInsights(envOf(sqlite), ctx, { onlyWorkspaceIds: [WS_CO] });

    expect((await insights(sqlite)).filter(r => !/^(zz-prior|filler)/.test(r.id))).toHaveLength(0);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
  });

  // ── The bound-parameter ceiling ────────────────────────────────────────────

  const CANDIDATE_SELECT = /FROM insight_candidates c/;
  const FLOOR_SELECT = /ROW_NUMBER\(\) OVER \(PARTITION BY workspace_id/;

  it("draws a slice too large for one statement to bind, including its last workspace", async () => {
    // Every slice id is bound TWICE — once for `a.workspace_id`, once for
    // `b.workspace_id` — plus the LIMIT, so N company workspaces cost 2N + 1
    // bound parameters against a hard platform ceiling of 100
    // (D1_MAX_BOUND_PARAMS). At 50 workspaces that is 101: D1 rejects the
    // statement, runWeeklyInsights's outer catch swallows the rejection, and
    // the team pass silently stops producing anything, forever, with no
    // user-visible signal. 60 workspaces is past that line on purpose.
    //
    // The only candidate lives in the LAST workspace of the slice, so a fix
    // that merely truncated the list to what one statement can bind would
    // leave this red rather than pass for the wrong reason.
    const slice = Array.from({ length: 60 }, (_, i) => `ws-co-${i}`);
    seedPair(sqlite, 0, slice[59], slice[59], 10);
    const executed: { sql: string; params: number }[] = [];
    const env = makeTestEnv(undefined, {
      DB: withBoundParamLimit(sqlite.db, executed) as any,
      AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    }) as Env;

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: slice });

    const written = await insights(sqlite);
    expect(written).toHaveLength(1);
    expect(written[0].workspace_id).toBe(slice[59]);
    expect(await statusOf(sqlite, "cand-0")).toBe("used");
    expect(Math.max(...executed.map(e => e.params))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });

  it("spends one statement per chunk of the slice and no more", async () => {
    // The chunk size is the cost line: each chunk is a subrequest against the
    // same 50-subrequest invocation the pass's model calls come out of, so
    // "chunk smaller to be safe" is not free. 49 ids (2 x 49 + 1 = 99
    // parameters) must still be ONE statement; 50 is where a second is owed.
    const draws = async (n: number) => {
      const executed: { sql: string; params: number }[] = [];
      const env = makeTestEnv(undefined, {
        DB: withBoundParamLimit(sqlite.db, executed) as any,
        AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
      }) as Env;
      await runWeeklyInsights(env, ctx, {
        onlyWorkspaceIds: Array.from({ length: n }, (_, i) => `ws-co-${i}`),
      });
      return executed.filter(e => CANDIDATE_SELECT.test(e.sql)).length;
    };

    expect(await draws(49)).toBe(1);
    expect(await draws(50)).toBe(2);
    // 98 is the whole capacity (MAX_SLICE_STATEMENTS chunks); past it the
    // slice is truncated rather than given a third statement — see the case
    // below.
    expect(await draws(98)).toBe(MAX_SLICE_STATEMENTS);
  });

  it("reads the novelty floor for the drawn candidates' workspaces, not the slice's", async () => {
    // ONE statement for the floor however wide the slice is, and its
    // parameters are the workspaces the drawn candidates can actually land in
    // — at most WEEKLY_CANDIDATE_LIMIT of them — plus the window. Keyed on the
    // slice instead, a 98-workspace deployment would bind 99 here, which fits
    // today only because MAX_SLICE_STATEMENTS is 2; raising it puts the floor
    // over the ceiling with no other change, and D1's rejection is swallowed
    // by this pass's own catch.
    const slice = Array.from({ length: 60 }, (_, i) => `ws-co-${i}`);
    seedPair(sqlite, 0, slice[0], slice[0], 10);
    const executed: { sql: string; params: number }[] = [];
    const env = makeTestEnv(undefined, {
      DB: withBoundParamLimit(sqlite.db, executed) as any,
      AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    }) as Env;

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: slice });

    const floor = executed.filter(e => FLOOR_SELECT.test(e.sql));
    expect(floor).toHaveLength(1);
    // One workspace drawn, so one workspace bound, plus RECENT_INSIGHT_WINDOW.
    expect(floor[0].params).toBe(2);
  });

  it("issues no floor statement at all when nothing was drawn", async () => {
    // Nothing to compare against nothing. The subrequest is not spent, which
    // is the same reasoning lookupAuditNames applies to an empty id list.
    const executed: { sql: string; params: number }[] = [];
    const env = makeTestEnv(undefined, {
      DB: withBoundParamLimit(sqlite.db, executed) as any,
      AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    }) as Env;

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: ["ws-nope"] });

    expect(executed.filter(e => FLOOR_SELECT.test(e.sql))).toHaveLength(0);
  });

  it("spends its write slots by score ACROSS chunks, not chunk by chunk", async () => {
    // Each chunk's statement carries its own ORDER BY … LIMIT, so the ordering
    // the three write slots are spent by only exists once the chunks are
    // merged. Drawn chunk-first, the two lowest-scoring pairs in the first
    // chunk would take two of the three slots and the second-highest pair in
    // the last chunk would get none.
    const slice = Array.from({ length: 60 }, (_, i) => `ws-co-${i}`);
    seedPair(sqlite, 0, slice[0], slice[0], 1);
    seedPair(sqlite, 1, slice[1], slice[1], 2);
    seedPair(sqlite, 2, slice[50], slice[50], 10);
    seedPair(sqlite, 3, slice[51], slice[51], 9);
    const executed: { sql: string; params: number }[] = [];
    const env = makeTestEnv(undefined, {
      DB: withBoundParamLimit(sqlite.db, executed) as any,
      AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    }) as Env;

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: slice });

    expect(await insights(sqlite)).toHaveLength(MAX_INSIGHTS_PER_RUN);
    // The three highest scores (10, 9, 2) were spent; the lowest is untouched
    // and still available to a later run.
    expect(await statusOf(sqlite, "cand-2")).toBe("used");
    expect(await statusOf(sqlite, "cand-3")).toBe("used");
    expect(await statusOf(sqlite, "cand-1")).toBe("used");
    expect(await statusOf(sqlite, "cand-0")).toBe("pending");
  });

  it("stops adding statements before the slice can spend the whole invocation, and says so", async () => {
    // Chunking trades a bound-parameter ceiling for a subrequest one: each
    // extra statement is one more of the 50 this invocation gets, and the team
    // invocation already measures 47 of 50 at its worst slate
    // (test/integration/insight-cron-budget.test.ts). Left unbounded, a brain
    // with enough company workspaces would overflow the budget mid-loop —
    // which loses the whole run, batch included, and is swallowed by the same
    // catch. Truncating is a real loss, so it is reported rather than assumed
    // to be noticed.
    const slice = Array.from({ length: 200 }, (_, i) => `ws-co-${i}`);
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
    const executed: { sql: string; params: number }[] = [];
    const env = makeTestEnv(undefined, {
      DB: withBoundParamLimit(sqlite.db, executed) as any,
      AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    }) as Env;

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: slice });

    spy.mockRestore();
    expect(executed.filter(e => CANDIDATE_SELECT.test(e.sql))).toHaveLength(MAX_SLICE_STATEMENTS);
    expect(JSON.stringify(errors)).toContain('"dropped":102');
  });

  it("names the slice in the log when the pass fails, so a silent death is legible", async () => {
    // The catch below this pass is the reason the double-bind above could have
    // run for a whole release without anyone noticing: it swallows everything.
    // It must at least say WHICH invocation died — the personal pass and the
    // team pass share one implementation and one log line, and "weekly insight
    // pass failed" alone does not distinguish them.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
    const env = makeTestEnv(undefined, {
      DB: { prepare: () => { throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR"); },
            exec: async () => {}, batch: async () => [] } as any,
      AI: makeAI(), OAUTH_KV: makeMemoryKV(), VECTORIZE: makeVectorizeMock(),
    }) as Env;

    await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: [WS_CO, WS_CO2] });

    spy.mockRestore();
    expect(JSON.stringify(errors)).toContain('"sliceWorkspaces":2');
  });
});

describe("companyWorkspaceIds()", () => {
  let sqlite: SqliteD1;

  beforeEach(() => { resetDatabaseInit(); sqlite = makeSqliteD1(); });
  afterEach(() => sqlite.close());

  const seedWorkspace = (id: string, kind: string) =>
    sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, ?, ?, 0)`)
      .bind(id, kind, id).run();

  it("returns only the company-kind rows", async () => {
    seedWorkspace(WS_ALICE, "personal");
    seedWorkspace(WS_CO, "company");
    seedWorkspace(WS_BOB, "personal");
    seedWorkspace(WS_CO2, "company");

    const ids = await companyWorkspaceIds(makeTestEnv(undefined, { DB: sqlite.db as any }) as Env);

    expect([...ids].sort()).toEqual([WS_CO, WS_CO2]);
  });

  it("returns an empty list on a brain with no company workspace", async () => {
    seedWorkspace(WS_ALICE, "personal");

    const ids = await companyWorkspaceIds(makeTestEnv(undefined, { DB: sqlite.db as any }) as Env);

    expect(ids).toEqual([]);
  });
});
