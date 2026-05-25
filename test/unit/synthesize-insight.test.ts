import { describe, it, expect, vi } from "vitest";
import { synthesizeInsight } from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function aiMock(response: string) {
  return { run: vi.fn().mockResolvedValue(makeSseStream(response)) } as unknown as Ai;
}

describe("synthesizeInsight()", () => {
  it("returns empty string immediately when rows is empty — AI not called", async () => {
    const env = makeTestEnv();
    const result = await synthesizeInsight("some query", [], env);
    expect(result).toBe("");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns LLM response on happy path", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("Use JWT with short expiry and refresh tokens.") });
    const result = await synthesizeInsight(
      "auth strategy",
      [{ id: "1", content: "We chose JWT with 1hr expiry" }],
      env
    );
    expect(result).toBe("Use JWT with short expiry and refresh tokens.");
  });

  it("returns empty string when LLM throws — does not propagate error", async () => {
    const env = makeTestEnv(undefined, {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI unavailable")) } as unknown as Ai,
    });
    const result = await synthesizeInsight("query", [{ id: "1", content: "content" }], env);
    expect(result).toBe("");
  });

  it("returns empty string when LLM response text is empty", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("") });
    const result = await synthesizeInsight("query", [{ id: "1", content: "content" }], env);
    expect(result).toBe("");
  });

  it("trims whitespace from LLM response", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("  padded insight  ") });
    const result = await synthesizeInsight("query", [{ id: "1", content: "content" }], env);
    expect(result).toBe("padded insight");
  });

  it("includes the query in the prompt sent to LLM", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeInsight("fintech auth strategy", [{ id: "1", content: "note" }], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toContain("fintech auth strategy");
  });

  it("includes all row content in the prompt", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeInsight("query", [
      { id: "1", content: "JWT decision" },
      { id: "2", content: "switched to Postgres" },
    ], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toContain("JWT decision");
    expect(messages[0].content).toContain("switched to Postgres");
  });
});