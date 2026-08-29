// The insight review queue, in one predicate.
//
// The weekly insight pass proposes observations it drew from two memories, and
// they are excluded from recall until a human confirms them. Dismissing one
// deprecates it rather than deleting it — the audit row stays, tags and all —
// so an entry carries `auto-insight` forever whether or not it was ever ruled
// on. The tag alone is a history, not a queue.
//
// Reading it as a queue is what broke the dashboard's panel under the previous
// producer: it asked for the newest twenty rows and dropped the deprecated ones
// in the browser, so on a brain with more than a page of dismissals it threw
// away every row it fetched and rendered empty while real proposals waited
// behind them. Whoever asks "what still needs a decision?" needs both halves,
// which is why they live here together.

/** Proposed by the weekly insight pass, and not yet ruled on. */
export const PENDING_INSIGHT_SQL = `tags LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%'`;

/**
 * Every insight the pass has ever written, whatever the reviewer did with it.
 *
 * The novelty floor reads this, and it cannot read PENDING_INSIGHT_SQL: that
 * window empties as fast as the queue is reviewed. Measured on a real brain the
 * day the floor shipped — zero unreviewed insights, so zero comparisons, so a
 * guard that could not fire. A reviewer who keeps up was switching it off.
 *
 * Two clauses because a reviewed insight leaves by one of two different doors.
 * Dismiss keeps `auto-insight` and adds `status:deprecated`. Confirm STRIPS
 * `auto-insight` outright — that removal is what makes the entry recallable —
 * so a confirmed insight carries no tag saying it ever was one. What it does
 * carry is the `drawn_from` edges it is the source of, which is the only marker
 * that survives confirmation.
 *
 * Both matter, and confirmed matters most: it is a real recallable memory now,
 * so restating it is duplication rather than noise.
 */
export const WRITTEN_INSIGHT_SQL =
  // scope-exempt: SQL fragment: WRITTEN_INSIGHT_SQL is always composed with the caller's scope clause by its consumers
  `(tags LIKE '%"auto-insight"%' OR id IN (SELECT source_id FROM edges WHERE type = 'drawn_from'))`;
