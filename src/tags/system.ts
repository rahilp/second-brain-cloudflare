// Which tags belong to the brain, and which belong to the person.
//
// The distinction only becomes load-bearing when something *replaces* a
// memory's tags rather than adding to them. Until the editor grew a remove
// control, every write path unioned the new tags onto the old ones, so nothing
// could ever be lost and nothing had to be protected. A replacement can lose
// things, and the things it must not lose are the ones the Worker wrote for
// itself: the classifier's `kind:`, the contradiction pass's `status:`, the
// staleness pass's `volatility:` and `stale:`, and the pipeline's own markers.
// Those are conclusions the brain reached, not labels the user typed, and they
// are not the editor's to delete.
//
// public/utils.js draws the same line for display and for graph clustering, and
// additionally hides machine identifiers (`#5118`, `#fd540a`). That extra rule is
// deliberately absent here: hiding a junk tag costs nothing, but treating it as
// unowned would let an edit silently delete a tag that is genuinely stored.

/** Prompt Capsule bookkeeping prefixes shared by selection and pipeline guards. */
export const CAPSULE_TAG_PREFIX = "capsule:";
export const CAPSULE_SLOT_TAG_PREFIX = "capsule-slot:";

/** Namespaces the Worker writes and owns; `prefix:value` shaped. */
const RESERVED_TAG_PREFIXES = [
  "kind:",
  "status:",
  "volatility:",
  "stale:",
  CAPSULE_TAG_PREFIX,
  CAPSULE_SLOT_TAG_PREFIX,
];

/**
 * Bare markers the Worker writes: compression, pattern mining, dedupe, and the
 * contradiction pass. Keep in step with SYSTEM_TAG_NAMES in public/utils.js.
 *
 * `contradiction-resolved` is written by captureEntry (src/capture/entry.ts) the
 * moment a contradiction is detected, exactly like the rest of these — but it was
 * missing from both this list and the display one, so it rendered as a tag the user
 * had chosen and an edit could delete it.
 */
const PIPELINE_TAG_NAMES = new Set([
  "auto-pattern",
  "auto-insight",
  "synthesized",
  "rolled-up",
  "duplicate-candidate",
  "contradiction-resolved",
]);

/** True when the tag is the brain's own bookkeeping rather than the user's word. */
export function isWorkerOwnedTag(tag: string): boolean {
  if (typeof tag !== "string") return false;
  const t = tag.trim().toLowerCase();
  if (!t) return false;
  if (PIPELINE_TAG_NAMES.has(t)) return true;
  return RESERVED_TAG_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * The tag set a replacement should start from: everything the Worker owns on the
 * entry today, with the caller's tags layered on top.
 *
 * Callers pass only the tags a person can see and edit, so anything they omit
 * was either removed on purpose or was never theirs to send.
 */
export function applyTagReplacement(existing: string[], replacement: string[]): string[] {
  const kept = existing.filter(isWorkerOwnedTag);
  return [...kept, ...replacement.map((t) => t.trim()).filter(Boolean)];
}
