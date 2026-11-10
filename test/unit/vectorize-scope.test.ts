import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeVectorizeMock, makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { D1Mock } from "../helpers/d1-mock";
import { queryVectorizeScoped, resetVectorizeFilterState, singleWorkspaceFilter, vectorizeFilterState, workspaceFilter } from "../../src/vectorize/scope";
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
  // The support latch and the "already reported" flag are module-scoped, so
  // without this every case here depends on the order the ones above it ran in.
  beforeEach(() => resetVectorizeFilterState());

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

  /**
   * The durable degradation marker (Task 8) is written by `onDegrade`, and only
   * some callers can supply one — a system pass has no request to hang a
   * `waitUntil` off. The flag that makes the marker fire once per isolate was
   * being set by whichever caller happened to discover the degradation FIRST,
   * handler or not. A handler-less discovery therefore wrote no marker and then
   * silenced every later recall and capture that could have written one, which
   * is strictly worse than not noticing: the observability was built and then
   * switched off by an unrelated code path.
   *
   * The property this pins: a degrade discovered on ANY path must still let the
   * next handler-bearing path report it, exactly once.
   */
  it("lets a later handler-bearing caller report a degrade a handler-less one discovered", async () => {
    const v = makeVectorizeMock({
      query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
        if (opts?.filter) throw new Error("unsupported filter syntax");
        return { matches: [] };
      }),
    });
    const filter = singleWorkspaceFilter("ws-p").filter;

    // A caller with nothing to report through discovers the degradation.
    const first = await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter });
    expect(first.degraded).toBe(true);
    expect(vectorizeFilterState().supported).toBe(false);

    // The next caller that CAN record it must still be asked to. This call is
    // served off the latch without ever reaching the filtered query, so the
    // report cannot depend on the rejection being re-observed.
    const onDegrade = vi.fn();
    await queryVectorizeScoped(v as never, [0.2], { topK: 5, filter, onDegrade });
    expect(onDegrade).toHaveBeenCalledTimes(1);

    // And still exactly once per isolate: a third caller pays nothing.
    const later = vi.fn();
    await queryVectorizeScoped(v as never, [0.3], { topK: 5, filter, onDegrade: later });
    expect(later).not.toHaveBeenCalled();
    expect(onDegrade).toHaveBeenCalledTimes(1);
    // Every one of those queries was served, unfiltered, and counted.
    expect(vectorizeFilterState().degradedQueries).toBe(3);
  });

  // Vectorize answers a filter on a property with no metadata index with zero
  // matches, not an error (#394), so a missing index has to be read off the result.
  describe("a filter that silently matches nothing", () => {
    const filter = workspaceFilter(identity)!.filter;
    const scoped = (calls: any[], unfiltered: { id: string; metadata?: Record<string, unknown> }[]) =>
      makeVectorizeMock({
        query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
          calls.push(opts);
          return { matches: opts?.filter ? [] : unfiltered.map(m => ({ score: 0.9, ...m })) };
        }),
      });

    it("falls back unfiltered when the caller's own vectors exist outside the filter", async () => {
      const calls: any[] = [];
      const v = scoped(calls, [
        { id: "foreign", metadata: { workspace_id: "ws-other" } },
        { id: "mine", metadata: { workspace_id: "ws-c" } },
      ]);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const onDegrade = vi.fn();
      try {
        const result = await queryVectorizeScoped<{ id: string }>(v as never, [0.1], { topK: 5, filter, onDegrade });
        expect(result.degraded).toBe(true);
        expect(result.matches.map(m => m.id)).toEqual(["foreign", "mine"]);
        expect(calls).toHaveLength(2);
        expect(calls[1].filter).toBeUndefined();
        expect(vectorizeFilterState()).toEqual({ supported: false, degradedQueries: 1 });
        expect(onDegrade).toHaveBeenCalledOnce();
        expect(errorLog).toHaveBeenCalledOnce();

        // Latched: the next query skips the broken filter entirely.
        await queryVectorizeScoped(v as never, [0.2], { topK: 5, filter });
        expect(calls).toHaveLength(3);
        expect(calls[2].filter).toBeUndefined();
      } finally {
        errorLog.mockRestore();
      }
    });

    it("does not count a vector without workspace_id as the caller's own", async () => {
      const calls: any[] = [];
      const v = scoped(calls, [{ id: "legacy" }]);
      const result = await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter });
      expect(result).toEqual({ matches: [], degraded: false });
      expect(vectorizeFilterState().supported).toBe(null);
    });

    it("keeps a genuinely empty scope empty and does not latch either way", async () => {
      const calls: any[] = [];
      const v = scoped(calls, [{ id: "foreign", metadata: { workspace_id: "ws-other" } }]);
      const onDegrade = vi.fn();
      const result = await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter, onDegrade });
      expect(result).toEqual({ matches: [], degraded: false });
      expect(calls).toHaveLength(2);
      expect(onDegrade).not.toHaveBeenCalled();
      // A brand-new workspace looks exactly like this, so the latch stays unset...
      expect(vectorizeFilterState()).toEqual({ supported: null, degradedQueries: 0 });
      // ...but the same empty scope is not probed again in this isolate.
      await queryVectorizeScoped(v as never, [0.2], { topK: 5, filter, onDegrade });
      expect(calls).toHaveLength(3);
      expect(calls[2].filter).toBeDefined();
      // A different scope still gets its own probe.
      await queryVectorizeScoped(v as never, [0.3], { topK: 5, filter: singleWorkspaceFilter("ws-p").filter });
      expect(calls).toHaveLength(5);
    });

    it("counts a vector without workspace_id as the caller's when '' is readable", async () => {
      const calls: any[] = [];
      const v = scoped(calls, [{ id: "legacy" }]);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter: { workspace_id: { $in: ["", "ws-p"] } } });
        expect(result.degraded).toBe(true);
        expect(vectorizeFilterState().supported).toBe(false);
      } finally {
        errorLog.mockRestore();
      }
    });

    it("does not remember a scope as empty when the probe itself failed", async () => {
      let probeFails = true;
      const calls: any[] = [];
      const v = makeVectorizeMock({
        query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
          calls.push(opts);
          if (opts?.filter) return { matches: [] };
          if (probeFails) throw new Error("index unavailable");
          return { matches: [{ id: "mine", score: 0.9, metadata: { workspace_id: "ws-p" } }] };
        }),
      });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter })).toEqual({ matches: [], degraded: false });
        probeFails = false;
        const second = await queryVectorizeScoped(v as never, [0.2], { topK: 5, filter });
        expect(second.degraded).toBe(true);
        expect(calls).toHaveLength(4);
      } finally {
        errorLog.mockRestore();
      }
    });

    it("probes an empty scope again once the memo expires", async () => {
      vi.useFakeTimers();
      try {
        const calls: any[] = [];
        const v = scoped(calls, []);
        await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter });
        await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter });
        expect(calls).toHaveLength(3);
        vi.advanceTimersByTime(5 * 60_000);
        await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter });
        expect(calls).toHaveLength(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never probes once the filter has returned matches in this isolate", async () => {
      let filtered: { id: string }[] = [{ id: "mine" }];
      const calls: any[] = [];
      const v = makeVectorizeMock({
        query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
          calls.push(opts);
          return { matches: opts?.filter ? filtered : [{ id: "mine", metadata: { workspace_id: "ws-p" } }] };
        }),
      });
      await queryVectorizeScoped(v as never, [0.1], { topK: 5, filter });
      expect(vectorizeFilterState().supported).toBe(true);
      filtered = [];
      const result = await queryVectorizeScoped(v as never, [0.2], { topK: 5, filter });
      expect(result).toEqual({ matches: [], degraded: false });
      expect(calls).toHaveLength(2);
    });
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
