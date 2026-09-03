/**
 * The Claude Code hooks, run as processes with the stdin Claude Code actually
 * sends, against a stub that records requests — then each request is replayed
 * through the real Worker. A parameter rename on either side fails here.
 *
 * The previous version fed session-end `{messages:[…]}` on stdin. Claude Code
 * has never sent that; it sends hook metadata with a transcript_path. The test
 * passed and the hook never captured a session.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import type { Env } from "../../src/env";

const HOOKS = resolve(import.meta.dirname, "../../integrations/claude-code-hooks");
const FIXTURE = join(HOOKS, "fixtures/sample-transcript.jsonl");
const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

interface Captured { method: string; url: string; body: string }
interface StubBehaviour { healthVersion?: string; recallStatus?: number; recallResults?: unknown[]; delayMs?: number }

let server: Server;
let origin = "";
let captured: Captured[] = [];
let behaviour: StubBehaviour = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", body });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const send = () => {
        if (req.url?.startsWith("/health")) return reply(200, { ok: true, version: behaviour.healthVersion ?? "3.0.0" });
        if (req.url?.startsWith("/recall")) {
          if (behaviour.recallStatus && behaviour.recallStatus >= 400) return reply(behaviour.recallStatus, { ok: false, code: "unauthorized" });
          return reply(200, { ok: true, results: behaviour.recallResults ?? [{ id: "m1", content: "a remembered thing", truncated: false }], insight: null });
        }
        return reply(200, { ok: true, id: "new-id" });
      };
      behaviour.delayMs ? setTimeout(send, behaviour.delayMs) : send();
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

let sqlite: SqliteD1;
let env: Env;
let scratch: string;
// HOME is redirected to `scratch` for isolation, so the hook's cwd must be a
// directory BELOW it: parseProjectName deliberately reports no project for
// $HOME itself, and Claude Code always runs with cwd set to a project.
let project: string;

beforeEach(async () => {
  captured = [];
  behaviour = {};
  scratch = mkdtempSync(join(tmpdir(), "sb-hooks-"));
  project = join(scratch, "brain-app");
  mkdirSync(project);
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});
afterEach(() => sqlite?.close());

/** Spawn a hook exactly as Claude Code does: payload on stdin, then EOF. Isolated HOME and cache. */
function runHook(script: string, payload: object, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("node", [`${HOOKS}/${script}`], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache"),
        SECOND_BRAIN_URL: origin, SECOND_BRAIN_TOKEN: "test-token",
        ...extraEnv,
      } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the hook must not inherit it
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", fail);
    child.on("close", code => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function replay(c: Captured): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${c.url}`, {
      method: c.method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: c.method === "GET" || c.method === "HEAD" ? undefined : c.body,
    }),
    env, ctx,
  );
}

const startPayload = (source = "startup") => ({ session_id: "s1", transcript_path: FIXTURE, cwd: project, hook_event_name: "SessionStart", source });
const endPayload = (transcript_path: string, reason = "prompt_input_exit") => ({ session_id: "fx", transcript_path, cwd: project, hook_event_name: "SessionEnd", reason });

describe("session-start.js", () => {
  it("makes a recall request GET /recall accepts, and prints framed context", async () => {
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("[Second Brain] Context recalled")).toBe(true);
    expect(r.stdout).not.toContain("Bearer");
    expect(r.stdout.trimStart().startsWith("{")).toBe(false);

    const recalls = captured.filter(c => c.url.startsWith("/recall?"));
    expect(recalls.length).toBeGreaterThanOrEqual(1);
    const url = new URL(`http://x${recalls[0].url}`);
    expect(url.searchParams.get("query")).toBeTruthy();
    expect(url.searchParams.get("workspace")).toBe("personal");
    for (const c of recalls) {
      const res = await replay(c);
      expect(res.status, c.url).toBe(200);
      expect((await res.json() as any).ok).toBe(true);
    }
  });

  it("falls back from the tag arm to free text when the tag arm is empty", async () => {
    behaviour.recallResults = [];
    await runHook("session-start.js", startPayload());
    const recalls = captured.filter(c => c.url.startsWith("/recall?"));
    expect(recalls).toHaveLength(2);
    expect(new URL(`http://x${recalls[0].url}`).searchParams.get("tag")).toBeTruthy();
    expect(new URL(`http://x${recalls[1].url}`).searchParams.get("tag")).toBeNull();
  });

  it("surfaces a rejected token: stderr line and exit 1 (the #327 failure mode, made visible)", async () => {
    behaviour.recallStatus = 401;
    const r = await runHook("session-start.js", startPayload());
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[Second Brain\] recall failed: HTTP 401 unauthorized/);
  });

  it("skips resume and fork, runs on compact", async () => {
    expect((await runHook("session-start.js", startPayload("resume"))).stdout).toBe("");
    expect((await runHook("session-start.js", startPayload("fork"))).stdout).toBe("");
    expect(captured).toHaveLength(0);
    expect((await runHook("session-start.js", startPayload("compact"))).stdout).toContain("Context recalled");
  });

  it("does nothing without credentials, and honours the opt-out", async () => {
    const r = await runHook("session-start.js", startPayload(), { SECOND_BRAIN_URL: "", SECOND_BRAIN_TOKEN: "" });
    expect(r.code).toBe(0); expect(r.stdout).toBe(""); expect(captured).toHaveLength(0);
    await runHook("session-start.js", startPayload(), { SECOND_BRAIN_HOOK_RECALL: "0" });
    expect(captured).toHaveLength(0);
  });
});

