import { describe, it, expect, vi } from "vitest";
import { embed } from "../../src/lib/ai";
import { DEFAULTS } from "../../src/config";
import { makeTestEnv } from "../helpers/make-env";

describe("embed() input shape", () => {
  it("sends the bge-en models the plain text array they accept", async () => {
    const env = makeTestEnv();
    await embed("hello", env, DEFAULTS);
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["hello"] });
  });

  it("asks bge-m3 to truncate over-long input instead of rejecting it", async () => {
    const env = makeTestEnv();
    await embed("hello", env, { ...DEFAULTS, EMBEDDING_MODEL: "@cf/baai/bge-m3" });
    expect(vi.mocked(env.AI.run).mock.calls[0][1]).toEqual({ text: ["hello"], truncate_inputs: true });
  });
});
