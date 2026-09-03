// What counts as material worth reasoning about.
//
// Deliberately principled rather than fitted. It excludes categories — machine
// authorship, deprecation, integration-mirrored records, entries with nothing
// but system tags — and it does NOT pattern-match content such as "PR merged:".
// A content filter tuned to one brain's scheduled routines fixes that brain and
// no other, and the real question (whether routines should write memories at
// all) belongs to the input-quality spec that follows this one. The accepted
// consequence is that a brain full of automated report exhaust still yields some
// junk candidates until that work lands.
import { isReservedTag } from "../compression/eligibility";
import { MIRRORED_SOURCES, TRANSCRIPT_SOURCES } from "../constants";

/** Below this an entry cannot carry an idea two memories apart. */
export const MIN_INSIGHT_CONTENT_CHARS = 80;

/**
 * Sources that mirror an external system rather than record a thought.
 *
 * This was a second hand-written list and it had fallen three providers behind —
 * every calendar source was missing, so calendar records were reasoned over as
 * though a person had written them. One list now, in `constants.ts`, guarded by
 * a registry-coverage test.
 */
export const INTEGRATION_SOURCES = MIRRORED_SOURCES;

/** Written by the brain about itself. Reasoning over these compounds drift. */
const MACHINE_TAGS = new Set(["synthesized", "auto-pattern", "auto-insight"]);

/** Bookkeeping tags that mark an entry's role rather than its subject. */
const BOOKKEEPING_TAGS = new Set([
  "rolled-up", "duplicate-candidate", "contradiction-resolved",
]);

/**
 * Tags this template's own instructions mandate on nearly every entry.
 *
 * Derived from AI_Instructions/*.md — update both together. Two entries sharing
 * one of these have not been shown to share a subject, so they cannot be used to
 * decide whether a pair is cross-topic.
 */
export const AXIS_TAGS: ReadonlySet<string> = new Set([
  "personal", "work", "task", "idea", "context", "claude-response", "codex-response", "cursor-response",
]);

/**
 * The axis tags that name an assistant as the author rather than a subject.
 *
 * A subset of AXIS_TAGS rather than its own list: both come from
 * AI_Instructions/*.md, and two hand-written copies of one fact is how
 * INTEGRATION_SOURCES fell three providers behind its registry.
 */
export const ASSISTANT_TAGS: ReadonlySet<string> = new Set(
  [...AXIS_TAGS].filter(t => t.endsWith("-response")),
);

export function isAssistantAuthored(tags: string[]): boolean {
  return tags.some(t => ASSISTANT_TAGS.has(t.toLowerCase()));
}

export function topicTagsOf(tags: string[]): Set<string> {
  return new Set(
    tags.filter(t => {
      const lower = t.toLowerCase();
      return !isReservedTag(t)
        && !MACHINE_TAGS.has(lower)
        && !BOOKKEEPING_TAGS.has(lower)
        && !AXIS_TAGS.has(lower);
    }),
  );
}

export function isInsightEligible(
  entry: { content: string; tags: string[]; source: string },
): boolean {
  if (entry.content.trim().length < MIN_INSIGHT_CONTENT_CHARS) return false;
  if (INTEGRATION_SOURCES.has(entry.source) || TRANSCRIPT_SOURCES.has(entry.source)) return false;

  const lower = entry.tags.map(t => t.toLowerCase());
  if (lower.some(t => MACHINE_TAGS.has(t))) return false;
  if (lower.includes("status:deprecated")) return false;

  // An entry whose every tag is system-owned has no subject of its own, so
  // there is nothing for the reasoning step to relate it to.
  return entry.tags.some(t => !isReservedTag(t));
}
