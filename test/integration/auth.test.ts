import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => { } } as any;

const PROTECTED_ROUTES: Array<[string, string, unknown?]> = [
  ["POST", "/capture", { content: "hello" }],
  ["POST", "/append", { id: "abc", addition: "update" }],
  ["GET", "/list", undefined],
  ["GET", "/tags", undefined],
  ["GET", "/recall?query=test", undefined],
  ["POST", "/forget", { id: "abc" }],
  ["POST", "/chat", { query: "what?" }],
  ["POST", "/mcp", undefined],
];

describe("Auth", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(); });

  for (const [method, path, body] of PROTECTED_ROUTES) {
    it(`${method} ${path} — no token → 401`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: null }), env, ctx);
      expect(res.status).toBe(401);
      const data = await res.json() as any;
      expect(data.error).toBe("Unauthorized");
    });

    it(`${method} ${path} — wrong token → 401`, async () => {
      const res = await worker.fetch(req(method, path, { body, token: "wrong-token" }), env, ctx);
      expect(res.status).toBe(401);
    });
  }
});

describe("OAuth sign-in page", () => {
  it("serves same-origin fonts and brand assets only, never a CDN", async () => {
    const res = await worker.fetch(new Request("http://localhost/oauth/authorize"), makeTestEnv(), ctx);
    const html = await res.text();
    expect(html).not.toMatch(/fonts\.googleapis/);
    expect(html).not.toMatch(/cdn\./);
    expect(html).toContain("/fonts/");
    expect(html).toContain("/brand-lockup.png");
  });
});
