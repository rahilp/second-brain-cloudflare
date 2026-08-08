/**
 * The dashboard's /import cursor walk (runImportLoop in public/js/settings.js).
 *
 * The paging protocol is the part of "Restore from backup" that can actually go
 * wrong: the client must pass next_offset / next_edge_offset back verbatim, keep
 * going while either remaining count is nonzero, and fail loudly against a
 * Worker that never advances the cursor (any pre-2.2.4 deploy) instead of
 * looping forever. The DOM handler around it is thin; this exercises the loop
 * directly in the same VM harness dashboard-modules uses.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function loadRunImportLoop(): (payload: any, post: any, onProgress?: any) => Promise<any> {
  const src = readFileSync(resolve(ROOT, "public/js/settings.js"), "utf8");
  const ctx: any = { window: {}, document: {}, fetch: () => {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.runImportLoop;
}

/** A Worker-side double: pages positionally, exactly like importExportPayload. */
function fakeWorker(entryCount: number, edgeCount: number, limit: number) {
  const calls: string[] = [];
  const post = async (query: string) => {
    calls.push(query);
    const offset = Number(new URLSearchParams(query).get("offset"));
    const edgeOffset = Number(new URLSearchParams(query).get("edge_offset"));
    const page = Math.max(0, Math.min(limit, entryCount - offset));
    const next_offset = offset + page;
    const entriesDone = next_offset >= entryCount;
    const edgePage = entriesDone ? Math.max(0, Math.min(limit, edgeCount - edgeOffset)) : 0;
    const next_edge_offset = edgeOffset + edgePage;
    return {
      imported: page,
      skipped: 0,
      failed: 0,
      edges_imported: edgePage,
      edges_skipped: 0,
      edges_failed: 0,
      next_offset,
      next_edge_offset,
      remaining_entries: entryCount - next_offset,
      remaining_edges: edgeCount - next_edge_offset,
    };
  };
  return { post, calls };
}

describe("runImportLoop", () => {
  it("walks entries then edges to completion and accumulates totals", async () => {
    const runImportLoop = loadRunImportLoop();
    const { post, calls } = fakeWorker(100, 50, 40);
    const payload = { entries: new Array(100), edges: new Array(50) };

    const totals = await runImportLoop(payload, post);

    expect(totals.imported).toBe(100);
    expect(totals.edges_imported).toBe(50);
    // 3 entry pages (40+40+20); the third also runs edge page 1 (40); one more
    // call finishes the last 10 edges.
    expect(calls).toEqual([
      "offset=0&edge_offset=0",
      "offset=40&edge_offset=0",
      "offset=80&edge_offset=0",
      "offset=100&edge_offset=40",
    ]);
  });

  it("reports progress after every page", async () => {
    const runImportLoop = loadRunImportLoop();
    const { post } = fakeWorker(80, 0, 40);
    const seen: number[] = [];

    await runImportLoop({ entries: new Array(80), edges: [] }, post, ({ done }: any) => seen.push(done));

    expect(seen).toEqual([40, 80]);
  });

  it("fails loudly against a Worker that never advances the cursor", async () => {
    const runImportLoop = loadRunImportLoop();
    // A pre-cursor Worker echoes no next_offset; ?? keeps the cursor at 0 and
    // remaining stays positive — the loop must throw, not spin.
    const post = async () => ({
      imported: 0, skipped: 40, failed: 0,
      edges_imported: 0, edges_skipped: 0, edges_failed: 0,
      remaining_entries: 60, remaining_edges: 0,
    });

    await expect(runImportLoop({ entries: new Array(100), edges: [] }, post))
      .rejects.toThrow(/did not advance/);
  });

  it("propagates a page failure instead of swallowing it", async () => {
    const runImportLoop = loadRunImportLoop();
    let n = 0;
    const { post } = fakeWorker(100, 0, 40);
    const flaky = async (q: string) => {
      if (++n === 2) throw new Error("Server error: 500");
      return post(q);
    };

    await expect(runImportLoop({ entries: new Array(100), edges: [] }, flaky))
      .rejects.toThrow(/500/);
  });
});
