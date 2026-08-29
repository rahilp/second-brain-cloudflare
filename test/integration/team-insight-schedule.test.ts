/**
 * The team insight trigger, end to end through `scheduled()`.
 *
 * Three separable facts live here and none of them is provable from the pass
 * itself: that the flag is read on the SCHEDULE rather than inside the pass
 * (so an opted-out brain pays one KV read and stops), that the new cron runs
 * the team job and ONLY the team job (a missing `return` falls through to
 * maintenance, which is the exact failure the existing insight branches'
 * comment warns about), and that what the pass writes into a company
 * workspace is reviewable by an ordinary member.
 *
 * Real SQLite through `worker.scheduled` and `worker.fetch`, because both the
 * slice and the readable set are WHERE clauses the string-matching D1 mock
 * cannot evaluate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import { INSIGHT_TEAM_WEEKLY_CRON, INSIGHT_WEEKLY_CRON } from "../../src/insight/schedule";
import { STALENESS_AGE_MS } from "../../src/staleness/pass";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const DAY = 86400000;

let sqlite: SqliteD1;
let env: Env;
let kv: KVNamespace;
/** Every statement the Worker prepared, so "did this job run at all" is answerable. */
let prepared: string[];
let companyWorkspaceId = "";
let aliceToken = "";
let aliceWorkspaceId = "";

/** The reasoning AI: one accepted insight, worded to clear the vocabulary floor. */
function makeAI() {
  const sse = (text: string) => new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(text)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  const texts: Record<string, string> = {
    co: "You priced this tier at nine dollars flat, then moved it entirely to usage-based billing.",
    mine: "That predictable monthly amount got swapped for pricing tied to actual usage instead.",
  };
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      const prompt = String(opts?.messages?.[0]?.content ?? "");
      const key = prompt.includes("tier co") ? "co" : "mine";
      const payload = `{"insight": true, "shape": "contradiction", "text": "${texts[key]}"}`;
      return sse(prompt.includes("Memory A:") ? payload : "3");
    }),
  } as unknown as Ai;
}

async function seedIn(id: string, workspaceId: string, content: string, createdAt: number, tags = ["pricing"]) {
  sqlite.seed({ id, content, createdAt, tags });
  await sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

/** A pending candidate whose two entries share `workspaceId`. `label` keys the AI mock. */
async function seedCandidate(label: string, workspaceId: string, score: number) {
  const now = Date.now();
  await seedIn(`a-${label}`, workspaceId,
    `Decision: price tier ${label} flat at nine dollars a month for predictable billing.`, now - 120 * DAY);
  await seedIn(`b-${label}`, workspaceId,
    `Decision: move tier ${label} to usage-based billing instead of flat pricing.`, now);
  await sqlite.db.prepare(
    `INSERT INTO insight_candidates (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
     VALUES (?, ?, ?, 0.87, ?, ?, 'vector', 'pending', ?)`,
  ).bind(`cand-${label}`, `a-${label}`, `b-${label}`, 120 * DAY, score, now).run();
}

/**
 * An entry old enough for the staleness pass to flag, in a shape its heuristic
 * recognises. Whether it comes back carrying `stale:as-of` is how a
 * fallthrough to maintenance is detected — the same detector
 * test/unit/cron-subrequest-budget.test.ts uses for the other two triggers.
 *
 * In the COMPANY workspace deliberately. Maintenance processes one workspace
 * per night behind a rotation cursor (src/runtime/rotation.ts), so a bait in a
 * workspace the ring did not land on that night would read as "maintenance did
 * not run" whether it ran or not. Every fixture here that uses the bait seeds
 * the company workspace too, so the ring has one place to land.
 */
async function seedMaintenanceBait() {
  const old = Date.now() - STALENESS_AGE_MS - DAY;
  await seedIn("bait", companyWorkspaceId, "Bob works at Example Inc", old, []);
  await sqlite.db.prepare(`UPDATE entries SET updated_at = ? WHERE id = 'bait'`).bind(old).run();
}

const tagsOf = async (id: string) =>
  JSON.parse(((await sqlite.db.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first()) as { tags: string }).tags) as string[];

const cursorAdvancedAt = async () =>
  (((await sqlite.db.prepare(`SELECT advanced_at FROM maintenance_cursor WHERE id = 1`).first()) as { advanced_at: number } | null)?.advanced_at ?? 0);

const insights = async () =>
  ((await sqlite.db.prepare(
    `SELECT id, workspace_id, actor_id, content FROM entries WHERE tags LIKE '%"auto-insight"%'`,
  ).all()).results) as { id: string; workspace_id: string; actor_id: string; content: string }[];

const statusOf = async (id: string) =>
  ((await sqlite.db.prepare(`SELECT status FROM insight_candidates WHERE id = ?`).bind(id).first()) as { status: string }).status;

async function runCron(cron: string) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
  prepared.length = 0;
  await (worker as any).scheduled({ cron } as any, env, ctx);
  await Promise.allSettled(pending);
}

