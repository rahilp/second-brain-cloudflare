import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { SB_VERSION } from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /health", () => {
  let db: D1Mock;
  beforeEach(() => { db = makeTestDb(); });

  it("returns 401 without auth", async () => {
    const env = makeTestEnv(db);
    const res = await worker.fetch(req("GET", "/health", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("reports vectorize ok when the index is reachable", async () => {
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
    });
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.vectorize.ok).toBe(true);
    expect(data.vectorize.indexName).toBe("second-brain-vectors");
  });

  it("echoes the Worker version (used by the desktop app's update check)", async () => {
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
    });
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    const data = await res.json() as any;
    expect(data.version).toBe(SB_VERSION);
    expect(SB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports vectorize not-ok when the index is missing", async () => {
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockRejectedValue(new Error("index not found")) }),
    });
    const res = await worker.fetch(req("GET", "/health"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.vectorize.ok).toBe(false);
    expect(data.vectorize.error).toContain("index not found");
  });
});
