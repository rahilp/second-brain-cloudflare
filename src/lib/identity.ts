import type { Env } from "../env";
import { json } from "./http";
import { ensureTenantBootstrap } from "./tenancy";

/**
 * Who is making this request, resolved once at the edge and threaded through the
 * domain as a plain value. Domain modules receive an Identity (or the workspace ids
 * derived from one) — they never read headers or env auth state, which keeps the
 * pure/infra/domain layering of src/ARCHITECTURE.md intact.
 *
 * Readable set: the caller's personal workspace plus the shared company workspace.
 * There is no other visibility dimension in v3 — no per-entry ACLs.
 */
export interface Identity {
  userId: string;
  role: "admin" | "member";
  personalWorkspaceId: string;
  companyWorkspaceId: string;
  /**
   * The member's capture-visibility override: "personal", "company", or ""
   * (inherit the org-level TEAM_DEFAULT_WORKSPACE config). Resolved with the
   * identity so the write path never needs a second lookup.
   */
  defaultShare: "personal" | "company" | "";
}

/**
 * SHA-256 hex of a bearer token. Tokens themselves are never stored — the same
 * property Cloudflare's write-only secret binding gives AUTH_TOKEN today.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bearer header first, then the ?token= query form the personal brain has always accepted. */
export function extractToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim() || null;
  const query = new URL(request.url).searchParams.get("token");
  return query && query.length > 0 ? query : null;
}

const IDENTITY_SQL =
  `SELECT u.id AS userId, u.role AS role, u.default_share AS defaultShare,` +
  ` p.id AS personalWorkspaceId, c.id AS companyWorkspaceId` +
  ` FROM users u` +
  ` JOIN memberships mp ON mp.user_id = u.id` +
  ` JOIN workspaces p ON p.id = mp.workspace_id AND p.kind = 'personal'` +
  ` JOIN memberships mc ON mc.user_id = u.id` +
  ` JOIN workspaces c ON c.id = mc.workspace_id AND c.kind = 'company'` +
  ` WHERE u.token_hash = ? AND u.suspended = 0`;

/**
 * Resolve the caller's identity from their token, bootstrapping the tenancy rows
 * on first contact with a v3 database. Returns null for anonymous/unknown callers
 * — callers decide whether that is a 401 (requireIdentity below) or tolerable.
 *
 * Awaits initializeDatabase rather than trusting ensureDbReady's fire-and-forget
 * waitUntil: identity queries hit tables that did not exist before v3, so on the
 * very first request against a freshly created database the schema must actually
 * be there, not merely scheduled. The memo makes the await free after first use.
 */
export async function resolveIdentity(request: Request, env: Env): Promise<Identity | null> {
  const token = extractToken(request);
  if (!token) return null;
  const { initializeDatabase } = await import("../db/init");
  await initializeDatabase(env);
  // Idempotent and memoised per isolate; on every request after the first this is
  // two cheap reads (one marker probe, one join).
  await ensureTenantBootstrap(env);
  const row = await env.DB.prepare(IDENTITY_SQL)
    .bind(await hashToken(token))
    .first<{ userId: string; role: string; defaultShare: string | null; personalWorkspaceId: string; companyWorkspaceId: string }>();
  if (!row) return null;
  return {
    userId: row.userId,
    role: row.role === "admin" ? "admin" : "member",
    personalWorkspaceId: row.personalWorkspaceId,
    companyWorkspaceId: row.companyWorkspaceId,
    // Rows written before the column existed read NULL — same legacy tolerance
    // as every runtime-ALTER column.
    defaultShare: row.defaultShare === "company" ? "company" : row.defaultShare === "personal" ? "personal" : "",
  };
}

/**
 * The requireAuth twin: resolves identity or returns the 401 Response to send back.
 * Used as `const auth = await requireIdentity(req, env); if (auth instanceof Response) return auth;`
 */
export async function requireIdentity(request: Request, env: Env): Promise<Identity | Response> {
  const identity = await resolveIdentity(request, env);
  if (identity) return identity;
  return json({ ok: false, error: "Unauthorized" }, 401);
}