const call = (path: string, init: RequestInit = {}) => worker.fetch(
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "application/json" },
  }),
  env,
  { waitUntil: () => {} } as unknown as ExecutionContext,
);

const setConfig = (overrides: Record<string, unknown>) => kv.put(CONFIG_KEY, JSON.stringify(overrides));

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  prepared = [];
  const DB = {
    prepare(sql: string) {
      prepared.push(sql.replace(/\s+/g, " ").trim());
      return sqlite.db.prepare(sql);
    },
    exec: (sql: string) => sqlite.db.exec(sql),
    batch: (sts: any[]) => sqlite.db.batch(sts),
  } as unknown as Env["DB"];
  kv = makeMemoryKV();
  env = makeTestEnv(undefined, {
    DB, OAUTH_KV: kv, AI: makeAI(), VECTORIZE: makeVectorizeMock(),
  }) as Env;
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  companyWorkspaceId = roots.companyWorkspaceId;
  const alice = await createMember(env, { name: "Alice" });
  aliceToken = alice.token;
  aliceWorkspaceId = alice.member.personalWorkspaceId;
  setDbReady(true);
});

afterEach(() => { sqlite?.close(); setDbReady(false); });

describe("the team insight trigger — gating", () => {
  it("issues no D1 statement at all when TEAM_INSIGHTS is unset", async () => {
    // The default-off guarantee, and the reason the flag is read on the
    // schedule rather than inside the pass: an opted-out brain pays one KV
    // read a week and stops, before initializeDatabase and before any query.
    await seedCandidate("co", companyWorkspaceId, 10);

    await runCron(INSIGHT_TEAM_WEEKLY_CRON);

    expect(prepared).toEqual([]);
    expect(await insights()).toHaveLength(0);
    expect(await statusOf("cand-co")).toBe("pending");
  });

  it("issues no D1 statement when TEAM_INSIGHTS is explicitly off", async () => {
    await setConfig({ TEAM_INSIGHTS: "off" });
    await seedCandidate("co", companyWorkspaceId, 10);

    await runCron(INSIGHT_TEAM_WEEKLY_CRON);

    expect(prepared).toEqual([]);
  });

  it("runs the pass over the company workspace when TEAM_INSIGHTS is on", async () => {
    await setConfig({ TEAM_INSIGHTS: "on" });
    // The personal pair outscores the company one, exactly as on a real team
    // brain — the sliced pass must ignore it anyway.
    await seedCandidate("mine", aliceWorkspaceId, 20);
    await seedCandidate("co", companyWorkspaceId, 10);

    await runCron(INSIGHT_TEAM_WEEKLY_CRON);

    const written = await insights();
    expect(written).toHaveLength(1);
    expect(written[0].workspace_id).toBe(companyWorkspaceId);
    expect(written[0].actor_id).toBe("");
    expect(await statusOf("cand-co")).toBe("used");
    // The personal candidate was never drawn, so the unsliced pass still has it.
    expect(await statusOf("cand-mine")).toBe("pending");
  });

  it("stops before the pass when TEAM_INSIGHTS is on but no company workspace exists", async () => {
    // A solo brain that set the flag: companyWorkspaceIds() returns [] and the
    // job returns rather than handing the pass an empty slice, which would mean
    // "no restriction" and reason over the whole corpus.
    await setConfig({ TEAM_INSIGHTS: "on" });
    await sqlite.db.prepare(`DELETE FROM workspaces WHERE kind = 'company'`).run();
    await seedCandidate("mine", aliceWorkspaceId, 20);

    await runCron(INSIGHT_TEAM_WEEKLY_CRON);

    expect(prepared.some(s => s.includes("FROM workspaces"))).toBe(true);
    expect(prepared.some(s => s.includes("FROM insight_candidates"))).toBe(false);
    expect(await insights()).toHaveLength(0);
  });
});

