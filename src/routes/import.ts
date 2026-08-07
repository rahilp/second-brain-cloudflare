/**
 * Bulk import surface (#217) — cursor-based counterpart to GET /export.
 *
 * Authenticated with AUTH_TOKEN. One call = one page; the client supplies the
 * page number. See src/entries/import-job.ts for the ledger and KV staging.
 */
import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import {
  ImportJobError,
  appendPage,
  readStatus,
  resetJob,
  runPage,
  startJob,
} from "../entries/import-job";

function jobErrorResponse(e: unknown): Response {
  if (e instanceof ImportJobError) {
    return json({ ok: false, error: e.message, code: e.code }, e.httpStatus);
  }
  throw e;
}

export async function handleImportRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/import/start" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON", code: "invalid_body" }, 400); }
    try {
      return json(await startJob(env, body));
    } catch (e) {
      return jobErrorResponse(e);
    }
  }

  if (url.pathname === "/import/append" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON", code: "invalid_body" }, 400); }
    try {
      return json(await appendPage(env, body));
    } catch (e) {
      return jobErrorResponse(e);
    }
  }

  if (url.pathname === "/import/continue" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON", code: "invalid_body" }, 400); }
    try {
      return json(await runPage(env, body));
    } catch (e) {
      return jobErrorResponse(e);
    }
  }

  if (url.pathname === "/import/status" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const jobId = url.searchParams.get("job_id")?.trim();
    if (!jobId) return json({ ok: false, error: "job_id is required", code: "invalid_body" }, 400);
    try {
      return json(await readStatus(env, jobId));
    } catch (e) {
      return jobErrorResponse(e);
    }
  }

  if (url.pathname === "/import/reset" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON", code: "invalid_body" }, 400); }
    try {
      return json(await resetJob(env, body));
    } catch (e) {
      return jobErrorResponse(e);
    }
  }

  return null;
}
