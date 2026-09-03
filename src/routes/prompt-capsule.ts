import type { Env } from "../env";
import { CORS_HEADERS, json, readWorkspaceParam } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { buildPromptCapsule } from "../prompt-capsule/build";
import { ifNoneMatchMatches } from "../prompt-capsule/etag";
import {
  PROMPT_CAPSULE_MIME,
} from "../prompt-capsule/types";

const CORE_PATH = "/prompt-capsules/core";
const PROJECT_PATH_PREFIX = "/prompt-capsules/projects/";
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type CapsuleTarget = { kind: "core" } | { kind: "project"; projectId: string };

function parseTarget(pathname: string): CapsuleTarget | null | "invalid-project-id" {
  if (pathname === CORE_PATH) return { kind: "core" };
  if (!pathname.startsWith(PROJECT_PATH_PREFIX)) return null;
  const encoded = pathname.slice(PROJECT_PATH_PREFIX.length);
  if (!encoded || encoded.includes("/")) return "invalid-project-id";
  let projectId: string;
  try {
    projectId = decodeURIComponent(encoded);
  } catch {
    return "invalid-project-id";
  }
  return PROJECT_ID.test(projectId) ? { kind: "project", projectId } : "invalid-project-id";
}

function methodNotAllowed(): Response {
  const response = json({ ok: false, error: "Use GET or HEAD for prompt capsules" }, 405);
  response.headers.set("Allow", "GET, HEAD");
  return response;
}

function withoutHeadBody(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function successHeaders(etag: string): Headers {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", PROMPT_CAPSULE_MIME);
  headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  headers.set("ETag", etag);
  headers.set("Vary", "Authorization");
  headers.set("Access-Control-Expose-Headers", "ETag");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export async function handlePromptCapsuleRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const target = parseTarget(url.pathname);
  if (target === null) return null;
  if (target === "invalid-project-id") {
    return withoutHeadBody(request, json({
      ok: false,
      error: "project id must be a lowercase opaque id containing only a-z, 0-9, _ or - (maximum 64 characters)",
    }, 400));
  }
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();

  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return withoutHeadBody(request, auth);

  const workspaceRead = readWorkspaceParam(url);
  if (workspaceRead instanceof Response) return withoutHeadBody(request, workspaceRead);
  // A capsule is a reusable prompt prefix, so the privacy-safe default is one
  // private workspace, never the caller's personal + every shared team union.
  const workspace = workspaceRead ?? "personal";
  const built = await buildPromptCapsule(env, auth, {
    kind: target.kind,
    projectId: target.kind === "project" ? target.projectId : undefined,
    workspace,
    team: url.searchParams.has("team") ? url.searchParams.get("team")! : undefined,
  });
  if (!built.ok) return withoutHeadBody(request, json(built.body, built.status));
  const headers = successHeaders(built.etag);

  if (ifNoneMatchMatches(request.headers.get("If-None-Match"), built.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : built.bodyText, { status: 200, headers });
}
