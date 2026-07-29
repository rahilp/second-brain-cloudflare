/**
 * #245 write path.
 *
 * Note the deliberate asymmetry with resolve: a bad value arriving from KV is
 * *repaired* (clamped, or the group reset) because recall must never fail on
 * it, but a bad value arriving from a caller is *rejected* with a message, so
 * the settings UI can say what conflicted instead of silently doing nothing.
 */
import { describe, it, expect } from "vitest";
import {
  readOverrides,
  writeOverrides,
  resetOverride,
  resolveConfig,
  DEFAULTS,
  CONFIG_KEY,
} from "../../src/config";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";

function envWithKV() {
  const kv = makeMemoryKV();
  return { env: makeTestEnv(undefined, { OAUTH_KV: kv }), kv };
}

describe("writeOverrides()", () => {
  it("stores only the changed key, not the whole config", async () => {
    const { env, kv } = envWithKV();

    await writeOverrides(env, { RECENCY_FLOOR: 0.4 });

    const stored = JSON.parse((await kv.get(CONFIG_KEY))!);
    expect(stored).toEqual({ RECENCY_FLOOR: 0.4 });
  });

  it("merges into existing overrides rather than replacing them", async () => {
    const { env, kv } = envWithKV();

    await writeOverrides(env, { RECENCY_FLOOR: 0.4 });
    await writeOverrides(env, { MMR_LAMBDA: 0.5 });

    const stored = JSON.parse((await kv.get(CONFIG_KEY))!);
    expect(stored).toEqual({ RECENCY_FLOOR: 0.4, MMR_LAMBDA: 0.5 });
  });

  // Storing a value equal to the default would freeze the user on today's
  // number: a retuned default in a later release could never reach them.
  it("does not persist a value that equals the shipped default", async () => {
    const { env, kv } = envWithKV();

    await writeOverrides(env, { RECENCY_FLOOR: DEFAULTS.RECENCY_FLOOR });

    const raw = await kv.get(CONFIG_KEY);
    expect(raw ? JSON.parse(raw) : {}).toEqual({});
  });

  it("rejects an unknown key by name", async () => {
    const { env } = envWithKV();

    const result = await writeOverrides(env, { NOT_A_SETTING: 1 } as never);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/NOT_A_SETTING/);
  });

  it("rejects an out-of-range value instead of silently clamping it", async () => {
    const { env } = envWithKV();

    const result = await writeOverrides(env, { MMR_LAMBDA: 5 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/MMR_LAMBDA/);
  });

  it("rejects a wrong-typed value", async () => {
    const { env } = envWithKV();

    const result = await writeOverrides(env, { GRAPH_MAX_HOPS: "three" } as never);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/GRAPH_MAX_HOPS/);
  });

  it("rejects an invariant violation with a message naming the conflict", async () => {
    const { env } = envWithKV();

    const result = await writeOverrides(env, {
      DUPLICATE_BLOCK_THRESHOLD: 0.5,
      DUPLICATE_FLAG_THRESHOLD: 0.9,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/DUPLICATE_BLOCK_THRESHOLD/);
    expect(result.ok === false && result.error).toMatch(/DUPLICATE_FLAG_THRESHOLD/);
  });

  it("catches an invariant violation against already-stored values, not just the patch", async () => {
    const { env } = envWithKV();
    await writeOverrides(env, { DUPLICATE_FLAG_THRESHOLD: 0.9 });

    // Valid alone, but inverts the pair once merged with what is stored.
    const result = await writeOverrides(env, { DUPLICATE_BLOCK_THRESHOLD: 0.6 });

    expect(result.ok).toBe(false);
  });

  it("writes nothing when the patch is rejected", async () => {
    const { env, kv } = envWithKV();

    await writeOverrides(env, { MMR_LAMBDA: 99 });

    expect(await kv.get(CONFIG_KEY)).toBeNull();
  });

  it("accepts a valid patch and it survives a round trip through resolveConfig", async () => {
    const { env } = envWithKV();

    const result = await writeOverrides(env, { MMR_LAMBDA: 0.42 });
    const config = await resolveConfig(env);

    expect(result.ok).toBe(true);
    expect(config.MMR_LAMBDA).toBe(0.42);
  });
});

describe("resetOverride()", () => {
  it("restores one value to its default and leaves siblings overridden", async () => {
    const { env } = envWithKV();
    await writeOverrides(env, { RECENCY_FLOOR: 0.4, MMR_LAMBDA: 0.5 });

    await resetOverride(env, "RECENCY_FLOOR");
    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
    expect(config.MMR_LAMBDA).toBe(0.5);
  });

  it("is a delete, so a later change to the shipped default reaches the user", async () => {
    const { env } = envWithKV();
    await writeOverrides(env, { RECENCY_FLOOR: 0.4 });

    await resetOverride(env, "RECENCY_FLOOR");

    const stored = await readOverrides(env);
    expect(stored).not.toHaveProperty("RECENCY_FLOOR");
  });

  it("is a no-op for a key that was never overridden", async () => {
    const { env } = envWithKV();
    await writeOverrides(env, { MMR_LAMBDA: 0.5 });

    await resetOverride(env, "RECENCY_FLOOR");
    const config = await resolveConfig(env);

    expect(config.MMR_LAMBDA).toBe(0.5);
  });
});

describe("readOverrides()", () => {
  it("returns an empty object when nothing is stored", async () => {
    const { env } = envWithKV();
    expect(await readOverrides(env)).toEqual({});
  });

  it("returns an empty object when KV throws", async () => {
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get: async () => { throw new Error("down"); } } as unknown as KVNamespace,
    });
    expect(await readOverrides(env)).toEqual({});
  });
});
