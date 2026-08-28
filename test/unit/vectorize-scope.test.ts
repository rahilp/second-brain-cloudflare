import { describe, expect, it, vi } from "vitest";
import { makeVectorizeMock, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { D1Mock } from "../helpers/d1-mock";
import { queryVectorizeScoped, singleWorkspaceFilter, workspaceFilter } from "../../src/vectorize/scope";
import { storeEntry } from "../../src/capture/store";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Identity } from "../../src/lib/identity";

const identity: Identity = {
  userId: "u1",
  role: "member",
  personalWorkspaceId: "ws-p",
  companyWorkspaceIds: ["ws-c"],
  defaultShare: "" as const,
};

describe("vectorize workspace scoping", () => {
  it("builds the readable-set filter for queries and the single-workspace filter for writes", () => {
    expect(workspaceFilter(identity)).toEqual({ filter: { workspace_id: { $in: ["ws-p", "ws-c"] } } });
    expect(singleWorkspaceFilter("ws-p")).toEqual({ filter: { workspace_id: { $in: ["ws-p"] } } });
  });

  it("passes the filter to Vectorize and reports a clean query", async () => {
    const v = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [{ id: "x", score: 0.9 }] }),
    });
    const { matches, degraded } = await queryVectorizeScoped(
      v as never, [0.1], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter },
    );
    expect(degraded).toBe(false);
    expect(matches).toHaveLength(1);
    // The filtered call carried both the filter and the metadata/values shape
    // recall's fusion expects.
    expect(v.query).toHaveBeenCalledWith([0.1], expect.objectContaining({
      topK: 5,
      filter: { workspace_id: { $in: ["ws-p"] } },
      returnMetadata: "all",
      returnValues: true,
    }));
  });

  it("retries unfiltered when Vectorize rejects the filter itself, but propagates other errors", async () => {
    const calls: unknown[] = [];
    const v = makeVectorizeMock({
      query: vi.fn().mockImplementation(async (_values: number[], opts: unknown) => {
        calls.push(opts);
        if (calls.length === 1) throw new Error("unsupported filter syntax");
        return { matches: [{ id: "y", score: 0.5 }] };
      }),
    });
    const { degraded, matches } = await queryVectorizeScoped(
      v as never, [0.2], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter },
    );
    expect(degraded).toBe(true);
    expect(matches).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect((calls[1] as Record<string, unknown>).filter).toBeUndefined();

    // A non-filter failure is not the filter's fault — rethrow, no widening.
    const down = makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) });
    await expect(queryVectorizeScoped(down as never, [0.3], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter }))
      .rejects.toThrow(/index unavailable/);
    expect(down.query).toHaveBeenCalledTimes(1);
  });

  it("stamps the write context's workspace into upserted vector metadata", async () => {
    const d1 = makeSqliteD1();
    const v = makeVectorizeMock();
    const env = { ...makeTestEnv(d1.db as unknown as D1Mock), VECTORIZE: v } as never;
    resetDatabaseInit();
    await initializeDatabase(env);
    await storeEntry(
      env,
      "e1",
      "some content worth indexing",
      [],
      "api",
      Date.now(),
      undefined,
      { workspaceId: "ws-team", actorId: "u9" },
    );
    expect(v.upsert).toHaveBeenCalledTimes(1);
    const vectors = (v.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as { metadata: Record<string, unknown> }[];
    for (const vec of vectors) expect(vec.metadata.workspace_id).toBe("ws-team");
  });
});
