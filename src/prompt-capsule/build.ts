import type { Env } from "../env";
import type { Identity } from "../lib/identity";
import { readTeamParam, scopeWhereForRead } from "../lib/scope";
import { STATUS_PREFIX } from "../memory/status";
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

const OVERSIZED_CONTENT_SENTINEL = "x".repeat(PROMPT_CAPSULE_MAX_CHARS + 1);

/**
 * Build the single canonical Prompt Capsule representation used by both REST
 * and MCP. Authentication is resolved at the edge; this function only accepts
 * an identity-derived scope and never reads request credentials.
 */
export async function buildPromptCapsule(
  env: Env,
  identity: Identity,
  request: PromptCapsuleBuildRequest,
): Promise<PromptCapsuleBuildResult> {
  const workspace = request.workspace ?? "personal";
  if (request.kind === "project" && !request.projectId) {
    return { ok: false, status: 400, body: { ok: false, error: "project_id is required for a project capsule" } };
  }
  if (request.kind === "core" && request.projectId !== undefined) {
    return { ok: false, status: 400, body: { ok: false, error: "project_id is valid only for a project capsule" } };
  }

  const teamRead = readTeamParam(request.team, identity, workspace);
  if (teamRead.error) {
    return { ok: false, status: 400, body: { ok: false, error: teamRead.error } };
  }
  let teamId = teamRead.teamId;
  if (workspace === "company" && !teamId) {
    if (!identity.companyWorkspaceIds.length) {
      return { ok: false, status: 400, body: { ok: false, error: "No shared team workspace is available" } };
    }
    if (identity.companyWorkspaceIds.length > 1) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: "team is required when you belong to more than one shared workspace" },
      };
    }
    teamId = identity.companyWorkspaceIds[0];
  }

  const baseTag = capsuleTag(request.kind, request.projectId);
  const scope = scopeWhereForRead(identity, { layer: workspace, teamId });
  // scope-checked: scopeWhereForRead resolves one identity-owned personal/team
  // workspace before the bounded tag scan; tool and route input never becomes SQL.
  const { results } = await env.DB.prepare(
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
  ).all<{
    id: string;
    id_length: number;
    content: unknown;
    content_length: number;
    tags: unknown;
    tags_length: number;
  }>();

  if (results.length > PROMPT_CAPSULE_MAX_CANDIDATES) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: `Prompt capsule has more than ${PROMPT_CAPSULE_MAX_CANDIDATES} canonical tagged candidates; clean up the capsule tags before retrying`,
      },
    };
  }

  const oversizedEntryIdCount = results.filter(
    row => Number(row.id_length) > PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS,
  ).length;
  if (oversizedEntryIdCount) {
    return {
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
    };
  }

  const candidates: PromptCapsuleCandidate[] = results.map(row => ({
    id: String(row.id ?? ""),
    // Never pass a truncated prefix to normalization: trailing whitespace in
    // that prefix could collapse below the budget and publish a partial entry.
    // The sentinel is guaranteed to make serialization omit this slot whole.
    content: Number(row.content_length) > PROMPT_CAPSULE_MAX_CHARS
      ? OVERSIZED_CONTENT_SENTINEL
      : row.content,
    tags: Number(row.tags_length) > PROMPT_CAPSULE_MAX_TAG_CHARS
      ? null
      : parseStoredTags(row.tags),
  }));
  const selected = selectPromptCapsuleEntries(request.kind, candidates, request.projectId);
  if (selected.invalidEntries.length || selected.duplicateSlots.length) {
    return {
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
    };
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
  return {
    ok: true,
    payload,
    bodyText,
    etag: await strongEtag("pcv1", bodyText),
  };
}