describe("session-end.js", () => {
  it("reads transcript_path and makes one POST /capture the Worker accepts", async () => {
    const transcript = join(scratch, "fx.jsonl");
    copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript));
    expect(r.code, r.stderr).toBe(0);

    const captures = captured.filter(c => c.url === "/capture");
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0].body);
    expect(body).toMatchObject({ source: "claude-code", workspace: "personal" });
    expect(body.content).toContain("nightly digest");
    expect(body.content).toContain("Final: budget-capped digest merged");
    for (const banned of ["SECRET_TOKEN", "private reasoning", "sidechain", "<system-reminder>", "<task-notification>"]) {
      expect(body.content, banned).not.toContain(banned);
    }
    expect(body.content.length).toBeLessThanOrEqual(2000);

    const res = await replay(captures[0]);
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });

  it("does not capture a transcript with no human text", async () => {
    const transcript = join(scratch, "tools.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(500) }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    ].join("\n") + "\n");
    const r = await runHook("session-end.js", endPayload(transcript));
    expect(r.code).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("does not capture against a Worker older than 3.0, and says so once", async () => {
    behaviour.healthVersion = "2.4.0";
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    const first = await runHook("session-end.js", endPayload(transcript));
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("needs Worker 3.0+");
    const second = await runHook("session-end.js", endPayload(transcript));
    expect(second.code).toBe(0);           // notice is once per 24 h
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("ignores the legacy stdin shape instead of guessing", async () => {
    const r = await runHook("session-end.js", { messages: [{ role: "user", content: "x".repeat(300) }] });
    expect(r.code).toBe(0);
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });

  it("reports a failed capture: stderr line and exit 1", async () => {
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    // Point at a closed port so the POST fails at the network layer.
    const r = await runHook("session-end.js", endPayload(transcript), { SECOND_BRAIN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^\[Second Brain\] session capture failed:/);
  });

  it("still exits within its own timeout when the Worker is slow", async () => {
    behaviour.delayMs = 1500;
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    const t0 = Date.now();
    const r = await runHook("session-end.js", endPayload(transcript));
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 30000);

  it("dry run prints the body and sends nothing", async () => {
    const transcript = join(scratch, "fx.jsonl"); copyFileSync(FIXTURE, transcript);
    const r = await runHook("session-end.js", endPayload(transcript), { SECOND_BRAIN_DRY_RUN: "1" });
    expect(JSON.parse(r.stdout)).toMatchObject({ source: "claude-code" });
    expect(captured.filter(c => c.url === "/capture")).toHaveLength(0);
  });
});
