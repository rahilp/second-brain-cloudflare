import type { Env } from "../env";
import { hashToken } from "./identity";

/**
 * Team member administration. Every function here is called from behind
 * requireAdmin (src/routes/admin.ts) — none of them re-check roles, by the same
 * convention that keeps the rest of the admin surface single-gated.
 *
 * Tokens are generated server-side and shown exactly once: like AUTH_TOKEN,
 * only the SHA-256 lands in D1, so a leaked list of rows can never sign anyone
 * in. Suspension is soft offboarding — entries stay put so nothing is lost,
 * the identity simply stops resolving (users.suspended = 1 in IDENTITY_SQL).
 */

export interface TeamMember {
  userId: string;
  name: string;
  email: string | null;
  role: "admin" | "member";
  suspended: boolean;
  createdAt: number;
  personalWorkspaceId: string;
  /** Entries living in the member's personal workspace. */
  privateEntries: number;
  /** Capture-visibility override: "personal", "company", or "" (inherit org default). */
  defaultShare: "personal" | "company" | "";
}

export async function generateToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url: safe in URLs, shell arguments and JSON without escaping.
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { token, tokenHash: await hashToken(token) };
}

export async function listMembers(env: Env): Promise<TeamMember[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id AS userId, u.name, u.email, u.role, u.suspended, u.created_at AS createdAt,
            u.default_share AS defaultShare,
            w.id AS personalWorkspaceId,
            (SELECT COUNT(*) FROM entries e WHERE e.workspace_id = w.id) AS privateEntries
     FROM users u
     JOIN memberships m ON m.user_id = u.id
     JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal'
     WHERE u.removed_at IS NULL OR u.removed_at = 0
     ORDER BY u.created_at ASC, u.id ASC`
  ).all<TeamMember & { defaultShare: string | null }>();
  return (results ?? []).map((r) => ({
    ...r,
    suspended: !!r.suspended,
    defaultShare: r.defaultShare === "company" ? "company" : r.defaultShare === "personal" ? "personal" : "",
  }));
}

export class TeamAdminError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function createMember(
  env: Env,
  input: { name?: string; email?: string | null; role?: "admin" | "member" },
): Promise<{ member: TeamMember; token: string }> {
  const name = input.name?.trim() || "Member";
  const role = input.role === "admin" ? "admin" : "member";
  const email = input.email?.trim() || null;

  if (email) {
    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
    if (existing) throw new TeamAdminError(409, `A member with that email already exists`);
  }

  const now = Date.now();
  const userId = `usr-${crypto.randomUUID()}`;
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const companyId = await env.DB.prepare(
    `SELECT id FROM workspaces WHERE kind = 'company' ORDER BY created_at LIMIT 1`,
  ).first<{ id: string }>();
  if (!companyId) throw new TeamAdminError(500, "Deployment is not provisioned");

  const { token, tokenHash } = await generateToken();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).bind(userId, name, email, role, tokenHash, now),
    env.DB.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', ?, ?)`).bind(workspaceId, name, now),
    env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(userId, workspaceId, now),
    env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(userId, companyId.id, now),
  ]);

  return {
    member: {
      userId, name, email, role, suspended: false, createdAt: now,
      personalWorkspaceId: workspaceId, privateEntries: 0, defaultShare: "",
    },
    token,
  };
}

/** Rotates a member's token; the previous one stops resolving immediately. */
export async function rotateMemberToken(env: Env, userId: string): Promise<string> {
  const { token, tokenHash } = await generateToken();
  const result = await env.DB.prepare(`UPDATE users SET token_hash = ? WHERE id = ?`)
    .bind(tokenHash, userId).run();
  // D1 reports meta.changes; the real-SQLite test facade reports rows_written.
  const changed = (result.meta as Record<string, number>).changes
    ?? (result.meta as Record<string, number>).rows_written ?? 0;
  if (!changed) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
  return token;
}

export async function setMemberSuspended(env: Env, actorId: string, userId: string, suspended: boolean): Promise<void> {
  if (userId === actorId && suspended) {
    throw new TeamAdminError(400, "You cannot suspend your own account");
  }
  if (suspended) {
    // Guardrail against locking the deployment out: at least one active admin
    // must remain after this suspension.
    const admins = await env.DB.prepare(
      `SELECT id FROM users WHERE role = 'admin' AND suspended = 0 AND (removed_at IS NULL OR removed_at = 0) AND id != ?`,
    ).bind(userId).all<{ id: string }>();
    const target = await env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(userId).first<{ role: string }>();
    if (!target) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
    if (target.role === "admin" && !(admins.results ?? []).length) {
      throw new TeamAdminError(400, "Cannot suspend the last active admin");
    }
  }
  const result = await env.DB.prepare(`UPDATE users SET suspended = ? WHERE id = ?`)
    .bind(suspended ? 1 : 0, userId).run();
  const changed = (result.meta as Record<string, number>).changes
    ?? (result.meta as Record<string, number>).rows_written ?? 0;
  if (!changed) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
}

