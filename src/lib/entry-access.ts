import type { Env } from "../env";
import type { Identity } from "./identity";
import { isCompanyWorkspace, scopeWhere } from "./scope";

/** Columns every guard needs; callers may request more via `columns`. */
export interface EntryAccessRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  content?: string;
  tags?: string;
  source?: string;
}

export type EntryAccessDenied = { code: "forbidden"; message: string };

const FORBIDDEN_MSG = "Only the entry's author or an admin can modify a shared company memory";

/**
 * Fetch one entry row only if it lives in the caller's readable set (personal ∪
 * company, plus the legacy '' sentinel for admins). Returns null when the id is
 * absent or outside that set — same visibility semantics as share.ts.
 */
export async function getReadableEntry(
  env: Env,
  identity: Identity | undefined,
  id: string,
  columns = "id, workspace_id, actor_id",
): Promise<EntryAccessRow | null> {
  if (!identity) {
    // scope-exempt: identity-less branch: pre-tenancy callers and unit fixtures; the scoped branch is directly below
    return env.DB.prepare(`SELECT ${columns} FROM entries WHERE id = ?`)
      .bind(id)
      .first<EntryAccessRow>();
  }
  const scope = scopeWhere(identity);
  return env.DB.prepare(
    `SELECT ${columns} FROM entries WHERE id = ? AND ${scope.clause}`,
  ).bind(id, ...scope.bindings).first<EntryAccessRow>();
}

function companyEditDenied(identity: Identity, row: Pick<EntryAccessRow, "workspace_id" | "actor_id">): boolean {
  // Any of the caller's company layers, not one of them: the lock protects a
  // shared row from a non-author whichever team it was shared into.
  return isCompanyWorkspace(identity, row.workspace_id)
    && row.actor_id !== identity.userId
    && identity.role !== "admin";
}

/** Author guard for destructive / lifecycle mutators (forget, set_status, …). */
export function assertCanMutateEntry(
  identity: Identity | undefined,
  row: Pick<EntryAccessRow, "workspace_id" | "actor_id">,
): EntryAccessDenied | null {
  if (!identity || !companyEditDenied(identity, row)) return null;
  return { code: "forbidden", message: FORBIDDEN_MSG };
}

/** Author guard for content edits (append, update). Same rule as mutate on company rows. */
export function assertCanEditContent(
  identity: Identity | undefined,
  row: Pick<EntryAccessRow, "workspace_id" | "actor_id">,
): EntryAccessDenied | null {
  return assertCanMutateEntry(identity, row);
}
