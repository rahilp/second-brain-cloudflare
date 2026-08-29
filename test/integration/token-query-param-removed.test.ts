/**
 * `?token=` is gone. The Authorization header is the only way in.
 *
 * A query-string credential is written down everywhere a URL is: browser
 * history, proxy and CDN access logs, and the Referer header sent to every
 * third-party origin the page touches. None of those are places a bearer token
 * that grants full read/write access to someone's memory can survive being
 * copied to, and unlike a header it is copied there by infrastructure the
 * deployment does not control and cannot audit.
 *
 * These cases use the owner's REAL token throughout. That is the point: the
 * rejection has to be about where the credential was presented, not whether it
 * is valid, or the test would pass against a Worker that simply got the token
 * wrong.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";

const ROOT = resolve(import.meta.dirname, "../..");
const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
const TOKEN = "test-token";

/** Exactly the surface test/integration/auth.test.ts guards. */
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

/** The two surfaces still guarded by the legacy AUTH_TOKEN-only requireAuth. */
const LEGACY_AUTH_ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/migration/status", undefined],
  ["POST", "/migration/reset", undefined],
  ["POST", "/oauth/revoke-all", undefined],
];

/** Appends ?token=<TOKEN> to a path that may already carry a query string. */
const withQueryToken = (path: string) => `${path}${path.includes("?") ? "&" : "?"}token=${TOKEN}`;

function call(method: string, path: string, body: unknown, headers: Record<string, string>, env: Env) {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

let env: Env;
beforeEach(() => { env = makeTestEnv(); });

describe("the query form is refused", () => {
  for (const [method, path, body] of PROTECTED_ROUTES) {
    it(`${method} ${path} — valid token in ?token= only → 401`, async () => {
      const res = await call(method, withQueryToken(path), body, {}, env);
      expect(res.status).toBe(401);
    });
  }

  for (const [method, path, body] of LEGACY_AUTH_ROUTES) {
    it(`${method} ${path} — valid token in ?token= only → 401`, async () => {
      const res = await call(method, withQueryToken(path), body, {}, env);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
    });
  }

  it("does not let the query form stand in for a wrong header", async () => {
    // The header is present and wrong; a leftover fallback would rescue it.
    const res = await call("GET", withQueryToken("/list"), undefined, { Authorization: "Bearer wrong" }, env);
    expect(res.status).toBe(401);
  });
});

describe("the header form still works", () => {
  for (const [method, path, body] of PROTECTED_ROUTES) {
    // /mcp is answered by the OAuth provider rather than a REST route; it is
    // covered as a 401 above and by test/integration/auth-error-codes.test.ts.
    if (path === "/mcp") continue;
    it(`${method} ${path} — Authorization header → not 401`, async () => {
      const res = await call(method, path, body, { Authorization: `Bearer ${TOKEN}` }, env);
      expect(res.status).not.toBe(401);
    });
  }

  for (const [method, path, body] of LEGACY_AUTH_ROUTES) {
    it(`${method} ${path} — Authorization header → not 401`, async () => {
      const res = await call(method, path, body, { Authorization: `Bearer ${TOKEN}` }, env);
      expect(res.status).not.toBe(401);
    });
  }
});

describe("no code path reads a token out of the query string", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
    });
  }

  it("finds no searchParams.get(\"token\") anywhere under src/", () => {
    const offenders = sourceFiles(resolve(ROOT, "src")).filter((file) =>
      /searchParams\.get\(\s*["'`]token["'`]\s*\)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
