import { describe, it, expect, vi } from "vitest";
import { synthesizeDigest } from "../../src/index";
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

describe("synthesizeDigest()", () => {
  it("returns empty string immediately when rows is empty — AI not called", async () => {
    const env = makeTestEnv();
    const result = await synthesizeDigest("work", [], env);
    expect(result).toBe("");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns LLM response on happy path", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("The work on the API redesign is progressing well.") });
    const result = await synthesizeDigest(
      "work",
      [{ id: "1", content: "Started API redesign" }, { id: "2", content: "Decided on REST over GraphQL" }],
      env
    );
    expect(result).toBe("The work on the API redesign is progressing well.");
  });

  it("returns empty string when LLM throws — does not propagate error", async () => {
    const env = makeTestEnv(undefined, {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI unavailable")) } as unknown as Ai,
    });
    const result = await synthesizeDigest("work", [{ id: "1", content: "content" }], env);
    expect(result).toBe("");
  });

  it("returns empty string when LLM response text is empty", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("") });
    const result = await synthesizeDigest("work", [{ id: "1", content: "content" }], env);
    expect(result).toBe("");
  });

  it("trims whitespace from LLM response", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("  padded digest  ") });
    const result = await synthesizeDigest("work", [{ id: "1", content: "content" }], env);
    expect(result).toBe("padded digest");
  });

  it("includes the tag in the prompt sent to LLM", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeDigest("second-brain", [{ id: "1", content: "note" }], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toContain("second-brain");
  });

  it("includes all row content in the prompt", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeDigest("work", [
      { id: "1", content: "Shipped v1.4.0" },
      { id: "2", content: "Contradiction detection added" },
    ], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toContain("Shipped v1.4.0");
    expect(messages[0].content).toContain("Contradiction detection added");
  });
});
