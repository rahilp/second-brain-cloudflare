import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import type { Identity } from "../lib/identity";
import { readTeamParam, scopeWhereForRead, type ScopeClause } from "../lib/scope";
import { STATUS_PREFIX } from "../memory/status";
import { readCachedPromptCapsule, writeCachedPromptCapsule } from "./cache";
import { sha256Hex, strongEtag } from "./etag";
import { selectPromptCapsuleEntries } from "./select";
import { serializePromptCapsule } from "./serialize";
import {
  PROMPT_CAPSULE_MAX_CANDIDATES,
  PROMPT_CAPSULE_MAX_CHARS,
  PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS,
  PROMPT_CAPSULE_MAX_TAG_CHARS,
  PROMPT_CAPSULE_SCHEMA,
  capsuleTag,
  type PromptCapsuleCandidate,
  type PromptCapsuleKind,
} from "./types";

export interface PromptCapsuleBuildRequest {
  kind: PromptCapsuleKind;
  projectId?: string;
  workspace?: "personal" | "company";
  team?: string;
}

export interface PromptCapsulePayload {
  ok: true;
  schema: typeof PROMPT_CAPSULE_SCHEMA;
  kind: PromptCapsuleKind;
  project_id?: string;
  workspace: "personal" | "company";
  team: string | null;
  prompt_hash: string;
  text: string;
  sections: Array<{ slot: string; source_entry_id: string }>;
  omitted_slots: string[];
  complete: boolean;
  char_count: number;
  max_chars: number;
}

export type PromptCapsuleBuildResult = {
  ok: true;
  payload: PromptCapsulePayload;
  bodyText: string;
  etag: string;
} | {
  ok: false;
  status: 400 | 409;
  body: Record<string, unknown> & { ok: false; error: string };
};

