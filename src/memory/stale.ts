import { withoutVolatility } from "./volatility";

export const STALE_AS_OF = "stale:as-of";

export function hasStaleAsOf(tags: string[]): boolean {
  return tags.includes(STALE_AS_OF);
}

export function withStaleAsOf(tags: string[]): string[] {
  if (tags.includes(STALE_AS_OF)) return tags;
  return [...tags, STALE_AS_OF];
}

export function withoutStaleAsOf(tags: string[]): string[] {
  return tags.filter(t => t !== STALE_AS_OF);
}

/** Strip staleness/volatility system tags after a content-changing write. */
export function tagsAfterWrite(tags: string[]): string[] {
  return withoutVolatility(withoutStaleAsOf(tags));
}

/**
 * Tag treatment for an append, which keeps the original content and adds to it.
 *
 * The as-of qualifier clears because updated_at moves and it would otherwise report a
 * date this entry no longer has. The volatility verdict is kept, because it describes a
 * fact that is still present in the body — the same reasoning that keeps `rolled-up` on
 * an append and drops it on a replacement (see capture/store.ts).
 *
 * Stripping it here would also make the verdict depend on how a memory was edited rather
 * than on what it says: the same fact would be classified or not according to whether the
 * user appended to it, a distinction the user never made. Recovery is not prompt either,
 * because the pass reconsiders a row only once it has gone untouched past the age gate,
 * and an append resets that clock.
 */
export function tagsAfterAppend(tags: string[]): string[] {
  return withoutStaleAsOf(tags);
}

export function formatAsOfQualifier(updatedAt: number): string {
  const date = new Date(updatedAt).toLocaleDateString();
  return `true as of ${date}, verify before asserting`;
}
