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
 * Why a request failed to authenticate, for a client that has to say something
 * useful about it. `invalid_token` is the only one a caller who is not already
 * holding a real token can ever see — see classifyAuthFailure.
 */
export type AuthFailureCode = "invalid_token" | "suspended" | "removed";

/**
 * `invalid_token` keeps the exact string it has always had. Two suites assert it
 * verbatim (test/integration/auth.test.ts, test/ui/team-panel.test.ts) and,
 * more to the point, it is the answer every unauthenticated caller gets — it
 * must stay as uninformative as it was.
 */
const AUTH_FAILURE_MESSAGE: Record<AuthFailureCode, string> = {
  invalid_token: "Unauthorized",
  suspended: "Your account is suspended. Ask a team admin to restore it.",
  removed: "Your account has been removed from this team.",
};

const CLASSIFY_FAILURE_SQL = `SELECT suspended, removed_at FROM users WHERE token_hash = ?`;
const CLASSIFY_FAILURE_BY_ID_SQL = `SELECT suspended, removed_at FROM users WHERE id = ?`;

/** Removal beats suspension; a row with neither flag failed for some other reason. */
function codeForRow(row: { suspended: number | null; removed_at: number | null } | null): AuthFailureCode {
  if (!row) return "invalid_token";
  // Removal is checked first: removeMember does not clear `suspended`, so a
  // member an admin suspended and then removed carries both flags, and removal
  // is the more final of the two facts.
  if (Number(row.removed_at) > 0) return "removed";
  if (row.suspended) return "suspended";
  // Neither flag set — the identity failed for some other reason (no personal
  // workspace membership, say). Nothing actionable to report.
  return "invalid_token";
}

/**
 * Distinguish "your access was revoked" from "that is not a token", WITHOUT
 * turning the endpoint into an account-existence oracle.
 *
 * The whole property rests on the lookup key: this selects on `token_hash`, the
 * SHA-256 of the token the caller actually presented. Nobody can produce a hash
 * that collides with a member's token without holding that member's token, so a
 * caller who guessed wrong finds no row and is told `invalid_token` — bit for
 * bit the answer they got before this function existed. There is no id, name or
 * email predicate here, and there must never be one: any lookup by a value an
 * attacker can enumerate would leak exactly what this is careful not to.
 *
 * Runs on the failure path only. The happy path resolves through IDENTITY_SQL
 * and never reaches here, so authenticating still costs one query.
 */
async function classifyAuthFailure(token: string, env: Env): Promise<AuthFailureCode> {
  if (!token) return "invalid_token";
  const row = await env.DB.prepare(CLASSIFY_FAILURE_SQL)
    .bind(await hashToken(token))
    .first<{ suspended: number | null; removed_at: number | null }>();
  return codeForRow(row);
}

/**
 * The same classification for the MCP OAuth-grant path, where there is no bearer
 * token in `users` to hash — the credential is the provider's own access token
 * and the user id arrives out of the grant.
 *
 * Looking a user up by id is safe HERE and nowhere else: `userId` is not
 * caller-supplied. @cloudflare/workers-oauth-provider sets it from a grant it
 * has already decrypted out of KV, so reaching this line means the caller
 * already holds a valid grant for that exact user. It is never reachable from a
 * guessed id, which is why classifyAuthFailure above must keep hashing instead.
 */
async function classifyAuthFailureByUserId(userId: string, env: Env): Promise<AuthFailureCode> {
  if (!userId) return "invalid_token";
  const row = await env.DB.prepare(CLASSIFY_FAILURE_BY_ID_SQL)
    .bind(userId)
    .first<{ suspended: number | null; removed_at: number | null }>();
  return codeForRow(row);
}

/**
 * The 401 body every auth guard in this file returns. Shared so the three
 * surfaces (REST, MCP, and the legacy AUTH_TOKEN guard in http.ts) cannot drift
 * into different shapes.
 */
function authFailureResponse(code: AuthFailureCode): Response {
  return json({ ok: false, error: AUTH_FAILURE_MESSAGE[code], code }, 401);
}

/** Classify the request's bearer token, skipping the query when there is none. */
async function unauthorized(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  return authFailureResponse(token ? await classifyAuthFailure(token, env) : "invalid_token");
}

/**
 * The requireAuth twin: resolves identity or returns the 401 Response to send back.
 * Used as `const auth = await requireIdentity(req, env); if (auth instanceof Response) return auth;`
 */
export async function requireIdentity(request: Request, env: Env): Promise<Identity | Response> {
  const identity = await resolveIdentity(request, env);
  if (identity) return identity;
  return unauthorized(request, env);
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
  // Bearer first, matching the resolve order above: a member signing in with the
  // token an admin issued them is classified by hashing it, exactly as REST does.
  const token = extractToken(request);
  if (token) {
    const code = await classifyAuthFailure(token, env);
    if (code !== "invalid_token") return authFailureResponse(code);
  }
  // Then the grant. A browser-OAuth client's access token is the provider's own
  // opaque form and is not in `users`, so the hash above finds nothing and this
  // is the only thing that can tell a suspended member why their MCP client
  // stopped working.
  if (oauthUserId) return authFailureResponse(await classifyAuthFailureByUserId(oauthUserId, env));
  return authFailureResponse("invalid_token");
}
