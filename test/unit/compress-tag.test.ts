import { describe, it, expect, vi, beforeEach } from "vitest";
import { compressTag } from "../../src/compression/digest";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
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

function makeDigestAI(digestText = "Work on the API redesign is progressing well with REST chosen over GraphQL.") {
  return {
    run: vi.fn().mockImplementation(async (_model: string, opts: any) => {
      if (_model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream)
        return makeSseStream(digestText);
      return { response: "3" };
    }),
  } as unknown as Ai;
}

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function seedEntries(db: D1Mock, tag: string, count: number, overrides: Partial<any> = {}) {
  for (let i = 0; i < count; i++) {
    db.entries.push({
      id: `entry-${i}`,
      content: `Memory about ${tag} number ${i + 1}`,
      tags: JSON.stringify([tag]),
      source: "api",
      created_at: Date.now() - i * 1000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
      ...overrides,
    });
  }
}

describe("compressTag()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db, { AI: makeDigestAI() });
  });

  // ── Early-return guards ──────────────────────────────────────────────────────

  it("returns early when fewer than 10 compressible entries exist", async () => {
    seedEntries(db, "work", 9);
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(result.entriesUsed).toBe(0);
  });

  it("excludes rolled-up entries from the compressible count", async () => {
    seedEntries(db, "work", 9);
    db.entries.push({
      id: "rolled", content: "old memory", tags: JSON.stringify(["work", "rolled-up"]),
      source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    // 9 compressible + 1 rolled-up = still < 10 compressible → bail
    expect(result.synthesizedId).toBeNull();
  });

  it("excludes high-importance entries (score >= 4) from the compressible count", async () => {
    seedEntries(db, "work", 9);
    db.entries.push({
      id: "critical", content: "critical memory", tags: JSON.stringify(["work"]),
      source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 4,
    });
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    // 9 compressible + 1 high-importance (excluded) → bail
    expect(result.synthesizedId).toBeNull();
  });

  it("returns early when a synthesized entry for this tag exists within 24h", async () => {
    seedEntries(db, "work", 15);
    db.entries.push({
      id: "recent-synth",
      content: "[Synthesized from 15 entries tagged \"work\"]\n\nExisting digest.",
      tags: JSON.stringify(["synthesized", "work"]),
      source: "system",
      created_at: Date.now() - 3600000, // 1h ago
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("stores a digest entry with clean header (no source_ids)", async () => {
    seedEntries(db, "work", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    expect(result.synthesizedId).not.toBeNull();
    const digest = db.entries.find(e => e.id === result.synthesizedId);
    expect(digest).toBeDefined();
    expect(digest.content).toContain("[Synthesized from 12 entries tagged \"work\"]");
    expect(digest.content).not.toContain("source_ids");
  });

  it("digest entry is tagged synthesized and with the target tag", async () => {
    seedEntries(db, "work", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    const digest = db.entries.find(e => e.id === result.synthesizedId);
    const tags: string[] = JSON.parse(digest.tags);
    expect(tags).toContain("synthesized");
    expect(tags).toContain("work");
  });

  it("tags all source entries as rolled-up", async () => {
    seedEntries(db, "work", 12);
    const { ctx, drain } = makeCtx();
    await compressTag("work", env, ctx);
    await drain();
    const sources = db.entries.filter(e => !JSON.parse(e.tags).includes("synthesized"));
    expect(sources.length).toBe(12);
    sources.forEach(e => {
      expect(JSON.parse(e.tags)).toContain("rolled-up");
    });
  });

  it("appends [Digest: {id}] to each source entry's content", async () => {
    seedEntries(db, "work", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    const sources = db.entries.filter(e => !JSON.parse(e.tags).includes("synthesized"));
    sources.forEach(e => {
      expect(e.content).toContain(`[Digest: ${result.synthesizedId}]`);
    });
  });

  it("returns entriesUsed equal to the number of source entries", async () => {
    seedEntries(db, "work", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    expect(result.entriesUsed).toBe(12);
  });

  it("returns the synthesis text", async () => {
    seedEntries(db, "work", 12);
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    expect(result.text).toBe("Work on the API redesign is progressing well with REST chosen over GraphQL.");
  });

  it("does not roll up high-importance entries but still uses them in synthesis", async () => {
    seedEntries(db, "work", 10);
    db.entries.push({
      id: "critical", content: "critical strategy decision", tags: JSON.stringify(["work"]),
      source: "api", created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 5,
    });
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    // Digest succeeds on the 10 compressible entries
    expect(result.synthesizedId).not.toBeNull();
    // High-importance entry is NOT rolled-up
    const critical = db.entries.find(e => e.id === "critical");
    expect(JSON.parse(critical.tags)).not.toContain("rolled-up");
    expect(critical.content).not.toContain("[Digest:");
  });

  // ── Recall- and contradiction-aware protection ───────────────────────────────

  it("protects entries recalled >= 2 times from compression", async () => {
    seedEntries(db, "work", 12, { recall_count: 5 });
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    expect(result.synthesizedId).toBeNull();
  });

  it("treats never-recalled entries as eligible", async () => {
    seedEntries(db, "work", 12, { recall_count: 0 });
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    expect(result.synthesizedId).not.toBeNull();
    expect(result.entriesUsed).toBe(12);
  });

  it("treats recall_count=1 entries older than 60 days as eligible", async () => {
    seedEntries(db, "work", 12, { recall_count: 1, created_at: Date.now() - 61 * 86400000 });
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    expect(result.synthesizedId).not.toBeNull();
    expect(result.entriesUsed).toBe(12);
  });

  it("protects recall_count=1 entries newer than 60 days", async () => {
    seedEntries(db, "work", 12, { recall_count: 1, created_at: Date.now() - 5 * 86400000 });
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    expect(result.synthesizedId).toBeNull();
  });

  it("protects contradiction survivors (contradiction_wins > 0) from compression", async () => {
    seedEntries(db, "work", 12, { contradiction_wins: 1 });
    const { ctx } = makeCtx();
    const result = await compressTag("work", env, ctx);
    expect(result.synthesizedId).toBeNull();
  });

  it("only rolls up the eligible subset when a tag mixes protected and eligible entries", async () => {
    seedEntries(db, "work", 11, { recall_count: 0 }); // 11 eligible (ids entry-0..entry-10)
    for (let i = 0; i < 3; i++) {
      db.entries.push({
        id: `hot-${i}`, content: `hot ${i}`, tags: JSON.stringify(["work"]),
        source: "api", created_at: Date.now(), vector_ids: "[]",
        recall_count: 9, importance_score: 0, contradiction_wins: 0,
      });
    }
    const { ctx, drain } = makeCtx();
    const result = await compressTag("work", env, ctx);
    await drain();
    expect(result.entriesUsed).toBe(11);
    for (let i = 0; i < 3; i++) {
      const hot = db.entries.find(e => e.id === `hot-${i}`);
      expect(JSON.parse(hot.tags)).not.toContain("rolled-up");
    }
  });

  // ── Reserved namespace protection ────────────────────────────────────────────

  it("refuses to compress a kind:* namespaced tag", async () => {
    seedEntries(db, "kind:semantic", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("kind:semantic", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("refuses to compress a status:* namespaced tag", async () => {
    seedEntries(db, "status:canonical", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("status:canonical", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  // The candidate query excludes these, so reaching here means something else called
  // compressTag directly. It matters more than it looks: without the guard a digest gets
  // built for "everything the staleness pass touched", and markSourcesRolledUp then rolls
  // up every one of those sources — taking them out of the running for the real topics
  // they were also tagged with.
  it("refuses to compress a volatility:* namespaced tag", async () => {
    seedEntries(db, "volatility:state", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("volatility:state", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
    for (const e of db.entries) expect(JSON.parse(e.tags)).not.toContain("rolled-up");
  });

  it("refuses to compress the stale:as-of tag", async () => {
    seedEntries(db, "stale:as-of", 15, { recall_count: 0 });
    const { ctx } = makeCtx();
    const result = await compressTag("stale:as-of", env, ctx);
    expect(result.synthesizedId).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
    for (const e of db.entries) expect(JSON.parse(e.tags)).not.toContain("rolled-up");
  });

  // Mixed case is the dangerous form, not a curiosity. The source selector below this guard
  // is `tags LIKE '%"<tag>"%'`, and LIKE ignores ASCII case — so `Kind:Semantic` reaching
  // compressTag does not roll up the entries tagged `Kind:Semantic`, it rolls up every
  // entry tagged `kind:semantic`. The guard has to reject it before that query runs.
  it.each(["Kind:Semantic", "Status:Active", "Volatility:State", "Stale:As-Of", "STALE:AS-OF"])(
    "refuses to compress %s regardless of case",
    async (tag) => {
      seedEntries(db, tag.toLowerCase(), 15, { recall_count: 0 });
      const { ctx } = makeCtx();
      const result = await compressTag(tag, env, ctx);
      expect(result.synthesizedId).toBeNull();
      expect(result.entriesUsed).toBe(0);
      expect(env.AI.run).not.toHaveBeenCalled();
      for (const e of db.entries) expect(JSON.parse(e.tags)).not.toContain("rolled-up");
    },
  );

  // ── Marking sources rolled-up (#278) ─────────────────────────────────────────
  //
  // All four nightly jobs share one scheduled() invocation and therefore one
  // subrequest budget, and marking sources one statement at a time was ~88% of the
  // whole cron's D1 cost. These pin the batching, and the per-row fallback that
  // keeps a single bad row from rolling back a whole tag's worth of marks.

  /** Counts subrequests the way D1 bills them: a batch is one, whatever it carries. */
  function countingDb(db: D1Mock, failBatch = false, failRowIds: string[] = []) {
    const calls = { batches: 0, batchedStatements: 0, individualRuns: 0 };
    const wrap = (stmt: any, boundId?: string): any => ({
      bind: (...args: any[]) => wrap(stmt.bind(...args), args[args.length - 1]),
      run: async () => {
        calls.individualRuns++;
        if (boundId && failRowIds.includes(boundId)) throw new Error(`row ${boundId} rejected`);
        return stmt.run();
      },
      first: () => stmt.first(),
      all: () => stmt.all(),
      __inner: stmt,
    });
    const DB = {
      prepare: (sql: string) => wrap(db.prepare(sql)),
      exec: (sql: string) => db.exec(sql),
      batch: (stmts: any[]) => {
        calls.batches++;
        calls.batchedStatements += stmts.length;
        if (failBatch) throw new Error("batch rejected");
        return db.batch(stmts.map(s => s.__inner ?? s));
      },
    } as unknown as D1Database;
    return { DB, calls };
  }

  const rolledUp = (db: D1Mock) =>
    db.entries.filter(e => JSON.parse(e.tags ?? "[]").includes("rolled-up")).map(e => e.id).sort();

  it("marks every source in a single batch rather than one statement per row", async () => {
    seedEntries(db, "work", 15, { recall_count: 0 });
    const { DB, calls } = countingDb(db);
    const { ctx, drain } = makeCtx();

    const result = await compressTag("work", makeTestEnv(db, { AI: makeDigestAI(), DB }), ctx);
    await drain();

    expect(result.synthesizedId).not.toBeNull();
    expect(calls.batches).toBe(1);
    expect(calls.batchedStatements).toBe(15);
    expect(rolledUp(db)).toHaveLength(15);
  });

  it("falls back to per-row writes when the batch is rejected", async () => {
    // batch() is atomic, so without this fallback one bad row would un-mark every
    // source for the tag — and an unmarked source is compressed again later,
    // turning one duplicate digest into a whole tag's worth.
    seedEntries(db, "work", 15, { recall_count: 0 });
    const { DB, calls } = countingDb(db, true);
    const { ctx, drain } = makeCtx();

    const result = await compressTag("work", makeTestEnv(db, { AI: makeDigestAI(), DB }), ctx);
    await drain();

    expect(result.synthesizedId).not.toBeNull();
    expect(calls.batches).toBe(1);
    expect(rolledUp(db)).toHaveLength(15);
  });

  it("keeps marking the rest when one row fails during the fallback", async () => {
    seedEntries(db, "work", 15, { recall_count: 0 });
    const { DB } = countingDb(db, true, ["entry-7"]);
    const { ctx, drain } = makeCtx();

    await compressTag("work", makeTestEnv(db, { AI: makeDigestAI(), DB }), ctx);
    await drain();

    const marked = rolledUp(db);
    expect(marked).toHaveLength(14);
    expect(marked).not.toContain("entry-7");
  });
});
