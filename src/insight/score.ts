// How a candidate pair earns its place in the weekly budget.
//
// Every term here answers something measured on a real brain rather than a
// preference.
import { topicTagsOf } from "./eligibility";

/** Below this two entries are not about the same thing. */
export const MIN_SIMILARITY = 0.80;

/** Below this the pair is one thought written twice, not a position that moved. */
export const MIN_GAP_MS = 30 * 86400000;

export interface ScorableEntry {
  id: string;
  tags: string[];
  importance: number;
  createdAt: number;
}

/**
 * Order a pair so it is the same pair whichever side was written first.
 *
 * Without this the UNIQUE(a_id, b_id) constraint admits (a,b) and (b,a) as two
 * rows, and the pair is reasoned about — and paid for — twice.
 */
export function normalisePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

const hasStateVolatility = (tags: string[]) =>
  tags.some(t => t.toLowerCase() === "volatility:state");

export function scoreCandidate(a: ScorableEntry, b: ScorableEntry, similarity: number): number {
  const gapDays = Math.abs(b.createdAt - a.createdAt) / 86400000;

  // Compression excludes importance >= 4 outright, so 34% of measured candidates
  // touch an entry it can never see. This is the correction.
  const importanceBoost = 1 + 0.1 * Math.max(a.importance, b.importance);

  // Unlikely connections were 24 of 316 measured candidates. Same-topic pairs
  // score higher on raw similarity by construction, so without a thumb on the
  // scale the cross-topic shape never survives a top-3 cut.
  const shared = [...topicTagsOf(a.tags)].some(t => topicTagsOf(b.tags).has(t));
  const crossTagBonus = shared ? 1.0 : 1.25;

  // Two snapshots of the same quantity on different dates are the most
  // self-similar things in any brain, so they win a naive ranking every week
  // while saying nothing. Both sides must be stateful: a measurement paired
  // with a decision about it is exactly the pair worth surfacing.
  const statePenalty = hasStateVolatility(a.tags) && hasStateVolatility(b.tags) ? 0.4 : 1.0;

  return similarity * Math.log1p(gapDays) * importanceBoost * crossTagBonus * statePenalty;
}
