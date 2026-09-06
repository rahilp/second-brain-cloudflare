import { CAPSULE_SLOT_TAG_PREFIX, CAPSULE_TAG_PREFIX } from "../tags/system";

export { CAPSULE_SLOT_TAG_PREFIX };

export const PROMPT_CAPSULE_SCHEMA = "prompt-capsule.v1" as const;
export const PROMPT_CAPSULE_MCP_SCHEMA = "prompt-capsule-mcp.v1" as const;
export const PROMPT_CAPSULE_MIME = "application/vnd.second-brain.prompt-capsule+json";
export const PROMPT_CAPSULE_MAX_CHARS = 12_000;
export const PROMPT_CAPSULE_MAX_CANDIDATES = 200;
export const PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS = 256;
// Tags are metadata, not prompt content. Bound the D1 projection so a malformed
// or directly inserted row cannot make a capsule read consume Worker memory in
// proportion to D1's per-row limit.
export const PROMPT_CAPSULE_MAX_TAG_CHARS = 16_384;

export const CAPSULE_CORE_TAG = `${CAPSULE_TAG_PREFIX}core`;
export const CAPSULE_PROJECT_TAG_PREFIX = `${CAPSULE_TAG_PREFIX}project:`;

export const CORE_CAPSULE_SLOTS = [
  "identity",
  "preferences",
  "constraints",
  "principles",
] as const;

export const PROJECT_CAPSULE_SLOTS = [
  "current-state",
  "decisions",
  "open-questions",
] as const;

export type PromptCapsuleKind = "core" | "project";
export type CoreCapsuleSlot = typeof CORE_CAPSULE_SLOTS[number];
export type ProjectCapsuleSlot = typeof PROJECT_CAPSULE_SLOTS[number];
export type PromptCapsuleSlot = CoreCapsuleSlot | ProjectCapsuleSlot;

export interface PromptCapsuleCandidate {
  id: string;
  content: unknown;
  tags: unknown;
}

export interface PromptCapsuleSection {
  slot: PromptCapsuleSlot;
  sourceEntryId: string;
  content: string;
}

export interface PromptCapsuleInvalidEntry {
  entryId: string;
  reason:
    | "malformed-tags"
    | "base-tag-mismatch"
    | "invalid-status"
    | "invalid-slot"
    | "empty-content"
    | "content-too-large";
}

export interface PromptCapsuleDuplicateSlot {
  slot: PromptCapsuleSlot;
  entryIds: string[];
}

export interface PromptCapsuleSelection {
  sections: PromptCapsuleSection[];
  invalidEntries: PromptCapsuleInvalidEntry[];
  duplicateSlots: PromptCapsuleDuplicateSlot[];
}

export interface SerializedPromptCapsule {
  text: string;
  sections: PromptCapsuleSection[];
  omittedSlots: PromptCapsuleSlot[];
  complete: boolean;
  charCount: number;
  maxChars: number;
}

export function capsuleTag(kind: PromptCapsuleKind, projectId?: string): string {
  if (kind === "core") return CAPSULE_CORE_TAG;
  if (!projectId) throw new TypeError("projectId is required for a project capsule");
  return `${CAPSULE_PROJECT_TAG_PREFIX}${projectId}`;
}

export function slotsForKind(kind: PromptCapsuleKind): readonly PromptCapsuleSlot[] {
  return kind === "core" ? CORE_CAPSULE_SLOTS : PROJECT_CAPSULE_SLOTS;
}
