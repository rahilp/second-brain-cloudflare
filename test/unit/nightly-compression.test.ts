/**
 * The nightly jobs all run inside one scheduled() invocation and share its budget, so
 * how much work compression takes per run is a correctness property, not a tuning knob.
 *
 * Before this bound existed, every tag with more than ten eligible entries was compressed
 * on every run — so both the D1 subrequest count and the CPU time grew with how many
 * distinct tags a user had, and a heavily-tagged brain blew the free-plan ceilings. The
 * tests that matter here are the two that bounding could plausibly get wrong: that it
 * defers rather than drops, and that the rotation actually reaches every tag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runNightlyCompression, COMPRESSION_MAX_TAGS_PER_RUN } from "../../src/compression/nightly";
import { resetDatabaseInit } from "../../src/db/init";
import { makeTestDb, makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import type { Env } from "../../src/env";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function makeDigestAI() {
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream) return makeSseStream("A digest of the tagged memories.");
      return { response: "3" };
    }),
  } as unknown as Ai;
}

function seedTags(db: D1Mock, tagCount: number, perTag = 15) {
  const old = Date.now() - 200 * 24 * 3600 * 1000;
  let i = 0;
  for (let t = 0; t < tagCount; t++) {
    for (let k = 0; k < perTag; k++, i++) {
      db.entries.push({
        id: `e-${i}`, content: `Memory ${i} about topic ${t}`, tags: JSON.stringify([`tag-${t}`]),
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
  }
}

/** Which tags have had a digest built for them so far. */
function digestedTags(db: D1Mock): Set<string> {
  const out = new Set<string>();
  for (const e of db.entries) {
    const tags: string[] = JSON.parse(e.tags ?? "[]");
    if (!tags.includes("synthesized")) continue;
    for (const t of tags) if (t.startsWith("tag-")) out.add(t);
  }
  return out;
}

async function runCron(env: Env) {
  const pending: Promise<any>[] = [];
  const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext;
  await runNightlyCompression(env, ctx);
  await Promise.allSettled(pending);
}

