import { describe, it, expect, vi } from "vitest";
import { checkVectorizeHealth } from "../../src/vectorize/health";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";

describe("checkVectorizeHealth", () => {
  it("returns ok with the index name and dimensions when describe() resolves", async () => {
    const env = makeTestEnv(makeTestDb(), {
      VECTORIZE: makeVectorizeMock({
        describe: vi.fn().mockResolvedValue({ dimensions: 384, metric: "cosine" }),
      }),
    });
    const health = await checkVectorizeHealth(env);
    expect(health.ok).toBe(true);
    expect(health.indexName).toBe("second-brain-vectors");
    expect(health.dimensions).toBe(384);
  });

  it("reads dimensions from a beta-shaped config object", async () => {
    const env = makeTestEnv(makeTestDb(), {
      VECTORIZE: makeVectorizeMock({
        describe: vi.fn().mockResolvedValue({ config: { dimensions: 384, metric: "cosine" } }),
      }),
    });
    const health = await checkVectorizeHealth(env);
    expect(health.ok).toBe(true);
    expect(health.dimensions).toBe(384);
  });

  it("returns not-ok with the error message when describe() rejects", async () => {
    const env = makeTestEnv(makeTestDb(), {
      VECTORIZE: makeVectorizeMock({
        describe: vi.fn().mockRejectedValue(new Error("index not found")),
      }),
    });
    const health = await checkVectorizeHealth(env);
    expect(health.ok).toBe(false);
    expect(health.indexName).toBe("second-brain-vectors");
    expect(health.error).toContain("index not found");
  });
});
