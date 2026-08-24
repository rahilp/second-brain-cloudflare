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
  return [identity.personalWorkspaceId, identity.companyWorkspaceId];
}

export function scopeWhere(identity: Identity, column = "workspace_id"): ScopeClause {
  const workspaces = readableWorkspaces(identity);
  return { clause: `${column} IN (${workspaces.map(() => "?").join(", ")})`, bindings: workspaces };
}

/**
 * Which workspace a write lands in. Defaults to the caller's personal workspace —
 * remembering something is private until it is explicitly shared — and only ever
 * returns a workspace the caller is actually a member of, because both values come
 * from the resolved identity rather than from anything the request could say.
 */
export function scopeWrite(identity: Identity, target?: "personal" | "company"): string {
  return target === "company" ? identity.companyWorkspaceId : identity.personalWorkspaceId;
}
