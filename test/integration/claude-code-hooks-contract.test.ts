/**
 * The Claude Code hooks, checked against the Worker they actually call.
 *
 * test/unit/claude-code-hooks.test.ts re-implements the two scripts' helper
 * functions inside the test file and asserts on the copies. That verifies the
 * string formatting and nothing else — in particular not the request each script
 * builds, which is the only part that can disagree with the Worker.
 *
 * It did disagree. session-start.js sent `?q=`; GET /recall reads `query` and
 * answers 400 without it, and the script's own `if (!res.ok) return` swallowed
 * that, so the hook printed nothing at the start of every session and looked
 * exactly like a brain with no relevant memories. Nothing failed, anywhere.
 *
 * So these run the real files, capture the request each one makes, and replay it
 * against the real route handlers. A parameter rename on either side fails here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";

const run = promisify(execFile);
const HOOKS = resolve(import.meta.dirname, "../../integrations/claude-code-hooks");
const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

interface Captured { method: string; url: string; body: string }

let server: Server;
let origin = "";
let captured: Captured[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      // Shaped like a real answer so the script proceeds past its own guards.
      res.end(JSON.stringify({ ok: true, results: [{ content: "a remembered thing" }] }));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>(r => server.close(() => r())));

let sqlite: SqliteD1;
let env: Env;

beforeEach(async () => {
  captured = [];
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});

afterEach(() => sqlite?.close());

/** Replay a captured request against the real Worker. */
function replay(c: Captured): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${c.url}`, {
      method: c.method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: c.method === "GET" || c.method === "HEAD" ? undefined : c.body,
    }),
    env,
    ctx,
  );
}

describe("integrations/claude-code-hooks speak the Worker's API", () => {
  it("session-start's recall request is one GET /recall accepts", async () => {
    const { stdout } = await run("node", [`${HOOKS}/session-start.js`], {
      env: { ...process.env, SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token" },
    });
    // It got far enough to print, which means it did not bail on a non-ok response.
    expect(stdout).toContain("Context recalled");

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe("GET");
    expect(req.url.startsWith("/recall?")).toBe(true);

    // The assertion that matters: the exact URL the shipped script builds, put to
    // the route it is aimed at. `?q=` returned 400 here for the life of the hook.
    const res = await replay(req);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it("session-end's capture request is one POST /capture accepts", async () => {
    // Claude Code pipes the transcript in on stdin (see install.sh's SessionEnd
    // wiring), so the script is fed the same way here rather than through argv.
    const transcript = JSON.stringify({
      messages: [
        { role: "user", content: "We settled on Vectorize for semantic search rather than a KV index." },
        { role: "assistant", content: "Noted — Vectorize it is, with the keyword arm as the fallback." },
      ],
    });
    await new Promise<void>((done, fail) => {
      const child = spawn("node", [`${HOOKS}/session-end.js`], {
        env: { ...process.env, SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token" },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", fail);
      child.on("close", () => done());
      child.stdin.end(transcript);
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/capture");

    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ source: "claude-code" });
    expect(typeof body.content).toBe("string");

    const res = await replay(req);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });
});
