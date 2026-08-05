/**
 * The brain's tag vocabulary, cached in KV (#288).
 *
 * `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value` is
 * the only way to ask SQLite which tags exist, and it is a full table scan expanded
 * once per tag per row. Measured on workerd D1 at four tags an entry: 9,000 rows
 * read at 1,000 entries, 45,000 at 5,000, 180,000 at 20,000. `inferQueryTags` ran
 * it on every recall — 82% of a recall's read cost — which put a 5,000-memory brain
 * at 90 recalls before D1's free 5M rows/day, and once that is spent every D1 query
 * on the account fails until 00:00 UTC. The MCP clients this project ships
 * instructions for recall at the start of every conversation and every few messages
 * after, so 90 is an ordinary day rather than a stress test.
 *
 * Nothing makes that SQL cheaper. DISTINCT with ORDER BY cannot know its first row
 * until it has visited the last one. Checked on real SQLite at 5,000 entries: with
 * ORDER BY, without it, as a GROUP BY, and with a LIMIT 50 on either — and with an
 * index on `tags` present — every variant plans identically, `SCAN entries` then
 * `SCAN json_each` into a temp b-tree. The only saving available is not running it.
 *
 * WHY ITS OWN KEY, rather than riding along in `config:overrides`, which recall
 * already reads through `resolveConfig`:
 *
 *  - `writeOverrides` serialises the whole blob from `readOverrides`, and
 *    `readOverrides` drops every key that is not a known setting. A vocabulary
 *    parked in that blob would be deleted the first time the user saved a setting,
 *    and keeping it would mean teaching the settings write path to preserve data it
 *    does not own.
 *  - The KV read is not an extra one anyway. `inferQueryTags` already spent exactly
 *    one subrequest on the scan; a KV get in its place is subrequest-neutral, and it
 *    moves the cost off the budget this issue is about — D1 rows read, metered and
 *    account-fatal — onto KV reads, which are a separate quota, edge-cached, and
 *    constant in the size of the brain.
 *  - Capture writes this key; the settings UI writes that one. One blob with two
 *    independent writers is a lost update waiting to happen.
 *
 * WHY IT IS ONLY EVER STALE, NEVER WRONG. Both consumers degrade rather than
 * mislead. `inferQueryTags` feeds a ranking boost (`TAG_BOOST_STEP`, applied in
 * rerankWithTimeDecay), so a tag missing from the vocabulary costs one call a nudge
 * in its ordering, and a tag that no longer exists boosts nothing because no entry
 * carries it. `GET /tags` fills the dashboard's filter dropdown. Neither can return
 * a wrong memory, and neither may fail: every path below falls back to the last good
 * value, and finally to no vocabulary at all — which is the pre-cache behaviour of
 * an empty brain, not an error.
 */
import type { Env } from "../env";

// Prefixed to coexist with workers-oauth-provider's token:/grant:/client: keys,
// config:overrides, and the integrations: blobs in the same namespace.
export const TAG_VOCABULARY_KEY = "tags:vocabulary";

/**
 * How long a scanned vocabulary is trusted before it is rebuilt.
 *
 * The rebuild *is* the scan this cache exists to avoid, so its frequency is the
 * residual cost: once a day is 180,000 rows on a 20,000-entry brain — 3.6% of the
 * free daily budget, against 22 recalls' worth of budget before. An hour would be
 * 4.3M rows a day and would have solved nothing.
 *
 * A day is affordable because nothing time-critical depends on it. Write-through
 * (`rememberTags`) admits a newly captured tag immediately, so the age limit only
 * has to cover the two things write-through cannot: pruning a tag whose last entry
 * was deleted, and admitting the tags background jobs write — `status:`, `kind:`,
 * `volatility:`, `stale:as-of`, `synthesized`, `rolled-up`, `auto-pattern`. Those
 * are a closed set fixed at compile time, query inference excludes them on purpose
 * (see `inferQueryTags`), and the only place they surface is a dropdown.
 */
export const TAG_VOCABULARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * `rebuiltAt` is when the vocabulary was last reconciled against D1 — not when it
 * was last written. `rememberTags` deliberately leaves it alone; see there.
 */
interface CachedVocabulary {
  tags: string[];
  rebuiltAt: number;
}

