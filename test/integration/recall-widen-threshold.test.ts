/**
 * #245 — recall widening must be governed by its own threshold.
 *
 * Before this split both the write-path duplicate flag and the recall-path
 * widen check read DUPLICATE_FLAG_THRESHOLD. Exposing that single constant as
 * a "duplicate blocking" control would silently retune recall, so the two call
 * sites are separated here and pinned by the last test in this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";
import { CONFIG_KEY } from "../../src/config";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext };
}

function seed(db: D1Mock, id: string, content: string) {
  db.entries.push({
    id, content, tags: "[]", source: "api", created_at: 1000,
    vector_ids: "[]", recall_count: 0, importance_score: 0,
  });
}

/**
 * Narrow queries return only the weak match; the widened re-query (topK 50)
 * also returns `extra`. So `extra` appearing in the result IS the observable
 * evidence that widening happened — no assertions on mock call counts.
 */
function wideningEnv(db: D1Mock, overrides?: Record<string, unknown>) {
  const kv = makeMemoryKV();
  const env = makeTestEnv(db, {
    OAUTH_KV: kv,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockImplementation(async (_v: unknown, opts: { topK?: number } = {}) => {
        const weak = { id: "weak", score: 0.5, metadata: { parentId: "weak", isUpdate: false } };
        const extra = { id: "extra", score: 0.45, metadata: { parentId: "extra", isUpdate: false } };
        return { matches: opts.topK === 50 ? [weak, extra] : [weak] };
      }),
    }),
  });
  return { env, seedConfig: async () => overrides && kv.put(CONFIG_KEY, JSON.stringify(overrides)) };
}

describe("recall widening threshold (#245)", () => {
  let db: D1Mock;
  beforeEach(() => {
    db = makeTestDb();
    seed(db, "weak", "weak match");
    seed(db, "extra", "only found by the widened query");
  });

  it("widens when the best match falls below the default threshold", async () => {
    const { env, seedConfig } = wideningEnv(db);
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "anything", topK: 10 }, env, ctx);

    expect(res.matches.map(m => m.id)).toContain("extra");
  });

  it("does not widen once RECALL_WIDEN_THRESHOLD is lowered below the best score", async () => {
    const { env, seedConfig } = wideningEnv(db, { RECALL_WIDEN_THRESHOLD: 0.1 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "anything", topK: 10 }, env, ctx);

    expect(res.matches.map(m => m.id)).not.toContain("extra");
  });

  // The reason the split exists: retuning duplicate detection must not move
  // recall. If this fails, the two call sites have been recoupled.
  it("is unaffected by DUPLICATE_FLAG_THRESHOLD", async () => {
    const { env, seedConfig } = wideningEnv(db, { DUPLICATE_FLAG_THRESHOLD: 0.1 });
    await seedConfig();
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "anything", topK: 10 }, env, ctx);

    // Widening still governed by RECALL_WIDEN_THRESHOLD's default of 0.85.
    expect(res.matches.map(m => m.id)).toContain("extra");
  });
});
