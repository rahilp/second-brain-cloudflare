/**
 * Prompt Capsule reads, cached in KV.
 *
 * `buildPromptCapsule` filters on `instr(lower(tags), ?)`, which no index can
 * serve: EXPLAIN shows a seek on workspace_id and then a visit to every row in
 * that workspace, so one read costs N rows on an N-entry workspace, and the
 * ETag cannot short-circuit that because it is derived from the query result.
 * A gateway fetching its prefix per request would spend D1's 5M rows/day free
 * tier on a mid-sized brain. Same move as src/tags/vocabulary.ts (#288): put
 * the steady state on KV, a separate quota that is constant in the size of the
 * brain.
 *
 * Keyed by the resolved workspace id that the scope clause binds, never by the
 * "personal"/"company" labels, so one member's capsule can never be served to
 * another. D1 owns the per-workspace revision: entry triggers advance it in the
 * same transaction as every capsule-tagged INSERT, content/tag/workspace UPDATE,
 * id change, or DELETE. A missing derived row is initialized with a random value
 * on first read. A read pays one indexed D1 row for that authoritative revision,
 * then normally gets the immutable revision payload from KV. KV's eventual
 * consistency can therefore cause an extra rebuild, but can never revive a
 * capsule from before a share, delete, or edit.
 *
 * Every KV failure reads as a miss and never fails the request. Only successful
 * builds are cached; a 400 or 409 is always recomputed.
 */
import type { Env } from "../env";
import type { PromptCapsulePayload } from "./build";
import { sha256Hex, strongEtag } from "./etag";
import { PROMPT_CAPSULE_SCHEMA, type PromptCapsuleKind } from "./types";

// A revision change makes the old key unreachable immediately; TTL only bounds
// physical orphan retention. Once propagation has settled, one hour normally
// limits an unchanged, continuously-read target to 24 TTL refresh writes/day
// instead of 288 at five minutes, preserving the Free-plan write budget shared
// with OAuth state. Cold-fill races and revision changes can add attempts.
export const PROMPT_CAPSULE_CACHE_TTL_SECONDS = 3_600;

const CACHE_PREFIX = "prompt-capsule:v2:";

export interface CachedPromptCapsule {
  ok: true;
  payload: PromptCapsulePayload;
  bodyText: string;
  etag: string;
}

export interface PromptCapsuleCacheLookup {
  cached: CachedPromptCapsule | null;
  /** Revision observed before the D1 build; null means caching is unsafe. */
  revision: string | null;
}

export function promptCapsuleCacheKey(
  workspaceId: string,
  revision: string,
  kind: PromptCapsuleKind,
  projectId?: string,
): string {
  return `${CACHE_PREFIX}${workspaceId}:${revision}:${kind}:${projectId ?? ""}`;
}

function parseRevision(row: { revision: unknown } | null): string | null {
  if (row === null) return null;
  return typeof row.revision === "string" && /^[0-9a-f]{32}$/.test(row.revision)
    ? row.revision
    : null;
}

/**
 * Read the authoritative D1 revision, creating an opaque one on first use.
 *
 * A fixed sentinel for a missing row is unsafe: D1 Time Travel or an import
 * that restores entries without this derived table could make a still-live KV
 * key from the future addressable again. The conflict-only insert makes concurrent
 * first reads converge on one random revision instead.
 */
async function readRevision(env: Env, workspaceId: string): Promise<string | null> {
  const select = () => env.DB.prepare(
    `SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`,
  ).bind(workspaceId).first<{ revision: unknown }>();
  const existing = await select();
  if (existing !== null) return parseRevision(existing);

  await env.DB.prepare(
    `INSERT INTO prompt_capsule_revisions (workspace_id, revision)
     VALUES (?, lower(hex(randomblob(16))))
     ON CONFLICT(workspace_id) DO NOTHING`,
  ).bind(workspaceId).run();
  return parseRevision(await select());
}

export async function readCachedPromptCapsule(
  env: Env,
  workspaceId: string,
  kind: PromptCapsuleKind,
  target: { workspace: "personal" | "company"; team: string | null },
  projectId?: string,
): Promise<PromptCapsuleCacheLookup> {
  try {
    const revision = await readRevision(env, workspaceId);
    if (revision === null) return { cached: null, revision: null };
    const raw = await env.OAUTH_KV.get(promptCapsuleCacheKey(workspaceId, revision, kind, projectId));
    if (!raw) return { cached: null, revision };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return { cached: null, revision };
      const { bodyText, etag } = parsed as Record<string, unknown>;
      if (typeof bodyText !== "string" || typeof etag !== "string") return { cached: null, revision };
      const payload = JSON.parse(bodyText) as PromptCapsulePayload;
      const expectedProjectId = kind === "project" ? projectId : undefined;
      if (
        payload?.ok !== true
        || payload.schema !== PROMPT_CAPSULE_SCHEMA
        || payload.kind !== kind
        || payload.project_id !== expectedProjectId
        || payload.workspace !== target.workspace
        || payload.team !== target.team
        || typeof payload.text !== "string"
        || payload.prompt_hash !== `sha256:${await sha256Hex(payload.text)}`
        || etag !== await strongEtag("pcv1", bodyText)
      ) {
        return { cached: null, revision };
      }
      return { cached: { ok: true, payload, bodyText, etag }, revision };
    } catch {
      return { cached: null, revision };
    }
  } catch {
    return { cached: null, revision: null };
  }
}

/**
 * Store one successful build only if no invalidation happened while D1 was
 * building it. Never throws.
 */
export async function writeCachedPromptCapsule(
  env: Env,
  workspaceId: string,
  kind: PromptCapsuleKind,
  projectId: string | undefined,
  expectedRevision: string | null,
  observedRevision: string | null,
  built: { bodyText: string; etag: string },
): Promise<void> {
  // `observedRevision` is read in the same D1 batch transaction as the
  // candidate rows. If it differs from the revision used for the cache lookup,
  // those rows do not belong under that immutable key.
  if (expectedRevision === null || observedRevision !== expectedRevision) return;
  try {
    await env.OAUTH_KV.put(
      promptCapsuleCacheKey(workspaceId, expectedRevision, kind, projectId),
      JSON.stringify({ bodyText: built.bodyText, etag: built.etag }),
      { expirationTtl: PROMPT_CAPSULE_CACHE_TTL_SECONDS },
    );
  } catch (e) {
    console.error("Prompt capsule cache write failed (non-fatal):", e);
  }
}
