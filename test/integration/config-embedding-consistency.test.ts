/**
 * #245 — the embedding model must be consistent across every path that writes
 * or reads vectors.
 *
 * This is the sharpest hazard in making EMBEDDING_MODEL configurable: if
 * capture embeds with the configured model while recall still embeds with the
 * compiled-in default (or vice versa), the two produce vectors from different
 * models and every similarity score becomes meaningless. Nothing would throw —
 * recall would just quietly return wrong answers.
 *
 * So this asserts the property directly: with an override in KV, every embed
 * call made by any path uses the same configured model.
 */
import { describe, it, expect, vi } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { captureEntry } from "../../src/capture/entry";
import { CONFIG_KEY, DEFAULTS } from "../../src/config";
import { makeTestEnv, makeTestDb, makeVectorizeMock, makeMemoryKV } from "../helpers/make-env";

const OVERRIDE_MODEL = "@cf/baai/bge-base-en-v1.5";

function envRecordingModels() {
  const models: string[] = [];
  const kv = makeMemoryKV();
  const db = makeTestDb();
  const env = makeTestEnv(db, {
    OAUTH_KV: kv,
    AI: {
      run: vi.fn().mockImplementation(async (model: string) => {
        models.push(model);
        // Embedding models return data[]; text models return a stream. Only the
        // embedding shape is needed here.
        return { data: [[0.1, 0.2, 0.3]] };
      }),
    } as never,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: [] }),
      upsert: vi.fn().mockResolvedValue({}),
    }),
  });
  return { env, db, kv, models };
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe("embedding model consistency (#245)", () => {
  it("recall embeds with the configured model", async () => {
    const { env, kv, models } = envRecordingModels();
    await kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }));

    await recallEntries({ query: "anything", topK: 5 }, env, ctx);

    expect(models.length).toBeGreaterThan(0);
    expect(models).not.toContain(DEFAULTS.EMBEDDING_MODEL);
  });

  it("capture embeds with the configured model", async () => {
    const { env, kv, models } = envRecordingModels();
    await kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }));

    await captureEntry("a memory worth storing", ["test"], "api", env, ctx);

    const embeddingCalls = models.filter(m => m.includes("bge"));
    expect(embeddingCalls.length).toBeGreaterThan(0);
    expect(embeddingCalls).not.toContain(DEFAULTS.EMBEDDING_MODEL);
  });

  it("both paths agree on the model, so vectors stay comparable", async () => {
    const capture = envRecordingModels();
    await capture.kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }));
    await captureEntry("a memory worth storing", [], "api", capture.env, ctx);

    const recall = envRecordingModels();
    await recall.kv.put(CONFIG_KEY, JSON.stringify({ EMBEDDING_MODEL: OVERRIDE_MODEL }));
    await recallEntries({ query: "anything", topK: 5 }, recall.env, ctx);

    const captureModels = new Set(capture.models.filter(m => m.includes("bge")));
    const recallModels = new Set(recall.models.filter(m => m.includes("bge")));

    expect([...captureModels]).toEqual([...recallModels]);
  });
});
