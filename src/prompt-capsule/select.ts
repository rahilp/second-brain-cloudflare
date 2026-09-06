import {
  CAPSULE_SLOT_TAG_PREFIX,
  capsuleTag,
  slotsForKind,
  type PromptCapsuleCandidate,
  type PromptCapsuleInvalidEntry,
  type PromptCapsuleKind,
  type PromptCapsuleSection,
  type PromptCapsuleSelection,
  type PromptCapsuleSlot,
} from "./types";
import { CAPSULE_TAG_PREFIX } from "../tags/system";

function normalizedTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== "string")) return null;
  // Lowercase only: the SQL prefilter does not trim, so neither may this.
  return value.map(tag => tag.toLowerCase()).filter(Boolean);
}

function canonicalStatus(tags: string[]): "canonical" | "ignore" | "invalid" {
  const statuses = tags.filter(tag => tag.startsWith("status:"));
  if (!statuses.length) return "ignore";
  if (statuses.length !== 1) return "invalid";
  return statuses[0] === "status:canonical" ? "canonical" : "ignore";
}

function capsuleNamespaceTags(tags: string[]): string[] {
  return tags.filter(tag => tag.startsWith(CAPSULE_TAG_PREFIX));
}

/**
 * Select the one canonical entry allowed in each fixed capsule slot.
 *
 * The caller has already bounded the D1 candidate set. This function is pure:
 * it performs no reads, writes, time lookups, ranking, or summarization. Draft
 * and deprecated candidates are intentionally ignored; malformed canonical
 * definitions are reported instead of being guessed around.
 */
export function selectPromptCapsuleEntries(
  kind: PromptCapsuleKind,
  candidates: readonly PromptCapsuleCandidate[],
  projectId?: string,
): PromptCapsuleSelection {
  const requiredBaseTag = capsuleTag(kind, projectId);
  const orderedSlots = slotsForKind(kind);
  const allowedSlots = new Set<string>(orderedSlots);
  const bySlot = new Map<PromptCapsuleSlot, PromptCapsuleSection[]>();
  const invalidEntries: PromptCapsuleInvalidEntry[] = [];

  for (const candidate of candidates) {
    const tags = normalizedTags(candidate.tags);
    if (!tags) {
      invalidEntries.push({ entryId: candidate.id, reason: "malformed-tags" });
      continue;
    }

    // Only canonical rows define a Capsule. Ignore well-formed draft and
    // deprecated rows before validating their namespace or slot so unfinished
    // definitions cannot make the published Capsule unavailable.
    const status = canonicalStatus(tags);
    if (status === "ignore") continue;
    if (status === "invalid") {
      invalidEntries.push({ entryId: candidate.id, reason: "invalid-status" });
      continue;
    }

    const namespaces = capsuleNamespaceTags(tags);
    if (namespaces.length !== 1 || namespaces[0] !== requiredBaseTag) {
      invalidEntries.push({ entryId: candidate.id, reason: "base-tag-mismatch" });
      continue;
    }

    const slotTags = tags.filter(tag => tag.startsWith(CAPSULE_SLOT_TAG_PREFIX));
    const slotValues = slotTags.map(tag => tag.slice(CAPSULE_SLOT_TAG_PREFIX.length));
    if (slotValues.length !== 1 || !allowedSlots.has(slotValues[0])) {
      invalidEntries.push({ entryId: candidate.id, reason: "invalid-slot" });
      continue;
    }

    if (typeof candidate.content !== "string" || !candidate.content.trim()) {
      invalidEntries.push({ entryId: candidate.id, reason: "empty-content" });
      continue;
    }

    const slot = slotValues[0] as PromptCapsuleSlot;
    const section: PromptCapsuleSection = {
      slot,
      sourceEntryId: candidate.id,
      content: candidate.content,
    };
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), section]);
  }

  const duplicateSlots = orderedSlots.flatMap(slot => {
    const entries = bySlot.get(slot) ?? [];
    return entries.length > 1
      ? [{ slot, entryIds: entries.map(entry => entry.sourceEntryId).sort() }]
      : [];
  });

  const sections = orderedSlots.flatMap(slot => {
    const entries = bySlot.get(slot) ?? [];
    return entries.length === 1 ? entries : [];
  });

  return {
    sections,
    invalidEntries: invalidEntries.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0)),
    duplicateSlots,
  };
}
