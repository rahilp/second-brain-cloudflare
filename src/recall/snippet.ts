/**
 * Recall output sizing (#238).
 *
 * recall used to return the full content of every match with no cap on total
 * size — topK limits the COUNT of results, not their bytes — so one call could
 * return an unbounded payload and blow a client's context window. This module
 * bounds that: return enough to decide, and let the caller fetch the few
 * memories it actually needs in full via the `get` tool.
 *
 * Design notes:
 * - Short memories are returned WHOLE and marked complete. Only oversized ones
 *   are cut, so a consumer does not learn to distrust every result.
 * - The top matches get a much larger allowance than the tail: they are usually
 *   the answer, while the tail is context.
 * - Truncation is marked machine-legibly (with the id and the missing length),
 *   so the affordance to fetch the rest travels with the snippet itself. The
 *   failure mode this guards against is a model treating a cut snippet as the
 *   complete memory and answering confidently from partial text.
 */

// Per-match ceiling for the leading matches. Even a "full" result is capped:
// a single multi-thousand-character memory should never eat the whole budget.
export const FULL_MATCH_MAX_CHARS = 4000;
// Per-match ceiling for everything after the leading matches.
export const SNIPPET_MAX_CHARS = 400;
// How many leading matches may get the larger allowance.
export const RECALL_FULL_MATCHES = 2;
// A match must also be this close to the top score to earn the larger
// allowance. Rank alone is not relevance: when the second result is much weaker
// than the first, spending thousands of characters on it starves the rest.
export const STRONG_MATCH_RATIO = 0.75;
// Ceiling on the whole rendered response, across all matches.
export const RECALL_OUTPUT_BUDGET = 12000;

// `append` writes this separator (see capture/store.ts), so an entry that has
// grown over time is a head followed by dated update blocks.
// Matched with a SINGLE leading newline on purpose: condense() collapses runs
// of blank lines, so the original "\n\n[Update " separator survives as "\n[Update ".
// Searching for the single-newline form finds it in both raw and condensed text.
const UPDATE_MARKER = "\n[Update ";

// Roughly what the truncation note itself costs (it embeds a uuid). Cutting a
// memory that is only slightly over the allowance would spend more characters
// on the note than the cut saves, so those are returned whole instead.
const TRUNCATION_NOTE_COST = 90;

export interface Snippet {
  text: string;
  truncated: boolean;
  fullLength: number;
}

/**
 * Trim `content` to `max` characters on a sentence boundary where possible.
 *
 * For an entry built by `append`, the newest update is usually the relevant
 * part, so a plain head cut would hide exactly what the caller wants. Those
 * entries get head + most recent update instead.
 */
export function snippetOf(
  content: string,
  max: number = SNIPPET_MAX_CHARS,
  opts: { queryTokens?: string[] } = {},
): Snippet {
  const raw = (content ?? "").trim();
  // Truncate only when it actually saves space: a memory barely over the
  // allowance costs more to cut and annotate than to send whole.
  if (raw.length <= max + TRUNCATION_NOTE_COST) {
    return { text: raw, truncated: false, fullLength: raw.length };
  }
  // fullLength stays the STORED size, so the truncation note tells the truth
  // about what get() would return.
  const fullLength = raw.length;
  const full = condense(raw);
  if (full.length <= max) return { text: full, truncated: true, fullLength };

  // The head identifies the memory, so it is always shown.
  const headBudget = Math.max(1, Math.floor(max * 0.6));
  const head = cutOnBoundary(full, headBudget);
  const tailBudget = Math.max(1, max - head.length);

  // What follows the head, in priority order:
  // 1. the passage that best covers the query terms, so a long memory shows the
  //    part the caller actually asked about rather than an arbitrary slice;
  // 2. failing that, the newest [Update …] block, which is the current state of
  //    an entry grown by append.
  const rest = full.slice(head.length);
  const tail = bestMatchWindow(rest, opts.queryTokens ?? [], tailBudget) ?? latestUpdateBlock(full);
  if (!tail) return { text: head, truncated: true, fullLength };

  return { text: `${head}\n…\n${cutOnBoundary(tail, tailBudget)}`, truncated: true, fullLength };
}

// Display-only tidy. Marketing email bodies carry long runs of zero-width
// padding and tracking URLs, which would otherwise consume the whole allowance
// before any readable text appears. The stored memory is untouched; this only
// affects what a preview shows.
function condense(text: string): string {
  return text
    .replace(/&zwnj;|&nbsp;|&#8202;|[​-‏﻿]/g, "")
    .replace(/https?:\/\/\S{60,}/g, "[link]")
    .replace(/[ \t]{3,}/g, " ")
    // HTML-derived bodies are mostly blank layout lines; collapse runs of them.
    .replace(/(?:\n[ \t]*){2,}/g, "\n")
    .trim();
}

// The window of `text` covering the most distinct query terms, or null when the
// query does not appear. Keyword-in-context, the way a search result works.
function bestMatchWindow(text: string, tokens: string[], width: number): string | null {
  if (!tokens.length || !text) return null;
  const hay = text.toLowerCase();

  const hits: { pos: number; token: string }[] = [];
  for (const t of tokens) {
    if (t.length < 3) continue; // very short tokens match noise
    let from = 0;
    while (hits.length < 400) {
      const at = hay.indexOf(t, from);
      if (at === -1) break;
      hits.push({ pos: at, token: t });
      from = at + t.length;
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.pos - b.pos);

  let best = { start: hits[0].pos, score: 0 };
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].pos;
    const distinct = new Set<string>();
    for (let j = i; j < hits.length && hits[j].pos < start + width; j++) distinct.add(hits[j].token);
    if (distinct.size > best.score) best = { start, score: distinct.size };
  }

  // Back up slightly so the match is not flush against the left edge, then drop
  // any partial leading word.
  const start = Math.max(0, best.start - Math.floor(width * 0.15));
  return text.slice(start, start + width).replace(/^\S*\s+/, "");
}

// The most recent `[Update …]` block of an append-grown entry, if any.
function latestUpdateBlock(text: string): string | null {
  const at = text.lastIndexOf(UPDATE_MARKER);
  if (at <= 0) return null;
  return text.slice(at).trim();
}

// Cut at the last sentence end inside the budget, falling back to a word
// boundary, so a snippet never stops mid-word.
function cutOnBoundary(text: string, budget: number): string {
  const t = text.trim();
  if (t.length <= budget) return t;
  const slice = t.slice(0, budget);
  const floor = Math.floor(budget * 0.5); // do not cut back so far that the snippet says nothing
  const sentence = Math.max(
    slice.lastIndexOf(". "), slice.lastIndexOf(".\n"),
    slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf("\n"),
  );
  if (sentence > floor) return slice.slice(0, sentence + 1).trim();
  const space = slice.lastIndexOf(" ");
  return (space > floor ? slice.slice(0, space) : slice).trim();
}

// The marker appended to a cut snippet. Carries the id so the caller can fetch
// the rest without a second lookup.
export function truncationNote(id: string, s: Snippet): string {
  return `\n[truncated · ${s.fullLength.toLocaleString()} chars total · get("${id}") for full text]`;
}

/**
 * Allowance for a match: the leading results are usually the answer, so they
 * get room, but only if they are also strong. `relScore` is the match score
 * relative to the top hit (recall normalizes scores so the top match is 1).
 */
export function allowanceFor(index: number, relScore: number = 1): number {
  return index < RECALL_FULL_MATCHES && relScore >= STRONG_MATCH_RATIO
    ? FULL_MATCH_MAX_CHARS
    : SNIPPET_MAX_CHARS;
}
