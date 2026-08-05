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
 * No rewrite of that SQL makes it sub-linear. It has to visit every row before it can
 * know the first one, and on real SQLite every variant plans identically — with
 * ORDER BY, without it, as a GROUP BY, with a LIMIT, and with an index on `tags`
 * present: `SCAN entries`, `SCAN json_each`, temp b-tree, every time. So the fix is
 * not running it per recall.
 *
 * Identical plans are not identical costs, though, and `scanTagVocabulary` takes the
 * one saving that is available: dropping `ORDER BY value` is 44% off the rows read,
 * because DISTINCT already builds a temp b-tree and ordering makes SQLite walk it
 * back out. See there.
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
 * residual cost: once a day is 100,000 rows on a 20,000-entry brain — 2% of the free
 * daily budget, against 22 recalls' worth of budget before. An hour would be 2.4M
 * rows a day and would have solved nothing.
 *
 * A day is affordable because nothing time-critical depends on it. Write-through
 * (`rememberTags`) admits a newly captured tag once its deferred write settles, so
 * the age limit only has to cover the three things write-through cannot: pruning a
 * tag whose last entry was deleted, admitting the tags background jobs write —
 * `status:`, `kind:`, `volatility:`, `stale:as-of`, `synthesized`, `rolled-up`,
 * `auto-pattern` — and repairing an addition a concurrent rebuild overwrote. The
 * system tags are a closed set fixed at compile time, query inference excludes them
 * on purpose (see `inferQueryTags`), and the only place they surface is a dropdown.
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
      // A missing or unusable timestamp reads as "never reconciled" — 0 — so the value
      // is still served and a rebuild is still scheduled. A timestamp in the future is
      // unusable in exactly that sense: nothing can have been reconciled at a moment
      // that has not happened.
      //
      // It has to be rejected rather than clamped to now, which is the tempting
      // one-liner and does not work. The freshness test is `now - rebuiltAt < MAX_AGE`,
      // so every future timestamp passes it; clamping to `Date.now()` re-anchors on
      // each read, so the value passes again a day later, and again — a blob dated next
      // year, or carrying Number.MAX_SAFE_INTEGER, is served forever. No rebuild is
      // ever scheduled, so nothing can correct it, and a tag deleted from the brain
      // stays in the dropdown for good. Clock skew between the writing isolate and the
      // reading one can produce one; a hand-edited value certainly can.
      //
      // Rejecting costs at most one scan and then converges: the rebuild writes the
      // *reading* isolate's clock, so the slowest clock involved wins and every later
      // read sees a past timestamp. There is no oscillation to trade off against.
      rebuiltAt:
        typeof rebuiltAt === "number" && Number.isFinite(rebuiltAt) && rebuiltAt <= Date.now()
          ? rebuiltAt
          : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The scan. This is now the whole residual D1 cost of the cache, paid once a day and
 * on every cold read, so the `ORDER BY value` the two replaced call sites carried is
 * gone — sorted in JS instead.
 *
 * That is not a plan improvement; every variant of this query plans identically
 * (`SCAN entries`, `SCAN json_each`, temp b-tree, with or without ORDER BY, as a
 * GROUP BY, with a LIMIT, with an index on `tags`). It is a rows-read improvement,
 * and the plan is why the two are not the same thing: DISTINCT already needs a temp
 * b-tree, and asking for it ordered as well makes SQLite walk that b-tree back out.
 * Measured on workerd D1: 45,000 rows against 25,000 at 5,000 entries, 180,000
 * against 100,000 at 20,000 — 44% off, for identical results.
 *
 * Free because the sort had to happen in JS anyway: `rememberTags` re-sorts whatever
 * it writes back, so SQLite's ordering never survived a write-through in the first
 * place. One caveat, unchanged by this: SQLite's BINARY collation orders UTF-8 bytes
 * and JS orders UTF-16 code units, which differ only for astral-plane characters. A
 * tag containing one could sit in a different dropdown position than it used to.
 */
async function scanTagVocabulary(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT value FROM entries, json_each(entries.tags)`
  ).all();
  return (results as { value: unknown }[])
    .map(r => r.value)
    .filter((v): v is string => typeof v === "string")
    .sort();
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
 * so a new tag is admitted on the next read after this settles rather than having to
 * wait for the next rebuild.
 *
 * "After this settles" is the honest bound, not "immediately". Both request-path
 * callers defer it to `ctx.waitUntil`, which runs after the response, and KV needs a
 * moment to propagate on top of that — so a dashboard that captures and then reloads
 * `GET /tags` (`public/js/memory-crud.js`, and four other `loadTags()` call sites)
 * can miss a hashtag it just saved and pick it up on the next load. Before this cache
 * that route read D1 and always saw the committed row. The window is a dropdown
 * option arriving one refresh late; it closes by itself.
 *
 * `captureEntry` and `POST /update`'s hashtag merge are the only two writers of
 * `entries.tags` that can introduce a string not known at compile time. Every other
 * one — classification, `POST /status`, the compression pass, the staleness pass, the
 * admin backfills, and the integrations mirror, whose tags are provider ids from a
 * compile-time registry — emits from a closed set, which query inference filters out
 * anyway and which the age limit admits to the dropdown by itself. The mirror calls
 * this too, but for promptness rather than correctness: without it a freshly
 * connected integration is missing from the tag filter until the next rebuild.
 *
 * Costs one KV get; the put and a second get happen only when a tag is genuinely new,
 * so an established brain pays one get to capture into a tag it already has. Does
 * nothing when there is no cache yet: the entry row is already committed by the time
 * this runs, so the scan that builds the first cache will find the tag by itself.
 *
 * Never throws, and never advances `rebuiltAt` past what it read: that field records
 * the last reconciliation against D1, and moving it forward here would let an
 * actively used brain postpone its rebuild forever, so a deleted tag would never be
 * pruned.
 */
export async function rememberTags(env: Env, tags: string[]): Promise<void> {
  try {
    const cached = await readCache(env);
    if (!cached) return;

    const known = new Set(cached.tags);
    const additions = tags.filter(t => typeof t === "string" && t && !known.has(t));
    if (!additions.length) return;

    // Re-read immediately before writing, and merge onto whatever is there now.
    //
    // This races a rebuild in both directions. A rebuild that scanned before the row
    // was committed and puts after this one wins, and the addition is lost until the
    // next capture — that is the documented degradation, a tag missing its boost.
    // The other direction is the one worth spending a KV get on: if a rebuild landed
    // between the read above and this put, writing back the *older* `rebuiltAt` would
    // age the cache out again and buy a second full scan, and writing back the older
    // tag list would resurrect tags that rebuild had just pruned. Reading again
    // narrows both windows to the put itself — KV has no compare-and-set, so they
    // cannot be closed, and the residual cost is one scan, which is what every recall
    // used to cost.
    const latest = (await readCache(env)) ?? cached;
    const merged = new Set(latest.tags);
    for (const tag of additions) merged.add(tag);
    if (merged.size === latest.tags.length) return;

    await env.OAUTH_KV.put(
      TAG_VOCABULARY_KEY,
      JSON.stringify({
        tags: [...merged].sort(),
        rebuiltAt: Math.max(cached.rebuiltAt, latest.rebuiltAt),
      } satisfies CachedVocabulary)
    );
  } catch (e) {
    console.error("Tag vocabulary write-through failed (non-fatal):", e);
  }
}