function parseStoredTags(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function exactJsonTagNeedle(tag: string): string {
  // Tags are stored as a JSON string array. Including the quotes prevents a
  // project id from matching a longer neighbouring tag. lower(tags) keeps the
  // system namespace case-insensitive without using LIKE, whose D1 pattern is
  // limited to 50 bytes and cannot represent every valid 64-character id.
  return JSON.stringify(tag.toLowerCase());
}

function invalidRequest(error: string): PromptCapsuleBuildResult {
  return { ok: false, status: 400, body: { ok: false, code: "invalid_request", error } };
}

interface ResolvedCapsuleScope {
  workspace: "personal" | "company";
  teamId?: string;
  scope: ScopeClause;
}

interface PromptCapsuleCandidateRow {
  id: string;
  id_length: number;
  content: unknown;
  content_length: number;
  tags: unknown;
  tags_length: number;
}

interface PromptCapsuleD1Snapshot {
  built: PromptCapsuleBuildResult;
  /** Revision read in the same D1 batch transaction as the candidate rows. */
  observedRevision: string | null;
}

/** Validate the request and resolve the one workspace it reads. No I/O. */
function resolveCapsuleScope(
  identity: Identity,
  request: PromptCapsuleBuildRequest,
): ResolvedCapsuleScope | PromptCapsuleBuildResult {
  const workspace = request.workspace ?? "personal";
  if (request.kind === "project" && !request.projectId) {
    return invalidRequest("project_id is required for a project capsule");
  }
  if (request.kind === "core" && request.projectId !== undefined) {
    return invalidRequest("project_id is valid only for a project capsule");
  }

  const teamRead = readTeamParam(request.team, identity, workspace);
  if (teamRead.error) return invalidRequest(teamRead.error);
  let teamId = teamRead.teamId;
  if (workspace === "company" && !teamId) {
    if (!identity.companyWorkspaceIds.length) {
      return invalidRequest("No shared team workspace is available");
    }
    if (identity.companyWorkspaceIds.length > 1) {
      return invalidRequest("team is required when you belong to more than one shared workspace");
    }
    teamId = identity.companyWorkspaceIds[0];
  }

  return { workspace, teamId, scope: scopeWhereForRead(identity, { layer: workspace, teamId }) };
}

/**
 * Build the single canonical Prompt Capsule representation used by both REST
 * and MCP. Authentication is resolved at the edge; this function only accepts
 * an identity-derived scope and never reads request credentials.
 *
 * Successful builds are served from KV (see ./cache.ts) keyed by the workspace
 * id the scope clause binds. A repeat read pays one indexed D1 revision row,
 * rather than scanning every entry in the workspace.
 */
export async function buildPromptCapsule(
  env: Env,
  identity: Identity,
  request: PromptCapsuleBuildRequest,
): Promise<PromptCapsuleBuildResult> {
  const resolved = resolveCapsuleScope(identity, request);
  if ("ok" in resolved) return resolved;

  // Prompt Capsule caching depends on the D1 revision table and entry triggers.
  // The ordinary route startup initializes in waitUntil; this one read must wait
  // so no v2 cache value can be created during a partially applied migration.
  await initializeDatabase(env);

  // The cache key is the bound workspace id itself, never the layer label. A
  // scope that binds anything other than exactly one id is not cached.
  const cacheWorkspaceId = resolved.scope.bindings.length === 1 ? resolved.scope.bindings[0] : null;
  let cacheRevision: string | null = null;
  if (cacheWorkspaceId !== null) {
    const lookup = await readCachedPromptCapsule(
      env,
      cacheWorkspaceId,
      request.kind,
      { workspace: resolved.workspace, team: resolved.teamId ?? null },
      request.projectId,
    );
    if (lookup.cached) return lookup.cached;
    cacheRevision = lookup.revision;
  }

  // If the revision lookup failed, do not ask for it again inside the snapshot
  // batch: the Capsule itself remains available as an uncached D1 read even
  // while this derived cache metadata is unavailable.
  const snapshotWorkspaceId = cacheRevision === null ? null : cacheWorkspaceId;
  const snapshot = await buildPromptCapsuleFromD1(env, request, resolved, snapshotWorkspaceId);
  const cacheable = snapshot.built.ok && (
    request.kind === "core"
    || snapshot.built.payload.sections.length > 0
    || snapshot.built.payload.omitted_slots.length > 0
  );
  // Project ids are caller-selected. Do not let arbitrary ids create one empty
  // KV key each; cache a project only after at least one definition exists.
  if (cacheable && snapshot.built.ok && cacheWorkspaceId !== null) {
    await writeCachedPromptCapsule(
      env,
      cacheWorkspaceId,
      request.kind,
      request.projectId,
      cacheRevision,
      snapshot.observedRevision,
      snapshot.built,
    );
  }
  return snapshot.built;
}

async function buildPromptCapsuleFromD1(
  env: Env,
  request: PromptCapsuleBuildRequest,
  { workspace, teamId, scope }: ResolvedCapsuleScope,
  cacheWorkspaceId: string | null,
): Promise<PromptCapsuleD1Snapshot> {
  const baseTag = capsuleTag(request.kind, request.projectId);
  // scope-checked: scopeWhereForRead resolves one identity-owned personal/team
  // workspace before the bounded tag scan; tool and route input never becomes SQL.
  const candidateStatement = env.DB.prepare(
    `SELECT substr(id, 1, ?) AS id,
            length(id) AS id_length,
            substr(content, 1, ?) AS content,
            length(content) AS content_length,
            substr(tags, 1, ?) AS tags,
            length(tags) AS tags_length
       FROM entries
      WHERE ${scope.clause}
        AND instr(lower(tags), ?) > 0
        AND instr(lower(tags), ?) > 0
      ORDER BY id ASC
      LIMIT ?`,
  ).bind(
    PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS + 1,
    PROMPT_CAPSULE_MAX_CHARS + 1,
    PROMPT_CAPSULE_MAX_TAG_CHARS + 1,
    ...scope.bindings,
    exactJsonTagNeedle(baseTag),
    exactJsonTagNeedle(`${STATUS_PREFIX}canonical`),
    PROMPT_CAPSULE_MAX_CANDIDATES + 1,
  );

  let results: PromptCapsuleCandidateRow[];
  let observedRevision: string | null = null;
  if (cacheWorkspaceId === null) {
    ({ results } = await candidateStatement.all<PromptCapsuleCandidateRow>());
  } else {
    // D1 batch executes as one transaction. Reading the candidates and revision
    // in that snapshot prevents a concurrent update or Time Travel restore from
    // making future rows look as though they belonged to an older cache key.
    const [candidateResult, revisionResult] = await env.DB.batch<Record<string, unknown>>([
      candidateStatement,
      env.DB.prepare(
        `SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`,
      ).bind(cacheWorkspaceId),
    ]);
    results = candidateResult.results as unknown as PromptCapsuleCandidateRow[];
    const revision = revisionResult.results[0]?.revision;
    observedRevision = typeof revision === "string" && /^[0-9a-f]{32}$/.test(revision)
      ? revision
      : null;
  }

  const finish = (built: PromptCapsuleBuildResult): PromptCapsuleD1Snapshot => ({
    built,
    observedRevision,
  });

  if (results.length > PROMPT_CAPSULE_MAX_CANDIDATES) {
    return finish({
      ok: false,
      status: 409,
      body: {
        ok: false,
        code: "too_many_candidates",
        error: `Prompt capsule has more than ${PROMPT_CAPSULE_MAX_CANDIDATES} canonical tagged candidates; clean up the capsule tags before retrying`,
      },
    });
  }

  const oversizedEntryIdCount = results.filter(
    row => Number(row.id_length) > PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS,
  ).length;
  if (oversizedEntryIdCount) {
    return finish({
      ok: false,
      status: 409,
      body: {
        ok: false,
        code: "invalid_prompt_capsule",
        error: `Prompt capsule contains ${oversizedEntryIdCount} entry id(s) longer than ${PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS} characters`,
        invalid_entries: [{
          entry_id: "[omitted]",
          reason: "entry-id-too-large",
        }],
      },
    });
  }

  // A row longer than the whole budget can never be emitted, and its truncated
  // prefix must never reach normalization (trailing whitespace could collapse it
  // below the budget and publish a partial entry). Ids are safe to reflect: the
  // oversized-id check above ran first.
  const oversizedContent = results.filter(row => Number(row.content_length) > PROMPT_CAPSULE_MAX_CHARS);
  if (oversizedContent.length) {
    return finish({
      ok: false,
      status: 409,
      body: {
        ok: false,
        code: "invalid_prompt_capsule",
        error: `Prompt capsule contains ${oversizedContent.length} entry(ies) longer than ${PROMPT_CAPSULE_MAX_CHARS} characters`,
        invalid_entries: oversizedContent.map(row => ({
          entry_id: String(row.id ?? ""),
          reason: "content-too-large",
        })),
      },
    });
  }

  const candidates: PromptCapsuleCandidate[] = results.map(row => ({
    id: String(row.id ?? ""),
    content: row.content,
    tags: Number(row.tags_length) > PROMPT_CAPSULE_MAX_TAG_CHARS
      ? null
      : parseStoredTags(row.tags),
  }));
  const selected = selectPromptCapsuleEntries(request.kind, candidates, request.projectId);
  if (selected.invalidEntries.length || selected.duplicateSlots.length) {
    return finish({
      ok: false,
      status: 409,
      body: {
        ok: false,
        code: "invalid_prompt_capsule",
        error: "Prompt capsule definition is ambiguous or malformed",
        invalid_entries: selected.invalidEntries.map(entry => ({
          entry_id: entry.entryId,
          reason: entry.reason,
        })),
        duplicate_slots: selected.duplicateSlots.map(slot => ({
          slot: slot.slot,
          entry_ids: slot.entryIds,
        })),
      },
    });
  }

  const serialized = serializePromptCapsule(request.kind, selected.sections);
  const promptHash = await sha256Hex(serialized.text);
  const payload: PromptCapsulePayload = {
    ok: true,
    schema: PROMPT_CAPSULE_SCHEMA,
    kind: request.kind,
    ...(request.projectId ? { project_id: request.projectId } : {}),
    workspace,
    team: teamId ?? null,
    prompt_hash: `sha256:${promptHash}`,
    text: serialized.text,
    sections: serialized.sections.map(section => ({
      slot: section.slot,
      source_entry_id: section.sourceEntryId,
    })),
    omitted_slots: serialized.omittedSlots,
    complete: serialized.complete,
    char_count: serialized.charCount,
    max_chars: serialized.maxChars,
  };
  const bodyText = JSON.stringify(payload, null, 2);
  return finish({
    ok: true,
    payload,
    bodyText,
    etag: await strongEtag("pcv1", bodyText),
  });
}
