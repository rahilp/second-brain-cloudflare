import type { Env } from "../env";
import { resolveConfig } from "../config";
import { initializeDatabase } from "../db/init";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql, isTopicTagSql } from "./eligibility";
import { compressTag } from "./digest";

/**
 * How many tags one nightly run may compress.
 *
 * This bound is what keeps the cron inside a free-plan invocation, and it is protecting
 * two independent ceilings, not one — raising it needs both re-measured:
 *
 *   - D1 subrequests. All four nightly jobs share a single scheduled() invocation and
 *     therefore one budget. Each compressed tag costs about six.
 *   - CPU. Cron Triggers get 10 ms on the free plan, and the work per tag is linear:
 *     measured 1.6 ms at 7 tags, 9.6 ms at 30, 20.2 ms at 60.
 *
 * Nothing bounded this before: every tag with more than ten eligible entries was
 * compressed on every run, so both costs grew with how many distinct tags a user had.
 */
export const COMPRESSION_MAX_TAGS_PER_RUN = 4;

/** Where the rotation resumes from. Operational state, so KV rather than a tags value. */
const TAG_CURSOR_KEY = "compression:tag-cursor";

/**
 * Pick this run's tags, resuming after the last one processed.
 *
 * Deferring rather than truncating is the whole point: a plain `LIMIT` would compress the
 * same head of the list every night and never reach the tail. The cursor stores a tag NAME
 * rather than an index because the candidate list is re-derived each run and its ordering
 * shifts as entries are rolled up — an index would silently skip whatever moved.
 * An unknown or missing cursor starts from the top, which is also the first-run path.
 */
async function selectTagsForRun(env: Env, tags: string[]): Promise<string[]> {
  if (tags.length <= COMPRESSION_MAX_TAGS_PER_RUN) return tags;

  let start = 0;
  try {
    const last = await env.OAUTH_KV.get(TAG_CURSOR_KEY);
    const at = last ? tags.indexOf(last) : -1;
    if (at >= 0) start = (at + 1) % tags.length;
  } catch (e) {
    console.error("Compression tag cursor read failed; starting from the top (non-fatal):", e);
  }

  const picked = Array.from(
    { length: Math.min(COMPRESSION_MAX_TAGS_PER_RUN, tags.length) },
    (_, i) => tags[(start + i) % tags.length],
  );

  try {
    await env.OAUTH_KV.put(TAG_CURSOR_KEY, picked[picked.length - 1]);
  } catch (e) {
    // A lost cursor repeats this run's tags next time rather than losing any, so it is
    // safe to continue — the 24h guard in compressTag makes the repeat a cheap no-op.
    console.error("Compression tag cursor write failed (non-fatal):", e);
  }
  return picked;
}

export async function runNightlyCompression(env: Env, ctx: ExecutionContext): Promise<void> {
  const cfg = await resolveConfig(env);
  await initializeDatabase(env);

  const { results } = await env.DB.prepare(`
    SELECT value as tag, COUNT(*) as count
    FROM entries, json_each(entries.tags)
    WHERE ${isTopicTagSql()}
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND ${compressionEligibilitySql("entries.", cfg)}
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).bind(Date.now() - cfg.COMPRESSION_MIN_AGE_MS).all();

  const tags = await selectTagsForRun(env, results.map(r => r.tag as string));

  for (const tag of tags) {
    try {
      await compressTag(tag, env, ctx);
    } catch (e) {
      console.error(`Compression failed for tag "${tag}" (non-fatal):`, e);
    }
  }
}
