import type { Env } from "../env";
import type { Identity } from "./identity";
import { listRoster } from "./team-admin";

const SYSTEM_SOURCES = new Set(["system"]);

/**
 * What the product calls itself when it is the author.
 *
 * "System" named a category; this names the writer. A member reading
 * "Shared · System" on a company-layer insight has been told which
 * subsystem wrote it, which is not a fact they can use — spec 4.5 asks for
 * the attribution a reader can, and it is the product's name.
 *
 * One constant in one function, so the memories card, the detail sheet,
 * recall results and the graph cannot disagree about it. It is a server
 * string like "Owner" and "Former member" beside it, and like them it is
 * not translated — see the note below.
 *
 * NOT INSIGHT-SPECIFIC, deliberately. This branch labels digests and
 * rolled-up entries too, and a source-specific special case would leave a
 * digest reading "System" and an insight reading "Second Brain" on the same
 * list — two names for one author.
 *
 * STATED RATHER THAN FIXED: "Owner", "Former member", "You" and now
 * "Second Brain" are server-produced display strings the dashboard renders
 * untranslated. That hole predates this phase and this constant does not
 * widen it — it renames one of the four. Closing it means moving all four to
 * i18n keys, which is a different change.
 */
export const SYSTEM_ACTOR_LABEL = "Second Brain";

/** The one refusal an actor filter can give, so both surfaces say it identically. */
const NOT_A_TEAM_MEMBER = "actor must be a member of your team";

/**
 * Batch-resolve user ids to display names. Soft-deleted members (removed_at set)
 * are omitted so callers fall through to "Former member" in resolveActorLabel.
 */
export async function lookupActorLabels(env: Env, actorIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(actorIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM users WHERE id IN (${placeholders}) AND (removed_at IS NULL OR removed_at = 0)`,
  ).bind(...unique).all<{ id: string; name: string }>();
  return new Map((results ?? []).map((r) => [r.id, r.name]));
}

/**
 * Turn an actor_id (+ optional source) into a human label for recall, lists, and
 * entry detail. Empty actor_id is the legacy single-owner brain — "Owner".
 */
export function resolveActorLabel(
  actorId: string,
  labelMap: Map<string, string>,
  opts?: { viewerId?: string; source?: string },
): string {
  if (opts?.source && SYSTEM_SOURCES.has(opts.source.toLowerCase())) return SYSTEM_ACTOR_LABEL;
  if (opts?.viewerId && actorId === opts.viewerId) return "You";
  if (!actorId) return "Owner";
  return labelMap.get(actorId) ?? "Former member";
}

/**
 * The resolved form of an `actor` filter: either one user id to bind, or the
 * message the surface should show. Never a list and never a set of ids, because
 * what reaches SQL has to stay ONE predicate with ONE binding — see below.
 */
export type ActorFilter = { ok: true; actorId: string } | { ok: false; error: string };

/**
 * Turn what a caller typed — a user id, a display name as printed in the
 * header, or `me` — into the single `actor_id` a listing may filter on.
 *
 * One vocabulary with three spellings, resolved in one place: the dashboard
 * holds ids, MCP holds the names it prints, a person holds "me", and the SQL
 * only ever sees an id. Both read surfaces (`GET /list`, the `list_recent`
 * tool) call this, so a name means the same thing in each.
 *
 * `me` costs nothing: the answer is already on the resolved identity, so the
 * common case issues no statement at all.
 *
 * Everything else resolves through `listRoster` rather than a `SELECT … FROM
 * users`, and that choice is the security property. The roster is scoped
 * through `memberships` to the caller's OWN company workspaces, so a name or an
 * id belonging to a team the caller is not in cannot resolve here — the answer
 * is the same "not a member" a typo gets, which is why the failure is a refusal
 * rather than an empty list: an empty list would confirm that person exists.
 * It also adds no SQL statement of its own, and it inherits the roster's
 * three-column allowlist for free.
 *
 * A duplicate display name resolves to the first in the roster's own
 * `ORDER BY u.name COLLATE NOCASE, u.id` order — deterministic, and the same
 * row the roster screen lists first.
 */
export async function resolveActorFilter(
  env: Env,
  identity: Identity,
  raw: string,
): Promise<ActorFilter> {
  const value = raw.trim();
  // A blank value is not a person, and it must not fall through to the name
  // comparison below: `"" === ""` would match any roster member carrying an
  // empty name, so a blank filter would silently resolve to an arbitrary
  // colleague. Both name-write paths coerce "" to "Member" today; this does not
  // rely on that. Deciding that a blank filter means NO filter is the calling
  // surface's job, and both surfaces make that decision before calling here.
  if (!value) return { ok: false, error: NOT_A_TEAM_MEMBER };
  if (value.toLowerCase() === "me") return { ok: true, actorId: identity.userId };

  const roster = await listRoster(env, identity.companyWorkspaceIds);
  const byId = roster.find((r) => r.userId === value);
  if (byId) return { ok: true, actorId: byId.userId };
  const lower = value.toLowerCase();
  const byName = roster.find((r) => r.name.toLowerCase() === lower);
  if (byName) return { ok: true, actorId: byName.userId };

  return { ok: false, error: NOT_A_TEAM_MEMBER };
}
