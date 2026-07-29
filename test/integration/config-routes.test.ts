/**
 * #245 "also in scope": authenticated config read/write routes for the desktop
 * app (#246) to call.
 *
 * These go through the real default handler — same path a request from the
 * Tauri app takes — rather than calling the route function directly, so the
 * auth gate and route registration are exercised too.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDefaultHandler } from "../../src/routes/index";
import { DEFAULTS, CONFIG_KEY, resolveConfig } from "../../src/config";
import { makeTestEnv, makeTestDb, makeMemoryKV } from "../helpers/make-env";
import type { Env } from "../../src/env";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const TOKEN = "test-token";

function req(path: string, init: RequestInit = {}, auth = true) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

describe("config routes", () => {
  let env: Env;
  let kv: KVNamespace;
  let handler: ReturnType<typeof createDefaultHandler>;

  beforeEach(() => {
    kv = makeMemoryKV();
    env = makeTestEnv(makeTestDb(), { OAUTH_KV: kv, AUTH_TOKEN: TOKEN });
    handler = createDefaultHandler();
  });

  describe("GET /config", () => {
    it("requires authentication", async () => {
      const res = await handler.fetch(req("/config", {}, false), env, ctx);
      expect(res.status).toBe(401);
    });

    it("returns the effective config and which keys are overridden", async () => {
      const res = await handler.fetch(req("/config"), env, ctx);
      const body = await res.json() as { ok: boolean; config: Record<string, unknown>; overrides: Record<string, unknown> };

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.config.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
      // Nothing overridden yet — the UI needs this to show "default" per row.
      expect(body.overrides).toEqual({});
    });

    it("reports defaults alongside the effective values so the UI can offer reset", async () => {
      const res = await handler.fetch(req("/config"), env, ctx);
      const body = await res.json() as { defaults: Record<string, unknown> };
      expect(body.defaults.RECENCY_FLOOR).toBe(DEFAULTS.RECENCY_FLOOR);
    });

    it("shows an override once one is stored", async () => {
      await kv.put(CONFIG_KEY, JSON.stringify({ MMR_LAMBDA: 0.42 }));

      const res = await handler.fetch(req("/config"), env, ctx);
      const body = await res.json() as { config: Record<string, unknown>; overrides: Record<string, unknown> };

      expect(body.config.MMR_LAMBDA).toBe(0.42);
      expect(body.overrides).toEqual({ MMR_LAMBDA: 0.42 });
    });
  });

  describe("PATCH /config", () => {
    it("requires authentication", async () => {
      const res = await handler.fetch(
        req("/config", { method: "PATCH", body: JSON.stringify({ MMR_LAMBDA: 0.5 }) }, false), env, ctx);
      expect(res.status).toBe(401);
    });

    it("applies a valid change and it survives a re-read", async () => {
      const res = await handler.fetch(
        req("/config", { method: "PATCH", body: JSON.stringify({ MMR_LAMBDA: 0.42 }) }), env, ctx);

      expect(res.status).toBe(200);
      expect((await resolveConfig(env)).MMR_LAMBDA).toBe(0.42);
    });

    it("rejects an out-of-range value with 400 and a message naming the key", async () => {
      const res = await handler.fetch(
        req("/config", { method: "PATCH", body: JSON.stringify({ MMR_LAMBDA: 99 }) }), env, ctx);
      const body = await res.json() as { ok: boolean; error: string };

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/MMR_LAMBDA/);
    });

    it("rejects an invariant violation with a message naming the conflict", async () => {
      const res = await handler.fetch(
        req("/config", {
          method: "PATCH",
          body: JSON.stringify({ DUPLICATE_BLOCK_THRESHOLD: 0.5, DUPLICATE_FLAG_THRESHOLD: 0.9 }),
        }), env, ctx);
      const body = await res.json() as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/DUPLICATE_BLOCK_THRESHOLD/);
    });

    it("rejects an unknown key", async () => {
      const res = await handler.fetch(
        req("/config", { method: "PATCH", body: JSON.stringify({ NOPE: 1 }) }), env, ctx);
      expect(res.status).toBe(400);
    });

    it("rejects a malformed body without throwing", async () => {
      const res = await handler.fetch(
        req("/config", { method: "PATCH", body: "{ not json" }), env, ctx);
      expect(res.status).toBe(400);
    });

    it("leaves stored config untouched when the patch is rejected", async () => {
      await handler.fetch(req("/config", { method: "PATCH", body: JSON.stringify({ MMR_LAMBDA: 0.42 }) }), env, ctx);
      await handler.fetch(req("/config", { method: "PATCH", body: JSON.stringify({ MMR_LAMBDA: 99 }) }), env, ctx);

      expect((await resolveConfig(env)).MMR_LAMBDA).toBe(0.42);
    });
  });

  describe("DELETE /config/:key", () => {
    it("requires authentication", async () => {
      const res = await handler.fetch(req("/config/MMR_LAMBDA", { method: "DELETE" }, false), env, ctx);
      expect(res.status).toBe(401);
    });

    it("resets one key and leaves the others overridden", async () => {
      await kv.put(CONFIG_KEY, JSON.stringify({ MMR_LAMBDA: 0.42, RECENCY_FLOOR: 0.4 }));

      const res = await handler.fetch(req("/config/MMR_LAMBDA", { method: "DELETE" }), env, ctx);
      const config = await resolveConfig(env);

      expect(res.status).toBe(200);
      expect(config.MMR_LAMBDA).toBe(DEFAULTS.MMR_LAMBDA);
      expect(config.RECENCY_FLOOR).toBe(0.4);
    });

    it("404s on an unknown key rather than silently succeeding", async () => {
      const res = await handler.fetch(req("/config/NOT_A_KEY", { method: "DELETE" }), env, ctx);
      expect(res.status).toBe(404);
    });
  });
});
