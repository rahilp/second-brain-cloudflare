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
  /**
   * Every company workspace this user belongs to, oldest first.
   *
   * Plural because `memberships` has always been a many-to-many join and the
   * schema never said one: a second company workspace, or a member in two of
   * them, is a row, not a migration. It was read as a singular through a JOIN
   * that returns one row per membership and a `.first()` that took whichever
   * came back — so a member of two teams would silently have been scoped to an
   * arbitrary one. Reads union the whole list; the write path picks one
   * deliberately (see primaryCompanyWorkspaceId).
   *
   * The dashboard exposes a single team today. Nothing below depends on that.
   */
  companyWorkspaceIds: string[];
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

/**
 * The company memberships are aggregated rather than joined one-to-one: the old
 * shape returned one row per company workspace and `.first()` picked one, which
 * is correct only while there is exactly one. GROUP_CONCAT keeps it a single
 * statement — no extra subrequest on a path every request takes — and each id is
 * paired with its created_at so the list can be ordered oldest-first in JS
 * (SQLite does not promise GROUP_CONCAT's order).
 *
 * The company join is LEFT: membership of a team is not what authenticates a
 * user. The personal join is what does, and it stays INNER.
 */
const COMPANY_WORKSPACES_SELECT =
  `GROUP_CONCAT(DISTINCT c.id || '@' || c.created_at) AS companyWorkspaces`;

const IDENTITY_FROM =
  ` FROM users u` +
  ` JOIN memberships mp ON mp.user_id = u.id` +
  ` JOIN workspaces p ON p.id = mp.workspace_id AND p.kind = 'personal'` +
  ` LEFT JOIN memberships mc ON mc.user_id = u.id` +
  ` LEFT JOIN workspaces c ON c.id = mc.workspace_id AND c.kind = 'company'`;

const IDENTITY_SQL =
  `SELECT u.id AS userId, u.role AS role, u.default_share AS defaultShare,` +
  ` p.id AS personalWorkspaceId, ${COMPANY_WORKSPACES_SELECT}` +
  IDENTITY_FROM +
  ` WHERE u.token_hash = ? AND u.suspended = 0 AND (u.removed_at IS NULL OR u.removed_at = 0)` +
  ` GROUP BY u.id`;

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
const IDENTITY_BY_ID_SQL =
  `SELECT u.id AS userId, u.role AS role, u.default_share AS defaultShare,` +
  ` p.id AS personalWorkspaceId, ${COMPANY_WORKSPACES_SELECT}` +
  IDENTITY_FROM +
  ` WHERE u.id = ? AND u.suspended = 0 AND (u.removed_at IS NULL OR u.removed_at = 0)` +
  ` GROUP BY u.id`;

/**
 * `GROUP_CONCAT(DISTINCT c.id || '@' || c.created_at)` → ids, oldest first.
 *
 * NULL when the user belongs to no company workspace (the LEFT join found
 * nothing), which is an empty list rather than an error: a member with only a
 * personal workspace is a legal state once teams are plural, and every read path
 * below already handles a shorter readable set.
 */
function parseCompanyWorkspaces(packed: string | null | undefined): string[] {
  if (!packed) return [];
  return packed
    .split(",")
    .map((part) => {
      const at = part.lastIndexOf("@");
      // Ids are `ws-<uuid>` and carry no "@", so the last one is always the
      // separator this query added.
      return at === -1
        ? { id: part, createdAt: 0 }
        : { id: part.slice(0, at), createdAt: Number(part.slice(at + 1)) || 0 };
    })
    .filter((w) => w.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((w) => w.id);
}

function rowToIdentity(row: {
  userId: string;
  role: string;
  defaultShare: string | null;
  personalWorkspaceId: string;
  companyWorkspaces?: string | null;
}): Identity {
  return {
    userId: row.userId,
    role: row.role === "admin" ? "admin" : "member",
    personalWorkspaceId: row.personalWorkspaceId,
    companyWorkspaceIds: parseCompanyWorkspaces(row.companyWorkspaces),
    defaultShare: row.defaultShare === "company" ? "company" : row.defaultShare === "personal" ? "personal" : "",
  };
}

async function ensureIdentityReady(env: Env): Promise<void> {
  const { initializeDatabase } = await import("../db/init");
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
}

/** Resolve identity from a bearer token string (no Request wrapper). */
export async function resolveIdentityFromToken(token: string, env: Env): Promise<Identity | null> {
  if (!token) return null;
  await ensureIdentityReady(env);
  const row = await env.DB.prepare(IDENTITY_SQL)
    .bind(await hashToken(token))
    .first<{ userId: string; role: string; defaultShare: string | null; personalWorkspaceId: string; companyWorkspaces: string | null }>();
  if (!row) return null;
  return rowToIdentity(row);
}

/**
 * Resolve a user id to a full Identity. Maps the OAuth legacy sentinel "owner"
 * to the bootstrap admin row so browser OAuth grants keep working after P1b.
 */
export async function resolveIdentityByUserId(env: Env, userId: string): Promise<Identity | null> {
  if (!userId) return null;
  await ensureIdentityReady(env);
  let id = userId;
  if (userId === "owner") {
    const roots = await ensureTenantBootstrap(env);
    id = roots.ownerUserId;
  }
  const row = await env.DB.prepare(IDENTITY_BY_ID_SQL)
    .bind(id)
    .first<{ userId: string; role: string; defaultShare: string | null; personalWorkspaceId: string; companyWorkspaces: string | null }>();
  if (!row) return null;
  return rowToIdentity(row);
}

export async function resolveIdentity(request: Request, env: Env): Promise<Identity | null> {
  const token = extractToken(request);
  if (!token) return null;
  return resolveIdentityFromToken(token, env);
}

/**
 * MCP/OAuth edge resolver: bearer hash first, then OAuth grant props when the
 * access token is the provider's internal 3-part form (not stored in users).
 */
export async function resolveIdentityForRequest(
  request: Request,
  env: Env,
  oauthUserId?: string,
): Promise<Identity | Response | null> {
  const fromToken = await resolveIdentity(request, env);
  if (fromToken) return fromToken;
  if (oauthUserId) {
    const fromGrant = await resolveIdentityByUserId(env, oauthUserId);
    if (fromGrant) return fromGrant;
  }
  return null;
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

/**
 * requireIdentity's twin for surfaces that administer the deployment rather than
 * serve one member: team administration, the cross-workspace repair counts in
 * /stats, the bulk backfills behind /vectorize-pending and /classify-pending, and
 * the integration connections, which are one blob per provider for the whole
 * brain. A signed-in member gets 403 rather than the data.
 *
 * It is a gate, not a scope. Routes behind it that return memory CONTENT still
 * scope to the caller's readable set — "admin" has never meant permission to read
 * a member's personal workspace anywhere else in this codebase, and the review
 * queues that once did are why that is worth saying twice.
 */
export async function requireAdmin(request: Request, env: Env): Promise<Identity | Response> {
  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  if (auth.role !== "admin") return json({ ok: false, error: "Forbidden" }, 403);
  return auth;
}

/** MCP handler twin: also accepts OAuth grant props when the bearer is not in users. */
export async function requireIdentityForMcp(
  request: Request,
  env: Env,
  oauthUserId?: string,
): Promise<Identity | Response> {
  const identity = await resolveIdentityForRequest(request, env, oauthUserId);
  if (identity && !(identity instanceof Response)) return identity;
  return json({ ok: false, error: "Unauthorized" }, 401);
}
