/**
 * The nightly KV recorder GET /stats/night reads back from. Isolated from the
 * scheduled() wiring (test/integration/stats-night.test.ts covers that end to
 * end) so its own contract, one full record, one put, never throws, is
 * pinned directly.
 */
import { describe, it, expect, vi } from "vitest";
import { recordNightSummary, readNightSummary, nightSummaryKey } from "../../src/runtime/night-summary";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

describe("recordNightSummary", () => {
  it("writes one full record under night:<workspaceId>", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    const before = Date.now();

    await recordNightSummary(env, "ws-a", {
      linksInferred: 3, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 5,
    });

    const raw = await kv.get(nightSummaryKey("ws-a"));
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw as string);
    expect(record).toMatchObject({ linksInferred: 3, insightsProposed: 0, digestsWritten: 1, claimsFlagged: 5 });
    expect(record.ranAt).toBeGreaterThanOrEqual(before);
  });

  it("keys each workspace's record separately", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });

    await recordNightSummary(env, "ws-a", { linksInferred: 1, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0 });
    await recordNightSummary(env, "ws-b", { linksInferred: 9, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0 });

    expect(await readNightSummary(env, "ws-a")).toMatchObject({ linksInferred: 1 });
    expect(await readNightSummary(env, "ws-b")).toMatchObject({ linksInferred: 9 });
  });

  it("swallows a failing put and never throws", async () => {
    const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get: vi.fn().mockResolvedValue(null), put, delete: vi.fn(), list: vi.fn() } as any,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordNightSummary(env, "ws-a", {
      linksInferred: 1, insightsProposed: 0, digestsWritten: 0, claimsFlagged: 0,
    })).resolves.toBeUndefined();

    expect(put).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("readNightSummary", () => {
  it("returns null when nothing was ever recorded", async () => {
    const kv = makeMemoryKV();
    const env = makeTestEnv(undefined, { OAUTH_KV: kv });
    expect(await readNightSummary(env, "ws-a")).toBeNull();
  });

  it("swallows a failing get and returns null", async () => {
    const get = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get, put: vi.fn(), delete: vi.fn(), list: vi.fn() } as any,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await readNightSummary(env, "ws-a")).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns null for unparseable stored JSON rather than throwing", async () => {
    const get = vi.fn().mockResolvedValue("not json");
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get, put: vi.fn(), delete: vi.fn(), list: vi.fn() } as any,
    });
    expect(await readNightSummary(env, "ws-a")).toBeNull();
  });
});
