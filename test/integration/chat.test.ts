import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /chat", () => {
  let env: Env;

  beforeEach(() => {
    env = makeTestEnv(makeTestDb());
  });

  it("rejects missing auth token → 401", async () => {
    const res = await worker.fetch(req("POST", "/chat", { token: null, body: { query: "hello" } }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "Authorization": "Bearer test-token", "Content-Type": "application/json" },
        body: "not json",
      }),
      env, ctx
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when query is missing", async () => {
    const res = await worker.fetch(req("POST", "/chat", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/query/i);
  });

  it("returns 400 when query is empty string", async () => {
    const res = await worker.fetch(req("POST", "/chat", { body: { query: "   " } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns SSE stream on happy path", async () => {
    const res = await worker.fetch(
      req("POST", "/chat", { body: { query: "what do I know about React?", memories: "React is a UI library." } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("passes query and memories to the AI model", async () => {
    const query = "summarise my notes";
    const memories = "Note A. Note B.";
    await worker.fetch(req("POST", "/chat", { body: { query, memories } }), env, ctx);

    const aiMock = env.AI.run as ReturnType<typeof import("vitest").vi.fn>;
    const [, callArgs] = aiMock.mock.calls[0] as [string, { messages: { role: string; content: string }[] }];
    const userMsg = callArgs.messages.find((m: { role: string }) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain(query);
    expect(userMsg).toContain(memories);
  });
});
