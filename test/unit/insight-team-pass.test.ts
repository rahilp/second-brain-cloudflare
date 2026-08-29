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
import { runWeeklyInsights, companyWorkspaceIds, MAX_INSIGHTS_PER_RUN } from "../../src/insight/weekly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
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
