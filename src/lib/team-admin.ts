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
            w.id AS personalWorkspaceId,
            (SELECT COUNT(*) FROM entries e WHERE e.workspace_id = w.id) AS privateEntries
     FROM users u
     JOIN memberships m ON m.user_id = u.id
     JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal'
     ORDER BY u.created_at ASC`
  ).all<TeamMember>();
  return (results ?? []).map((r) => ({ ...r, suspended: !!r.suspended }));
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
      personalWorkspaceId: workspaceId, privateEntries: 0,
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
      `SELECT id FROM users WHERE role = 'admin' AND suspended = 0 AND id != ?`,
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