/**
 * Sets one member's capture-visibility override. "inherit" clears it, falling
 * back to the org's TEAM_DEFAULT_WORKSPACE config. Existing rows are untouched:
 * this governs where NEW captures land.
 */
export async function setMemberDefaultShare(
  env: Env,
  userId: string,
  value: "personal" | "company" | "inherit",
): Promise<void> {
  const stored = value === "inherit" ? "" : value;
  const result = await env.DB.prepare(`UPDATE users SET default_share = ? WHERE id = ?`)
    .bind(stored, userId).run();
  const changed = (result.meta as Record<string, number>).changes
    ?? (result.meta as Record<string, number>).rows_written ?? 0;
  if (!changed) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
}

/**
 * Soft offboarding: marks the member removed, deletes their personal workspace
 * and everything in it. Company-layer entries they authored STAY — they are the
 * team's shared memory now, and actor_id remains as history. The caller (route
 * layer) owns the confirmation UX; this function owns the guardrails:
 *   - you cannot remove yourself (suspending yourself is already blocked, and
 *     removal is strictly more final);
 *   - the last active admin cannot be removed.
 * Vectors for removed entries are returned so the caller can drop them from
 * Vectorize the same way forget does.
 */
export async function removeMember(
  env: Env,
  actorId: string,
  userId: string,
): Promise<{ removedEntries: number; vectorIds: string[] }> {
  if (userId === actorId) {
    throw new TeamAdminError(400, "You cannot remove your own account");
  }
  const target = await env.DB.prepare(
    `SELECT role FROM users WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(userId).first<{ role: string }>();
  if (!target) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
  if (target.role === "admin") {
    const otherAdmins = await env.DB.prepare(
      `SELECT id FROM users WHERE role = 'admin' AND suspended = 0 AND (removed_at IS NULL OR removed_at = 0) AND id != ?`,
    ).bind(userId).all<{ id: string }>();
    if (!(otherAdmins.results ?? []).length) {
      throw new TeamAdminError(400, "Cannot remove the last active admin");
    }
  }

  const personal = await env.DB.prepare(
    `SELECT w.id AS wid FROM memberships m JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal' WHERE m.user_id = ?`,
  ).bind(userId).first<{ wid: string }>();
  if (!personal) throw new TeamAdminError(404, "Member has no personal workspace");

  // Collect the doomed rows' vectors first: D1 rows go in one batch, the
  // Vectorize delete is the caller's (it may be absent entirely).
  const { results: vectorRows } = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE workspace_id = ? AND vector_ids != '[]'`,
  ).bind(personal.wid).all<{ vector_ids: string }>();
  const vectorIds = (vectorRows ?? []).flatMap((r) => {
    try { return JSON.parse(r.vector_ids) as string[]; } catch { return []; }
  });

  const { results: counts } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM entries WHERE workspace_id = ?`,
  ).bind(personal.wid).all<{ n: number }>();
  const removedEntries = counts?.[0]?.n ?? 0;

  const now = Date.now();
  await env.DB.batch([
    // Edges before entries: the edge delete resolves endpoints through the
    // entries table, so it has to run while the rows still exist.
    env.DB.prepare(
      `DELETE FROM edges WHERE source_id IN (SELECT id FROM entries WHERE workspace_id = ?) OR target_id IN (SELECT id FROM entries WHERE workspace_id = ?)`,
    ).bind(personal.wid, personal.wid),
    env.DB.prepare(`DELETE FROM entries WHERE workspace_id = ?`).bind(personal.wid),
    env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(personal.wid),
    env.DB.prepare(`UPDATE users SET removed_at = ? WHERE id = ?`).bind(now, userId),
  ]);

  return { removedEntries, vectorIds };
}

/** Rename a member. At least one of name or email must be supplied. */
export async function setMemberProfile(
  env: Env,
  userId: string,
  input: { name?: string; email?: string | null },
): Promise<void> {
  const name = input.name?.trim();
  const email = input.email === undefined ? undefined : (input.email?.trim() || null);
  if (name === undefined && email === undefined) {
    throw new TeamAdminError(400, "name or email is required");
  }
  if (email) {
    const existing = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ? AND id != ? AND (removed_at IS NULL OR removed_at = 0)`,
    ).bind(email, userId).first();
    if (existing) throw new TeamAdminError(409, "A member with that email already exists");
  }

  const sets: string[] = [];
  const bindings: (string | null)[] = [];
  if (name !== undefined) { sets.push("name = ?"); bindings.push(name || "Member"); }
  if (email !== undefined) { sets.push("email = ?"); bindings.push(email); }
  bindings.push(userId);

  const result = await env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(...bindings).run();
  const changed = (result.meta as Record<string, number>).changes
    ?? (result.meta as Record<string, number>).rows_written ?? 0;
  if (!changed) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
}
