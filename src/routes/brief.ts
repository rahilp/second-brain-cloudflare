import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { STALE_REVIEW_SQL } from "../memory/stale";

/**
 * GET /brief — what the brain did while you were away.
 *
 * The dashboard used to open on an empty screen with a text box, on a brain
 * holding thousands of memories that four nightly jobs had spent the night
 * compressing, linking and judging. Everything below is already-produced work
 * being read back; nothing here computes, embeds, or calls a model.
 *
 * BUDGET. Six D1 queries, no AI, no Vectorize, and one HTTP round trip
 * because the alternative — the client asking six endpoints — spends six of
 * the ~50 subrequests a free-plan invocation gets, on every app open. Each
 * query is either indexed (created_at DESC) or bounded by a small LIMIT. The
 * count is pinned by test/integration/brief-budget.test.ts, and that pin is
 * the point: this endpoint is the one thing every user runs every time.
 */

/** Yesterday and today, so an early-morning open still has something to show. */
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Two weeks of activity: enough to show a rhythm, short enough to read. */
const ACTIVITY_DAYS = 14;

/** What the brain has been about lately, rather than all-time. */
const TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Old enough that resurfacing it is a genuine reminder rather than an echo. */
const RESURFACE_MIN_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** Below this, a memory is not worth interrupting someone with. */
const RESURFACE_MIN_IMPORTANCE = 3;

/**
 * Candidates worth resurfacing, written once so the row query and the count it
 * wraps against cannot drift apart — if they did, the offset would index into
 * a different set than the one being selected from.
 */
const RESURFACE_FILTER = `created_at < ? AND importance_score >= ?
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"auto-pattern"%'
         AND tags NOT LIKE '%"auto-insight"%'
         AND tags NOT LIKE '%"synthesized"%'`;

