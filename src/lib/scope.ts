import type { Identity } from "./identity";

/**
 * The one place workspace scoping is spelled out. Every SQL statement whose rows
 * can reach a response goes through here; a domain module that finds itself
 * writing `FROM entries` with a bare string template is either missing a scope
 * clause (a cross-user leak waiting to ship) or is an internal by-id lookup whose
 * ids came from an already-scoped read.
 *
 * House rule (docs/superpowers/specs/2026-08-24-team-edition-design.md): no
 * unscoped corpus-wide query. Enforcement is this helper plus the cross-user
 * isolation suite (test/integration/team-isolation.test.ts), not lint.
 */

export interface ScopeClause {
  clause: string;
  bindings: string[];
}

/**
 * The workspaces whose rows the caller may read: their own personal workspace
 * plus the shared company workspace. Rendered as `workspace_id IN (?, ?)` so it
 * composes with existing WHERE fragments via AND.
 */
/**
 * The write-side twin of Identity: where a new entry row lands and who gets
 * stamped as its actor. Resolved from an Identity at the route/MCP edge and
 * threaded through the domain as this plain value, so no write path reads
 * request state itself.
 */
export interface WriteContext {
  workspaceId: string;
  actorId: string;
}

/**
 * Pre-team single-owner semantics: both columns stay '' exactly as every row
 * written before v3 did. The default on every write-path parameter, which is
 * what keeps existing call sites compiling — and correct, until P2 threads a
 * resolved context from each surface.
 */
export const OWNER_WRITE_CONTEXT: WriteContext = { workspaceId: "", actorId: "" };

export function readableWorkspaces(identity: Identity): string[] {
  // Spread, not index: a member of two teams reads both. Every consumer of this
  // list already treats its length as variable — scopeWhere renders one
  // placeholder per entry, and the D1 batch sizes that share a statement with it
  // subtract `scope.bindings.length` from the 100-parameter ceiling rather than
  // assuming two or three.
  const workspaces = [identity.personalWorkspaceId, ...identity.companyWorkspaceIds];
  // The '' sentinel is the legacy/system space — pre-team rows and mixed-provenance
  // insight output. Admins keep eyes on it so a context-less writer can never create
  // an invisible row; members must never see it.
  if (identity.role === "admin") workspaces.push("");
  return workspaces;
}

/**
 * The team a write goes to when the caller says "company" without naming one.
 *
 * Oldest first, so on every brain that has one team this is that team, and on a
 * brain that later grows a second the original keeps being the default rather
 * than the answer moving under existing members. Empty string when the caller
 * belongs to no team — `scopeWrite` then falls back to personal, because a write
 * with nowhere to land must not become an invisible row in the '' space.
 */
export function primaryCompanyWorkspaceId(identity: Identity): string {
  return identity.companyWorkspaceIds[0] ?? "";
}

/** Whether a row's workspace is one of the caller's company layers. */
export function isCompanyWorkspace(identity: Identity, workspaceId: unknown): boolean {
  return typeof workspaceId === "string"
    && workspaceId !== ""
    && identity.companyWorkspaceIds.includes(workspaceId);
}

/**
 * The workspace ids a read should cover: the readable set, or just one layer of
 * it when the caller asked to scope ("personal" | "company"). Requesting a
 * single layer can only ever narrow — both ids come from the identity, so a
 * caller can never name a workspace it does not belong to.
 */
export function scopeWorkspaces(identity: Identity, only?: "personal" | "company"): string[] {
  if (only === "personal") return [identity.personalWorkspaceId];
  // Narrowing to "company" narrows to the caller's company layers — all of them.
  // It can still only ever narrow, because every id comes from the identity.
  if (only === "company") return identity.companyWorkspaceIds;
  return readableWorkspaces(identity);
}

export function scopeWhere(identity: Identity, only?: "personal" | "company", column = "workspace_id"): ScopeClause {
  const workspaces = scopeWorkspaces(identity, only);
  return { clause: `${column} IN (${workspaces.map(() => "?").join(", ")})`, bindings: workspaces };
}

/**
 * Which workspace a write lands in. Defaults to the caller's personal workspace —
 * remembering something is private until it is explicitly shared — and only ever
 * returns a workspace the caller is actually a member of, because both values come
 * from the resolved identity rather than from anything the request could say.
 */
export function scopeWrite(identity: Identity, target?: "personal" | "company", team?: string): string {
  if (target !== "company") return identity.personalWorkspaceId;
  // A named team is honoured only if the caller is actually in it — the id comes
  // from the request, so this is the check that keeps a request from naming a
  // workspace its author does not belong to.
  if (team && identity.companyWorkspaceIds.includes(team)) return team;
  return primaryCompanyWorkspaceId(identity) || identity.personalWorkspaceId;
}

/**
 * Capture-visibility precedence, in order:
 *   1. The request's explicit target ("personal" | "company") — always wins.
 *   2. The member's own override (users.default_share, carried on Identity).
 *   3. The org-level default (config TEAM_DEFAULT_WORKSPACE, admin-set).
 *   4. "personal" — private until shared, the shipped behaviour.
 * Only the resolved enum ever reaches scopeWrite, so no request value can name
 * a workspace the caller does not belong to.
 */
export function effectiveWriteTarget(
  identity: Identity,
  explicit?: unknown,
  orgDefault?: string,
): "personal" | "company" {
  if (explicit === "company" || explicit === "personal") return explicit;
  if (identity.defaultShare) return identity.defaultShare;
  if (orgDefault === "company") return "company";
  return "personal";
}
