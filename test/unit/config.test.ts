import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULTS, CONFIG_KEY } from "../../src/config";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";

function envWithKV(seed: Record<string, unknown> | null = null) {
  const kv = makeMemoryKV();
  const env = makeTestEnv(undefined, { OAUTH_KV: kv });
  return { env, kv, seed: async (v: Record<string, unknown>) => kv.put(CONFIG_KEY, JSON.stringify(v)) };
}

describe("resolveConfig()", () => {
  it("returns the shipped defaults when no overrides key exists", async () => {
    const { env } = envWithKV();

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
    expect(config.DUPLICATE_BLOCK_THRESHOLD).toBe(DEFAULTS.DUPLICATE_BLOCK_THRESHOLD);
    expect(config.GRAPH_MAX_HOPS).toBe(DEFAULTS.GRAPH_MAX_HOPS);
  });

  it("applies a stored override and leaves siblings on their defaults", async () => {
    const { env, seed } = envWithKV();
    await seed({ RECENCY_FLOOR: 0.4 });

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(0.4);
    expect(config.MMR_LAMBDA).toBe(DEFAULTS.MMR_LAMBDA);
    expect(config.GRAPH_MAX_HOPS).toBe(DEFAULTS.GRAPH_MAX_HOPS);
  });

  it("ignores unknown keys in the stored blob", async () => {
    const { env, seed } = envWithKV();
    await seed({ NOT_A_REAL_SETTING: 123, RECENCY_FLOOR: 0.4 });

    const config = await resolveConfig(env);

    expect(config).not.toHaveProperty("NOT_A_REAL_SETTING");
    expect(config.RECENCY_FLOOR).toBe(0.4);
  });

  it("returns pure defaults when KV throws", async () => {
    const env = makeTestEnv(undefined, {
      OAUTH_KV: { get: async () => { throw new Error("KV unavailable"); } } as unknown as KVNamespace,
    });

    const config = await resolveConfig(env);

    expect(config).toEqual({ ...DEFAULTS });
  });

  it("returns pure defaults when the stored blob is not valid JSON", async () => {
    const { env, kv } = envWithKV();
    await kv.put(CONFIG_KEY, "{ not json");

    const config = await resolveConfig(env);

    expect(config).toEqual({ ...DEFAULTS });
  });
});

describe("resolveConfig() validation", () => {
  // GRAPH_HOP_DECAY participates in no invariant, so this isolates clamping.
  it("clamps a numeric override above its range to the maximum", async () => {
    const { env, seed } = envWithKV();
    await seed({ GRAPH_HOP_DECAY: 5 });

    const config = await resolveConfig(env);

    expect(config.GRAPH_HOP_DECAY).toBe(1);
  });

  it("resets the whole group when clamping a value would still invert an invariant", async () => {
    const { env, seed } = envWithKV();
    // Clamps to 1, which is above RECENCY_FLOOR_DURABLE's default of 0.9 —
    // in range individually, but it inverts the tiering.
    await seed({ RECENCY_FLOOR: 5 });

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
    expect(config.RECENCY_FLOOR_DURABLE).toBe(DEFAULTS.RECENCY_FLOOR_DURABLE);
    expect(config.RECENCY_FLOOR_VOLATILE).toBe(DEFAULTS.RECENCY_FLOOR_VOLATILE);
  });

  it("accepts a value that moves within the group without inverting it", async () => {
    const { env, seed } = envWithKV();
    // 0.8 sits between volatile (0.15) and durable (0.9), so it must survive.
    await seed({ RECENCY_FLOOR: 0.8 });

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(0.8);
  });

  it("clamps a numeric override below its range to the minimum", async () => {
    const { env, seed } = envWithKV();
    await seed({ MMR_LAMBDA: -3 });

    const config = await resolveConfig(env);

    expect(config.MMR_LAMBDA).toBe(0);
  });

  it("falls back to the default when the value is the wrong type", async () => {
    const { env, seed } = envWithKV();
    await seed({ RECENCY_FLOOR: "not a number", GRAPH_MAX_HOPS: null });

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
    expect(config.GRAPH_MAX_HOPS).toBe(DEFAULTS.GRAPH_MAX_HOPS);
  });

  it("falls back to the default for NaN, which is typeof number", async () => {
    const { env, kv } = envWithKV();
    // NaN is not representable in JSON; a hand-edited blob can still smuggle it
    // in as a string that parses to NaN downstream.
    await kv.put(CONFIG_KEY, '{"RECENCY_FLOOR": "NaN"}');

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
  });

  it("rounds a non-integer override for an integer-valued setting", async () => {
    const { env, seed } = envWithKV();
    await seed({ GRAPH_MAX_HOPS: 2.7 });

    const config = await resolveConfig(env);

    expect(Number.isInteger(config.GRAPH_MAX_HOPS)).toBe(true);
  });

  it("falls back to the default when a model override is not a string", async () => {
    const { env, seed } = envWithKV();
    await seed({ LLM_MODEL: 42 });

    const config = await resolveConfig(env);

    expect(config.LLM_MODEL).toBe(DEFAULTS.LLM_MODEL);
  });

  it("keeps flagging reachable: block must stay above flag", async () => {
    const { env, seed } = envWithKV();
    // Inverted on purpose — flagging would be unreachable.
    await seed({ DUPLICATE_BLOCK_THRESHOLD: 0.5, DUPLICATE_FLAG_THRESHOLD: 0.9 });

    const config = await resolveConfig(env);

    expect(config.DUPLICATE_BLOCK_THRESHOLD).toBeGreaterThan(config.DUPLICATE_FLAG_THRESHOLD);
  });

  it("keeps durability tiering ordered: volatile <= base <= durable", async () => {
    const { env, seed } = envWithKV();
    await seed({ RECENCY_FLOOR_VOLATILE: 0.95, RECENCY_FLOOR: 0.5, RECENCY_FLOOR_DURABLE: 0.2 });

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR_VOLATILE).toBeLessThanOrEqual(config.RECENCY_FLOOR);
    expect(config.RECENCY_FLOOR).toBeLessThanOrEqual(config.RECENCY_FLOOR_DURABLE);
  });

  it("never returns a config that breaks an invariant, whatever the input", async () => {
    const { env, seed } = envWithKV();
    await seed({
      RECENCY_FLOOR: "garbage",
      RECENCY_FLOOR_DURABLE: -99,
      RECENCY_FLOOR_VOLATILE: 42,
      DUPLICATE_BLOCK_THRESHOLD: 0,
      DUPLICATE_FLAG_THRESHOLD: 1,
      GRAPH_MAX_HOPS: "three",
    });

    const config = await resolveConfig(env);

    expect(config.RECENCY_FLOOR_VOLATILE).toBeLessThanOrEqual(config.RECENCY_FLOOR);
    expect(config.RECENCY_FLOOR).toBeLessThanOrEqual(config.RECENCY_FLOOR_DURABLE);
    expect(config.DUPLICATE_BLOCK_THRESHOLD).toBeGreaterThan(config.DUPLICATE_FLAG_THRESHOLD);
    expect(Number.isFinite(config.GRAPH_MAX_HOPS)).toBe(true);
  });

  it("returns a frozen object so a caller cannot mutate shared config", async () => {
    const { env } = envWithKV();

    const config = await resolveConfig(env);

    expect(Object.isFrozen(config)).toBe(true);
  });
});