describe("the team insight trigger — routing", () => {
  it("runs the team job and nothing else", async () => {
    // Without the `return` this invocation also runs nightly compression, the
    // graph pass and the staleness pass — on top of the team pass's own
    // budget, which is the multiplier the split exists to avoid.
    await setConfig({ TEAM_INSIGHTS: "on" });
    await seedCandidate("co", companyWorkspaceId, 10);
    await seedMaintenanceBait();

    await runCron(INSIGHT_TEAM_WEEKLY_CRON);

    // The team job itself ran.
    expect((await insights()).map(r => r.workspace_id)).toEqual([companyWorkspaceId]);
    // And maintenance did not: the staleness pass would have tagged the bait,
    // and all three maintenance passes share one rotation cursor, which only
    // the maintenance branch advances.
    expect(await tagsOf("bait")).not.toContain("stale:as-of");
    expect(await cursorAdvancedAt()).toBe(0);
  });

  it("the same fixture DOES get maintained on an unrouted schedule — the detector works", async () => {
    // Without this control the case above would pass just as well on a broken
    // fixture the staleness pass could never have flagged anyway.
    await setConfig({ TEAM_INSIGHTS: "on" });
    await seedCandidate("co", companyWorkspaceId, 10);
    await seedMaintenanceBait();

    await runCron("*/7 * * * *");

    expect(await tagsOf("bait")).toContain("stale:as-of");
    expect(await cursorAdvancedAt()).toBeGreaterThan(0);
  });

  it("leaves the personal weekly schedule unsliced and still routed away from maintenance", async () => {
    // Non-interference: the pass on INSIGHT_WEEKLY_CRON is byte-identical to
    // today's, whatever TEAM_INSIGHTS says.
    await setConfig({ TEAM_INSIGHTS: "on" });
    await seedCandidate("mine", aliceWorkspaceId, 20);
    await seedCandidate("co", companyWorkspaceId, 10);
    await seedMaintenanceBait();

    await runCron(INSIGHT_WEEKLY_CRON);

    // Unsliced means unsliced: this invocation draws from both layers, in
    // score order, exactly as it does today. TEAM_INSIGHTS is on and changes
    // nothing about it.
    const written = await insights();
    expect(written.map(r => r.workspace_id).sort()).toEqual([aliceWorkspaceId, companyWorkspaceId].sort());
    expect(await tagsOf("bait")).not.toContain("stale:as-of");
    expect(await cursorAdvancedAt()).toBe(0);
  });
});

describe("a company-layer insight in a member's review queue", () => {
  // Characterisation, not a change: `GET /patterns` is scoped to the caller's
  // readable set, which includes their company workspaces, and
  // `POST /patterns/resolve` scopes without applying the author lock. So an
  // insight written into the company workspace was ALREADY reviewable by every
  // member — spec 4.5's "confirmed/dismissed like personal insights" is
  // satisfied by what exists. Asserted here so nobody reads it as new.
  it("a member can see it on /patterns and dismiss it", async () => {
    await setConfig({ TEAM_INSIGHTS: "on" });
    await seedCandidate("co", companyWorkspaceId, 10);

    await runCron(INSIGHT_TEAM_WEEKLY_CRON);
    const id = (await insights())[0].id;

    const queue = await (await call("/patterns")).json() as any;
    expect(queue.patterns.map((p: any) => p.id)).toContain(id);

    const res = await call("/patterns/resolve", {
      method: "POST",
      body: JSON.stringify({ id, action: "dismiss" }),
    });
    expect(res.status).toBe(200);

    const after = await (await call("/patterns")).json() as any;
    expect(after.patterns.map((p: any) => p.id)).not.toContain(id);
    expect(await tagsOf(id)).toContain("status:deprecated");
  });
});
