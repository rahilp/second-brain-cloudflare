/**
 * Matching a single tag inside the JSON `tags` column.
 *
 * Tags are stored as a JSON array, so every reader finds one with `tags LIKE '%"<tag>"%'`.
 * That makes the tag part of a LIKE pattern, where `_` matches any character and `%`
 * matches everything — and a tag is user data. Interpolated raw, the pattern does not
 * select the entries carrying the tag: `q3_planning` also selects `q3-planning`, and `%`
 * selects the whole table.
 *
 * Neither character is exotic. src/text/hashtags.ts matches \w, so writing `#q3_planning`
 * in a memory creates the tag `q3_planning`; the API's tags[] array and the integrations
 * mirror accept any string at all.
 *
 * On read paths the cost is over-broad results. On the compression path it is permanent:
 * compressTag rolls up every row its selector returns, appending to their content and
 * marking them `rolled-up`.
 *
 * Known and deliberately not handled: `tags` is JSON, so a tag containing `"` or `\` is
 * stored escaped (`a"b` as `a\"b`) and this pattern will not match it. The unescaped form
 * did not match it either — it just failed differently — and neither character can arrive
 * through a hashtag, since src/text/hashtags.ts matches \w. Escaping for LIKE and escaping
 * for JSON are two different transforms; doing the second properly means building the
 * pattern from the JSON encoding of the tag, not from the tag. Failing closed is the right
 * side to be wrong on for a selector that decides what gets rolled up.
 *
 * Lives here rather than with any one caller because four modules across three concerns
 * need it, and it is the tag vocabulary's own business how a tag is encoded and matched.
 * Pure by the rules in src/ARCHITECTURE.md — it imports nothing.
 */

/**
 * The `tags LIKE` pattern that matches exactly the given tag.
 *
 * Must be paired with TAG_LIKE_ESCAPE on the clause. Without it the backslashes are
 * literal and the pattern matches nothing instead of too much — wrong in the safe
 * direction, but still wrong, which is why the two are exported together.
 */
export function tagLikePattern(tag: string): string {
  return `%"${tag.replace(/([%_\\])/g, "\\$1")}"%`;
}

/** Goes immediately after any `LIKE ?` whose parameter came from tagLikePattern. */
export const TAG_LIKE_ESCAPE = `ESCAPE '\\'`;
