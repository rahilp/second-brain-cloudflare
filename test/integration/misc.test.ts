import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("Unmatched routes", () => {
  let env: Env;

  beforeEach(() => {
    env = makeTestEnv(makeTestDb());
  });

  it("returns 404 for an unknown path", async () => {
    const res = await worker.fetch(req("GET", "/no-such-route"), env, ctx);
    expect(res.status).toBe(404);
  });
});