describe("runNightlyCompression() tag bound", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    resetDatabaseInit();
    db = makeTestDb();
    env = makeTestEnv(db, { AI: makeDigestAI(), OAUTH_KV: makeMemoryKV() });
  });

  it(`compresses at most ${COMPRESSION_MAX_TAGS_PER_RUN} tags in one run`, async () => {
    seedTags(db, 20);

    await runCron(env);

    expect(digestedTags(db).size).toBe(COMPRESSION_MAX_TAGS_PER_RUN);
  });

  it("resumes after the last tag it processed rather than repeating the head", async () => {
    seedTags(db, 20);

    await runCron(env);
    const first = digestedTags(db);
    await runCron(env);
    const afterSecond = digestedTags(db);

    // The second run must have done new work, not re-done the first run's.
    expect(afterSecond.size).toBeGreaterThan(first.size);
    for (const t of first) expect(afterSecond.has(t)).toBe(true);
  });

  it("reaches every tag across enough runs — bounding defers, it never drops", async () => {
    const TAGS = 20;
    seedTags(db, TAGS);

    // Ceil(20/4) runs would suffice if nothing repeated; allow slack and assert coverage.
    for (let i = 0; i < 10; i++) await runCron(env);

    expect(digestedTags(db).size).toBe(TAGS);
  });

  it("takes every tag in one run when there are fewer than the bound", async () => {
    const under = COMPRESSION_MAX_TAGS_PER_RUN - 1;
    seedTags(db, under);
    const put = vi.spyOn(env.OAUTH_KV, "put");

    await runCron(env);

    expect(digestedTags(db).size).toBe(under);
    // No rotation is needed, so no cursor is written — there is nothing to resume from.
    expect(put).not.toHaveBeenCalled();
  });

  /**
   * The staleness pass writes volatility: and stale:as-of across up to 25 entries a night,
   * so those tags carry a higher entry count than most real topics. They are not topics and
   * never produce a digest — but the candidate list is ordered by count and only the first
   * COMPRESSION_MAX_TAGS_PER_RUN are taken, so if they appear at all they take slots from
   * the tags that would have produced one. The user-visible symptom is compression quietly
   * doing half as much, with nothing logged.
   *
   * Scope: this covers the PREDICATE, not the query. The D1 mock's digest-candidate branch
   * calls isTopicTag(), so a WHERE clause that drifted from it would leave this test green
   * — verified by mutation. test/integration/digest-candidates.test.ts runs the clause
   * itself against real SQLite and is what actually covers the SQL.
   */
  it("does not let system tags take digest slots from real topics", async () => {
    seedTags(db, 5, 15);
    // Mark entries the way the staleness pass does: on top of their existing topic tags.
    for (const e of db.entries.slice(0, 25)) {
      e.tags = JSON.stringify([...JSON.parse(e.tags), "volatility:state", "stale:as-of"]);
    }

    await runCron(env);

    expect(digestedTags(db).size).toBe(COMPRESSION_MAX_TAGS_PER_RUN);
    const synthesized = db.entries.filter(e => JSON.parse(e.tags ?? "[]").includes("synthesized"));
    for (const e of synthesized) {
      const tags: string[] = JSON.parse(e.tags);
      expect(tags.some(t => t.startsWith("volatility:") || t === "stale:as-of")).toBe(false);
    }
  });

  /**
   * The damage, not the predicate.
   *
   * A reserved tag admitted in mixed case does not merely waste a digest slot. compressTag
   * selects the entries it rolls up with `tags LIKE '%"<tag>"%'`, and LIKE ignores ASCII
   * case, so the candidate `Kind:Semantic` selects every entry tagged `kind:semantic` —
   * classified entries, which is most of them. Those entries get `rolled-up` and a
   * `[Digest: …]` suffix appended to their content permanently, drop out of staleness and
   * future compression, and lose recall weight. Here `holiday-plans` has only nine entries,
   * far under the ten a digest needs, so nothing about it is a legitimate candidate — and
   * yet it was the collateral when this regressed.
   *
   * The mirror path (src/integrations/mirror.ts) inserts tags without lowercasing, which is
   * how a mixed-case system tag gets into the table in the first place.
   */
  it("does not roll up unrelated entries when a system tag arrives in mixed case", async () => {
    const old = Date.now() - 200 * 24 * 3600 * 1000;
    for (let i = 0; i < 11; i++) {
      db.entries.push({
        id: `mirror-${i}`, content: `Mirrored note ${i}`, tags: JSON.stringify(["Kind:Semantic"]),
        source: "notion", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }
    for (let i = 0; i < 9; i++) {
      db.entries.push({
        id: `holiday-${i}`, content: `Holiday idea ${i}`, tags: JSON.stringify(["holiday-plans", "kind:semantic"]),
        source: "api", created_at: old + i, updated_at: old + i, vector_ids: "[]",
        recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
      });
    }

    await runCron(env);

    for (let i = 0; i < 9; i++) {
      const row = db.entries.find(e => e.id === `holiday-${i}`)!;
      expect(JSON.parse(row.tags)).not.toContain("rolled-up");
      expect(row.content).toBe(`Holiday idea ${i}`); // content never appended to
    }
    expect(db.entries.filter(e => JSON.parse(e.tags).includes("synthesized"))).toHaveLength(0);
  });

  it("starts from the top when the cursor cannot be read", async () => {
    seedTags(db, 20);
    const failingKV = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(), list: vi.fn(),
    } as unknown as KVNamespace;
    env = makeTestEnv(db, { AI: makeDigestAI(), OAUTH_KV: failingKV });

    await runCron(env);

    expect(digestedTags(db).size).toBe(COMPRESSION_MAX_TAGS_PER_RUN);
  });
});
