import { afterEach, describe, expect, it, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import type { RecallDiagnostics } from "../../src/recall/types";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as unknown as ExecutionContext;

describe("single-token corpus df in hybrid recall", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => { sqlite?.close(); sqlite = undefined; });

  it.each([
    ["quartzcode", "quartzcode release record"],
    ["PR70", "同期PR70の release record"],
    ["同期PR70の", "同期PR70の release record"],
  ])("keeps a lexical hit in the top five for %s", async (query, content) => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    const now = Date.now();
    const env: Env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({
        matches: Array.from({ length: 18 }, (_, i) => ({
          id: `dense-${i}`, score: .99 - i * .001,
          metadata: { parentId: `dense-${i}`, created_at: now },
        })),
      }) }),
    });
    await initializeDatabase(env);
    sqlite.seed({ id: "answer", content, createdAt: now });
    for (let i = 0; i < 18; i++) sqlite.seed({ id: `dense-${i}`, content: `general release note ${i}`, createdAt: now });

    const diagnostics: RecallDiagnostics = {};
    const result = await recallEntries(
      { query, topK: 5, hops: 0, synthesize: false }, env, ctx, undefined, { diagnostics },
    );

    expect(diagnostics.denseIds).not.toContain("answer");
    expect(diagnostics.keywordIds).toEqual(["answer"]);
    expect(diagnostics.corpusIdfUsed).toBe(true);
    expect(result.matches.map(match => match.id)).toContain("answer");
  });
});
