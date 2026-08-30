import type { Env } from "../env";
import { resolveConfig } from "../config";
import { hashToken } from "./identity";
import { D1_MAX_BOUND_PARAMS } from "../constants";

/** Team membership, workspace, and offboarding operations. */

export interface TeamMember {
  userId: string;
  name: string;
  email: string | null;
  role: "admin" | "member";
  suspended: boolean;
  createdAt: number;
  /**
   * Last successful identity resolution for this member's token, or null for a
   * member who has not authenticated since the column shipped. Up to an hour
   * stale by design — see LAST_USED_THROTTLE_MS in src/lib/identity.ts.
   */
  lastUsedAt: number | null;
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

/** Count active and suspended users; suspension does not remove team membership. */
export async function countActiveMembers(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    // scope-exempt: deployment-wide headcount, with no content exposed
    `SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL OR removed_at = 0`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Resolve team mode from the stored intent and current membership count. */
export function resolveTeamFlag(mode: string, activeMembers: number): boolean {
  if (mode === "on") return true;
  if (mode === "off") return activeMembers > 1;
  return activeMembers > 1;
}

/** Return the effective team-mode flag published by GET /health. */
export async function isTeamBrain(env: Env): Promise<boolean> {
  const config = await resolveConfig(env);
  if (config.TEAM_MODE === "on") return true;
  return resolveTeamFlag(config.TEAM_MODE, await countActiveMembers(env));
}

export async function listMembers(env: Env): Promise<TeamMember[]> {
  const { results } = await env.DB.prepare(
    // scope-exempt: admin member list: the subselect counts rows in each member's OWN workspace (e.workspace_id = w.id) and yields a number, never content
    `SELECT u.id AS userId, u.name, u.email, u.role, u.suspended, u.created_at AS createdAt,
            u.default_share AS defaultShare, u.last_used_at AS lastUsedAt,
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
    // SQLite hands NULL back as null already; the coalesce is for D1's own
    // undefined-for-absent-column behaviour on a brain mid-migration.
    lastUsedAt: r.lastUsedAt ?? null,
    defaultShare: r.defaultShare === "company" ? "company" : r.defaultShare === "personal" ? "personal" : "",
  }));
}

/**
 * One person as a PEER may see them. Three fields, and the type is the
 * allowlist: everything on TeamMember above that is missing here is missing
 * deliberately.
 *   - `email`, `createdAt` and `lastUsedAt` are personal data about a colleague.
 *   - `privateEntries` counts rows in a workspace the caller cannot read, and a
 *     count is still a fact about someone's private memory.
 *   - `personalWorkspaceId` is a scoping key, so publishing it hands every
 *     member the identifier every other member's rows are keyed by.
 *   - `defaultShare` is a policy no peer has a say over.
 *   - `suspended` is an employment fact; see listRoster's WHERE.
 * `userId` stays because the client needs a stable key to mark "you".
 */
export interface RosterMember {
  userId: string;
  name: string;
  role: "admin" | "member";
}

/**
 * The people in the caller's own teams: names and roles, nothing else.
 *
 * The member-facing twin of listMembers. Two things make it safe to hand to a
 * non-admin, and both are properties of the query rather than of the caller:
 *
 * 1. The columns are named POSITIVELY. It is a three-column SELECT, not
 *    `u.*` with fields deleted afterwards — so a column added to `users`
 *    tomorrow (the next `lastUsedAt`) cannot appear here by default. Widening
 *    this list has to be a deliberate edit to this line, which is what
 *    test/integration/team-roster.test.ts's exhaustive key assertion pins.
 * 2. The set of PEOPLE is scoped through `memberships` to the workspace ids on
 *    the caller's resolved identity — never a bare `FROM users`. Constraint 1
 *    applies to people as much as to memories: on a deployment with two company
 *    workspaces, this join is the thing that stops one team's roster reaching
 *    the other.
 *
 * Suspended members are omitted rather than flagged. A suspended member cannot
 * authenticate, so they are not someone you can share with; and publishing the
 * flag would publish an employment fact only an admin has business knowing.
 * Admins keep the full picture — suspension included — through GET /team/members.
 *
 * DISTINCT because a colleague in two of the caller's teams is two membership
 * rows and one person.
 *
 * COLLATE NOCASE on the sort because SQLite's default BINARY collation orders
 * every uppercase letter before every lowercase one, so "alice" would come
 * after "Zoe" and a team with mixed-case names would read as unsorted. `u.id`
 * stays as the tiebreaker so two people with the same name still have a stable
 * order.
 */
export async function listRoster(env: Env, companyWorkspaceIds: string[]): Promise<RosterMember[]> {
  // A member of no team has no peers. Returning early also keeps the IN () list
  // from rendering empty, which SQLite rejects.
  if (!companyWorkspaceIds.length) return [];
  const placeholders = companyWorkspaceIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT u.id AS userId, u.name AS name, u.role AS role
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE m.workspace_id IN (${placeholders})
        AND u.suspended = 0
        AND (u.removed_at IS NULL OR u.removed_at = 0)
      ORDER BY u.name COLLATE NOCASE ASC, u.id ASC`,
  ).bind(...companyWorkspaceIds).all<{ userId: string; name: string | null; role: string }>();
  return (results ?? []).map((r) => ({
    userId: r.userId,
    name: r.name || "",
    // Narrowed rather than cast: the column is free text in SQLite, and an
    // unexpected value reading as "member" is the safe direction.
    role: r.role === "admin" ? "admin" : "member",
  }));
}

/**
 * Display names for ids that appear in an audit trail.
 *
 * NOT listRoster, and the difference is the whole point: listRoster excludes
 * suspended and removed people, and the two events an auditor most needs to
 * read are `member_suspended` and `member_removed`, whose subjects are
 * exactly those people. A trail that cannot name the person it is about is
 * not a trail.
 *
 * By-id, on ids that came out of admin_events / entry_events — the same
 * shape lookupActorLabels already uses — and it returns nothing but id and
 * name. It is reached only from GET /team/activity, which is requireAdmin,
 * and it publishes strictly less about a person than GET /team/members
 * already does on the same deployment.
 */
export async function lookupAuditNames(env: Env, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  // No ids, no statement. A feed whose every row carries an empty actor and an
  // empty subject — a solo brain's, typically — costs one subrequest, not two.
  // It also keeps `IN ()` from rendering empty, which SQLite rejects.
  if (!unique.length) return new Map();
  const names = new Map<string, string>();
  // Chunked against the platform's bound-parameter ceiling, the way every other
  // dynamic IN-list in src/ is (entries/import.ts, graph/traverse.ts,
  // insight/weekly.ts). The caller is GET /team/activity, whose `limit` is
  // admitted up to 100 and whose every admin row can carry TWO different people
  // — an actor and a subject — so one page can name up to 200 people. Unchunked
  // that is 200 bound parameters against a ceiling of 100: D1 rejects the
  // statement outright, and there is no try/catch between this line and the
  // platform, so the rejection is a 500 on every page of that team's compliance
  // feed rather than a degraded one. See the note at the route.
  //
  // Each id is bound ONCE, so the chunk is the whole ceiling rather than the
  // halved one the two-alias slice in insight/weekly.ts needs. That makes the
  // worst case two statements — two of the ~5 subrequests this route spends of
  // its 50 — and the common case, a page naming a hundred people or fewer, is
  // the one statement it has always been.
  //
  // The maps are MERGED, not replaced: a person whose id lands in the second
  // chunk is named in the response exactly like one in the first.
  for (let i = 0; i < unique.length; i += D1_MAX_BOUND_PARAMS) {
    const chunk = unique.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      // Removed and suspended rows are INCLUDED, unlike lookupActorLabels and
      // listRoster. See the doc comment: those are the subjects of the rows an
      // auditor came for.
      `SELECT id, name FROM users WHERE id IN (${placeholders})`,
    ).bind(...chunk).all<{ id: string; name: string | null }>();
    // A blank name is NOT an entry. Callers publish this as "a name or null" —
    // two states — and mapping a NULL or empty `users.name` to "" invents a
    // third that no consumer's contract admits: one written `actor ?? "System"`
    // renders an empty cell, one written `actor || "Removed account"` renders a
    // label, for the same row. Dropping the row makes the caller's `?? null`
    // produce the null it already documents.
    for (const r of results ?? []) if (r.name) names.set(r.id, r.name);
  }
  return names;
}

export class TeamAdminError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function changedRows(result: D1Result<unknown>): number {
  const meta = result.meta as Record<string, number>;
  return meta.changes ?? meta.rows_written ?? 0;
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
      lastUsedAt: null,
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
  if (!changedRows(result)) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
  return token;
}

export async function setMemberSuspended(env: Env, actorId: string, userId: string, suspended: boolean): Promise<void> {
  if (userId === actorId && suspended) {
    throw new TeamAdminError(400, "You cannot suspend your own account");
  }
  const value = suspended ? 1 : 0;
  // Keep the last-admin check inside the write. Concurrent updates are
  // serialized by D1, so the second writer sees the first writer's result.
  const result = await env.DB.prepare(
    `UPDATE users AS target
        SET suspended = ?
      WHERE target.id = ?
        AND (target.removed_at IS NULL OR target.removed_at = 0)
        AND (
          ? = 0
          OR target.role != 'admin'
          OR EXISTS (
            SELECT 1 FROM users AS other
             WHERE other.id != target.id
               AND other.role = 'admin'
               AND other.suspended = 0
               AND (other.removed_at IS NULL OR other.removed_at = 0)
          )
        )`,
  ).bind(value, userId, value).run();
  if (changedRows(result)) return;

  const target = await env.DB.prepare(
    `SELECT role, removed_at FROM users WHERE id = ?`,
  ).bind(userId).first<{ role: string; removed_at: number | null }>();
  if (!target || Number(target.removed_at) > 0) {
    throw new TeamAdminError(404, `No member found with ID: ${userId}`);
  }
  if (suspended && target.role === "admin") {
    throw new TeamAdminError(400, "Cannot suspend the last active admin");
  }
  throw new TeamAdminError(409, "Member state changed concurrently; try again");
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
  if (!changedRows(result)) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
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
  let target = await env.DB.prepare(
    `SELECT role, removed_at FROM users WHERE id = ?`,
  ).bind(userId).first<{ role: string; removed_at: number | null }>();
  if (!target) throw new TeamAdminError(404, `No member found with ID: ${userId}`);

  if (!Number(target.removed_at)) {
    // Claim removal before cleanup. This atomic transition protects the admin
    // invariant; the idempotent cleanup below can be retried after a failure.
    const claimed = await env.DB.prepare(
      `UPDATE users AS target
          SET removed_at = ?
        WHERE target.id = ?
          AND target.id != ?
          AND (target.removed_at IS NULL OR target.removed_at = 0)
          AND (
            target.role != 'admin'
            OR EXISTS (
              SELECT 1 FROM users AS other
               WHERE other.id != target.id
                 AND other.role = 'admin'
                 AND other.suspended = 0
                 AND (other.removed_at IS NULL OR other.removed_at = 0)
            )
          )`,
    ).bind(Date.now(), userId, actorId).run();
    if (!changedRows(claimed)) {
      target = await env.DB.prepare(
        `SELECT role, removed_at FROM users WHERE id = ?`,
      ).bind(userId).first<{ role: string; removed_at: number | null }>();
      if (!target) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
      if (!Number(target.removed_at) && target.role === "admin") {
        throw new TeamAdminError(400, "Cannot remove the last active admin");
      }
      if (!Number(target.removed_at)) {
        throw new TeamAdminError(409, "Member state changed concurrently; try again");
      }
    }
  }

  const personal = await env.DB.prepare(
    `SELECT w.id AS wid FROM memberships m JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal' WHERE m.user_id = ?`,
  ).bind(userId).first<{ wid: string }>();
  if (!personal) throw new TeamAdminError(404, `No member found with ID: ${userId}`);

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

  await env.DB.batch([
    // Edges before entries: the edge delete resolves endpoints through the
    // entries table, so it has to run while the rows still exist.
    env.DB.prepare(
      // scope-exempt: offboarding: deletes exactly the edges whose endpoints are in the removed member's workspace, per the two subselects
      `DELETE FROM edges WHERE source_id IN (SELECT id FROM entries WHERE workspace_id = ?) OR target_id IN (SELECT id FROM entries WHERE workspace_id = ?)`,
    ).bind(personal.wid, personal.wid),
    env.DB.prepare(`DELETE FROM entries WHERE workspace_id = ?`).bind(personal.wid),
    env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(personal.wid),
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
  if (!changedRows(result)) throw new TeamAdminError(404, `No member found with ID: ${userId}`);
}

/** One company workspace, as members and admins both see it. */
export interface TeamWorkspace {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * The company workspaces a caller belongs to, oldest first — the same order
 * Identity.companyWorkspaceIds uses, so the first entry is the team a "share
 * with the team" with no target lands in.
 *
 * Takes the ids from the resolved identity rather than querying memberships
 * again: the identity already resolved them, and re-deriving the caller's teams
 * from the request is how a scoping helper stops being the only place scoping
 * is decided.
 */
export async function listTeamWorkspaces(env: Env, workspaceIds: string[]): Promise<TeamWorkspace[]> {
  if (!workspaceIds.length) return [];
  const placeholders = workspaceIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    // COUNT over the USER, not the membership row: the join to users is
    // filtered to active people, so a suspended or removed member leaves a NULL
    // that COUNT skips. Counting m.user_id would have counted them anyway.
    `SELECT w.id AS id, w.name AS name, COUNT(DISTINCT u.id) AS memberCount
       FROM workspaces w
       LEFT JOIN memberships m ON m.workspace_id = w.id
       LEFT JOIN users u ON u.id = m.user_id
         AND u.suspended = 0 AND (u.removed_at IS NULL OR u.removed_at = 0)
      WHERE w.id IN (${placeholders})
      GROUP BY w.id`,
  ).bind(...workspaceIds).all<{ id: string; name: string; memberCount: number }>();

  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  // Ordered by the caller's own list, not by what the database returned, so the
  // primary team is always first.
  return workspaceIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ id, name: row.name || "", memberCount: Number(row.memberCount) || 0 }] : [];
  });
}

/** Rename a team. The caller must already have been checked as an admin of it. */
export async function renameTeamWorkspace(env: Env, workspaceId: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new TeamAdminError(400, "Give the team a name");
  if (trimmed.length > 60) throw new TeamAdminError(400, "Team names are limited to 60 characters");
  const changed = await env.DB.prepare(
    `UPDATE workspaces SET name = ? WHERE id = ? AND kind = 'company'`,
  ).bind(trimmed, workspaceId).run();
  if (!changed.meta?.rows_written) throw new TeamAdminError(404, "No team found with that ID");
  return trimmed;
}