/** Any failure reads as "nothing cached", which costs a scan rather than a request. */
async function readCache(env: Env): Promise<CachedVocabulary | null> {
  try {
    const raw = await env.OAUTH_KV.get(TAG_VOCABULARY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { tags, rebuiltAt } = parsed as Record<string, unknown>;
    if (!Array.isArray(tags)) return null;
    return {
      tags: tags.filter((t): t is string => typeof t === "string"),
      // A missing or unusable timestamp reads as "never reconciled", so the value
      // is still served and a rebuild is still scheduled.
      rebuiltAt: typeof rebuiltAt === "number" && Number.isFinite(rebuiltAt) ? rebuiltAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The scan, kept verbatim from the two call sites it replaces so that what is
 * cached is exactly what `GET /tags` has always returned.
 */
async function scanTagVocabulary(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
  ).all();
  return (results as { value: unknown }[]).map(r => r.value).filter((v): v is string => typeof v === "string");
}

/**
 * Scan and store. Throws only if the scan does — a KV write failure still returns
 * the fresh vocabulary, because the caller asked what the tags are, not where they
 * are kept.
 */
async function rebuildTagVocabulary(env: Env): Promise<string[]> {
  const tags = await scanTagVocabulary(env);
  try {
    await env.OAUTH_KV.put(TAG_VOCABULARY_KEY, JSON.stringify({ tags, rebuiltAt: Date.now() } satisfies CachedVocabulary));
  } catch (e) {
    console.error("Tag vocabulary cache write failed (non-fatal):", e);
  }
  return tags;
}

/**
 * The read path. One KV get in the steady state and no D1 rows at all.
 *
 * Pass `ctx` wherever there is one. It decides what happens to an aged-out
 * vocabulary: with a ctx the stale list is served and the rebuild runs behind the
 * response, which is the whole point of the cache; without one there is nowhere to
 * hang the work, so it runs inline.
 *
 * With nothing cached at all — a brain's first request, or KV having lost the key —
 * the scan runs inline whoever is asking. That is once per brain rather than once
 * per recall, it is bounded by what every recall used to cost, and it keeps the two
 * consumers honest: an empty answer from `GET /tags` is not a degraded answer, it is
 * a wrong one. If the scan fails too, the last good value is used, and failing that
 * an empty vocabulary — a boost not applied and a dropdown short of options, never a
 * failed request.
 *
 * If KV is unavailable entirely, every call lands here with nothing cached and
 * rebuilds: the pre-cache cost, exactly, and not a byte worse.
 *
 * Not single-flighted. Two requests that both find the vocabulary aged out before
 * either refresh lands will each scan. The window is one scan wide and opens once a
 * day, against a brain that recalls a few hundred times a day — so the collision is
 * rare and its cost is one extra scan, which is what every recall used to cost. Add
 * an isolate-scoped guard if that ever shows up in a bill, not before.
 */
export async function getTagVocabulary(env: Env, ctx?: ExecutionContext): Promise<string[]> {
  const cached = await readCache(env);

  if (cached && Date.now() - cached.rebuiltAt < TAG_VOCABULARY_MAX_AGE_MS) return cached.tags;

  if (cached && ctx) {
    ctx.waitUntil(
      rebuildTagVocabulary(env).catch(e => console.error("Tag vocabulary rebuild failed (non-fatal):", e))
    );
    return cached.tags;
  }

  try {
    return await rebuildTagVocabulary(env);
  } catch (e) {
    console.error("Tag vocabulary rebuild failed (non-fatal):", e);
    return cached?.tags ?? [];
  }
}

/**
 * Write-through: union tags that have just been written into the cached vocabulary,
 * so a tag is inferable on the next recall rather than on the next rebuild.
 *
 * Called from the three places a tag string not known at compile time can enter the
 * corpus — `captureEntry`, `POST /update`'s hashtag merge, and the integrations
 * mirror. Every other writer of `entries.tags` (classification, `POST /status`, the
 * compression pass, the staleness pass, the admin backfills) emits from a closed set
 * of system tags, which query inference filters out anyway and which the age limit
 * admits to the dropdown. That boundary is why this is three call sites rather than
 * sixteen, each of which would be a chance to forget one.
 *
 * Costs one KV get, and a put only when a tag is genuinely new — so an established
 * brain pays nothing to capture into a tag it already has. Does nothing when there
 * is no cache yet: the entry row is already committed by the time this runs, so the
 * scan that builds the first cache will find the tag by itself.
 *
 * Never throws, and never advances `rebuiltAt`: that field records the last
 * reconciliation against D1, and moving it here would let an actively used brain
 * postpone its rebuild forever, so a deleted tag would never be pruned.
 *
 * A rebuild running concurrently can overwrite an addition made here — it scanned
 * before the insert and writes after it. The cost is one tag missing its boost until
 * the next capture or rebuild, which is the same degradation as every other path.
 */
export async function rememberTags(env: Env, tags: string[]): Promise<void> {
  try {
    const cached = await readCache(env);
    if (!cached) return;

    const merged = new Set(cached.tags);
    const before = merged.size;
    for (const tag of tags) if (typeof tag === "string" && tag) merged.add(tag);
    if (merged.size === before) return;

    // Sorted to match the scan's ORDER BY, so /tags stays ordered however the
    // vocabulary was last written.
    await env.OAUTH_KV.put(
      TAG_VOCABULARY_KEY,
      JSON.stringify({ tags: [...merged].sort(), rebuiltAt: cached.rebuiltAt } satisfies CachedVocabulary)
    );
  } catch (e) {
    console.error("Tag vocabulary write-through failed (non-fatal):", e);
  }
}
