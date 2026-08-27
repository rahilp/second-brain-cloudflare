import type { Env } from "../env";

const SYSTEM_SOURCES = new Set(["system"]);

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
  if (opts?.source && SYSTEM_SOURCES.has(opts.source.toLowerCase())) return "System";
  if (opts?.viewerId && actorId === opts.viewerId) return "You";
  if (!actorId) return "Owner";
  return labelMap.get(actorId) ?? "Former member";
}