export async function handleBriefRoutes(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (url.pathname !== "/brief" || request.method !== "GET") return null;

  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  // Every panel below reads only what this caller can see: their personal
  // workspace plus the company one. The clauses bind positionally, so each
  // query's bindings below carry them in statement order.
  const scope = scopeWhere(auth);
  const entryScope = scopeWhere(auth, undefined, "entries.workspace_id");

  const now = Date.now();
  const since = now - RECENT_WINDOW_MS;
  const resurfaceBefore = now - RESURFACE_MIN_AGE_MS;

  const [recentRows, patternRows, resurfaceRows, activityRows, topicRows, attentionRow] = await Promise.all([
    // What arrived, and from where. Grouped rather than listed: the point is
    // "your brain grew, from these places", not another feed of rows.
    env.DB.prepare(
      `SELECT source, COUNT(*) AS n FROM entries
       WHERE created_at >= ? AND ${scope.clause} GROUP BY source ORDER BY n DESC`,
    ).bind(since, ...scope.bindings).all(),

    // Insights the weekly pass proposed and nobody has ruled on. These are
    // excluded from recall until confirmed, so leaving them unseen in a menu
    // is the same as throwing them away.
    env.DB.prepare(
      `SELECT id, content FROM entries
       WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
       ORDER BY created_at DESC LIMIT 3`,
    ).bind(...scope.bindings).all(),

    // One old, important memory. There is no last-recalled column and adding
    // one is not worth a migration for this, so the pick is deterministic per
    // day: the same memory all day, a different one tomorrow. Ordering by id
    // keeps it stable regardless of what else is written today.
    //
    // The offset wraps inside SQL against a count of the same candidate set.
    // Taking the day number modulo a constant instead looks equivalent and is
    // not: OFFSET past the end returns no rows, so any brain with fewer
    // candidates than the constant would silently show nothing on most days.
    // MAX(…, 1) keeps the modulo defined when there are no candidates at all.
    // Positional placeholders, so the filter is bound twice — once for the row
    // and once for the count it wraps against. Numbered (?1) parameters would
    // say it once but are not what the rest of this codebase or its SQLite
    // test double use.
    env.DB.prepare(
      `SELECT id, content, created_at FROM entries
       WHERE (${RESURFACE_FILTER}) AND ${scope.clause}
       ORDER BY id
       LIMIT 1
       OFFSET (? % MAX((SELECT COUNT(*) FROM entries WHERE (${RESURFACE_FILTER}) AND ${scope.clause}), 1))`,
    ).bind(
      resurfaceBefore, RESURFACE_MIN_IMPORTANCE, ...scope.bindings,
      dayNumber(now),
      resurfaceBefore, RESURFACE_MIN_IMPORTANCE, ...scope.bindings,
    ).all(),

    // Captures per day. Bucketed in SQL rather than by shipping timestamps and
    // grouping in the client, because the row count is the whole point and
    // there is no reason to send two weeks of rows to count them.
    env.DB.prepare(
      `SELECT CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n
       FROM entries WHERE created_at >= ? AND ${scope.clause}
       GROUP BY day ORDER BY day`,
    ).bind(now - ACTIVITY_DAYS * 86400000, ...scope.bindings).all(),

    // What the brain has been about this week, in the user's own vocabulary.
    // Same exclusions as /stats: the reserved namespaces are bookkeeping, and
    // hex-shaped tags are commit SHAs and colour codes a #token scan collected.
    env.DB.prepare(
      `SELECT value AS tag, COUNT(*) AS n FROM entries, json_each(entries.tags)
       WHERE entries.created_at >= ?
         AND value NOT LIKE 'kind:%' AND value NOT LIKE 'status:%'
         AND value NOT LIKE 'volatility:%' AND value NOT LIKE 'stale:%'
         AND value NOT IN ('auto-pattern', 'auto-insight', 'synthesized', 'rolled-up', 'duplicate-candidate')
         AND value NOT GLOB '[0-9]*'
       GROUP BY value ORDER BY n DESC LIMIT 6`,
    ).bind(now - TOPIC_WINDOW_MS).all(),

    // The two things that make recall quietly worse, counted together so they
    // cost one query: memories recall cannot see, and memories the staleness
    // pass has flagged as possibly out of date.
    //
    // Deprecated entries are excluded from BOTH counts, for the same reason in
    // two forms. Their vectors were deleted on purpose — dismissing a pattern is
    // the common way — so counting them as "not searchable" reported the user's
    // own decision back to them as a problem, and grew the number every time they
    // dismissed one. A deprecated memory is likewise retired from recall, so
    // asking anyone to re-verify it is make-work.
    //
    // The stale count shares STALE_REVIEW_SQL with `GET /stale`, the queue this
    // chip opens. They are two readings of one fact: a chip that promises a
    // number the queue then fails to produce is the defect this replaced, and
    // one predicate is what stops it coming back.
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN vector_ids = '[]' AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) AS unindexed,
         SUM(CASE WHEN ${STALE_REVIEW_SQL} THEN 1 ELSE 0 END) AS stale,
         COUNT(*) AS total
       FROM entries WHERE ${scope.clause}`,
    ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
  ]);

  const bySource = (recentRows.results as { source: string | null; n: number }[]).map(r => ({
    source: r.source ?? "unknown",
    count: r.n,
  }));
  const captured = bySource.reduce((sum, r) => sum + r.count, 0);

  const patterns = (patternRows.results as { id: string; content: string }[]).map(r => ({
    id: r.id,
    content: r.content,
  }));

  const resurfaceRow = (resurfaceRows.results as { id: string; content: string; created_at: number }[])[0];

  // Days with no captures are absent from the GROUP BY and have to be filled
  // in, or the strip would silently compress a quiet week into a busy-looking
  // one — the shape of the rhythm is the information.
  const byDay = new Map<number, number>();
  for (const r of activityRows.results as { day: number; n: number }[]) byDay.set(r.day, r.n);
  const today = Math.floor(now / 86400000);
  const activity: { day: number; count: number }[] = [];
  for (let d = today - (ACTIVITY_DAYS - 1); d <= today; d++) {
    activity.push({ day: d, count: byDay.get(d) ?? 0 });
  }

  const topics = (topicRows.results as { tag: string; n: number }[]).map(r => ({ tag: r.tag, count: r.n }));

  return json({
    ok: true,
    window_hours: RECENT_WINDOW_MS / 3600000,
    captured,
    sources: bySource,
    patterns,
    resurface: resurfaceRow
      ? { id: resurfaceRow.id, content: resurfaceRow.content, created_at: resurfaceRow.created_at }
      : null,
    activity,
    topics,
    total: (attentionRow?.total as number) ?? 0,
    attention: {
      unindexed: (attentionRow?.unindexed as number) ?? 0,
      stale: (attentionRow?.stale as number) ?? 0,
      patterns: patterns.length,
    },
  });
}

/** Days since the epoch: changes once a day, stable within it. */
function dayNumber(now: number): number {
  return Math.floor(now / 86400000);
}
