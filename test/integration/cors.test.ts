import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("CORS", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(); });

  it("OPTIONS /capture returns 200 with CORS headers (no auth required)", async () => {
    const request = new Request("http://localhost/capture", { method: "OPTIONS" });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("successful JSON response includes CORS header", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello" } }), env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
