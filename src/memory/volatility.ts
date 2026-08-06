export const VOLATILITY_VALUES = ["durable", "state", "volatile"] as const;
export type Volatility = (typeof VOLATILITY_VALUES)[number];
export const VOLATILITY_PREFIX = "volatility:";

// Every match here is case-insensitive, which the rest of the reserved-tag machinery
// already is (isReservedTag lowercases; isTopicTagSql uses a case-insensitive LIKE).
// Matching case-sensitively made this namespace claimable: a caller-supplied tag of
// `Volatility:durable` slipped past the filter in withVolatility, was lowercased
// afterwards by captureEntry, and left the entry carrying two verdicts — with the
// injected one winning, because getVolatility returns the first match. That turned an
// unvalidated string inside `tags[]` into an override for the validated enum.
const isVolatilityTag = (t: string) => t.toLowerCase().startsWith(VOLATILITY_PREFIX);

/**
 * The first *valid* verdict, not the first tag in the namespace. Stopping at the first
 * match and rejecting it made a junk tag able to shadow a real one: `volatility:sometimes`
 * ahead of `volatility:durable` reported the entry as unclassified, which lowered its
 * recall floor and invited the nightly pass to overwrite a verdict a caller had set.
 * Nothing stops a caller writing raw tags in this namespace, so reading has to tolerate it.
 */
export function getVolatility(tags: string[]): Volatility | null {
  for (const tag of tags) {
    if (!isVolatilityTag(tag)) continue;
    const value = tag.slice(VOLATILITY_PREFIX.length).toLowerCase();
    if ((VOLATILITY_VALUES as readonly string[]).includes(value)) return value as Volatility;
  }
  return null;
}

export function withVolatility(tags: string[], volatility: Volatility): string[] {
  const cleaned = tags.filter(t => !isVolatilityTag(t));
  return [...cleaned, `${VOLATILITY_PREFIX}${volatility}`];
}

export function withoutVolatility(tags: string[]): string[] {
  return tags.filter(t => !isVolatilityTag(t));
}
