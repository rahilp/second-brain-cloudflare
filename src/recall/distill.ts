import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import {
  KEYWORD_MAX_TOKENS,
  MAX_QUERY_TERMS,
  QUERY_SATURATION_FRACTION,
} from "../constants";
import { readStreamText } from "../lib/ai";
import type { Identity } from "../lib/identity";
import { scopeWhereForRead } from "../lib/scope";
import { tokenizeQuery } from "../text/tokenize";
import { extractHashtags } from "../text/hashtags";
import { isTopicTag } from "../compression/eligibility";
import { getTagVocabulary } from "../tags/vocabulary";

/**
 * `ctx` is optional only so this stays callable from tests and any future internal
 * caller; pass it wherever there is one, or an aged-out vocabulary is rebuilt on the
 * request's own critical path instead of behind it.
 */
export async function inferQueryTags(query: string, env: Env, config: Readonly<Config> = DEFAULTS, ctx?: ExecutionContext, identity?: Identity, only?: "personal" | "company", teamId?: string): Promise<string[]> {
  const { hashtags } = extractHashtags(query);
  if (hashtags.length) return hashtags;

  // Cached (#288): this used to be a full table scan expanded per tag per row, on
  // every recall, and it was 82% of a recall's read cost.
  //
  // System tags are dropped rather than matched against. They say what the system
  // did to an entry, not what it is about, and the only thing a query tag does is
  // boost entries whose subject overlaps the question. Two of them — `auto-pattern`
  // and `status:deprecated` — name entries that recall's hydration filter removes
  // outright, so a boost they win is spent on rows that are then discarded. They are
  // also applied in bulk (the staleness pass alone writes `volatility:` and
  // `stale:as-of` across up to 25 entries a night), which makes them the highest-
  // count tags in a mature brain and exactly the ones that would crowd real topics
  // out of the 50 the LLM below is shown. The same predicate #278 used to keep them
  // out of digest candidates, so the two agree by construction.
  const knownTags = (await getTagVocabulary(env, ctx, identity)).filter(isTopicTag);

  const lowerQuery = query.toLowerCase();
  const keywordMatches = knownTags.filter(t =>
    new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(lowerQuery)
  );

  if (keywordMatches.length) return keywordMatches;

  if (!knownTags.length) return [];

  try {
    const stream = await env.AI.run(config.LLM_MODEL as any, {
      messages: [{
        role: "user",
        content: `From this list of tags: ${knownTags.slice(0, 50).join(", ")}\n\nWhich tags best match this query? Reply with only a comma-separated list of matching tag names from the list, or nothing if none apply.\n\nQuery: ${query.slice(0, 300)}`,
      }],
      max_tokens: 100,
      stream: true,
    });
    const text = await readStreamText(stream as ReadableStream);
    const knownSet = new Set(knownTags);
    return text.split(",").map(t => t.trim().toLowerCase()).filter(t => t && knownSet.has(t));
  } catch {
    return [];
  }
}

/**
 * The distilled query plus the corpus statistics the distillation already paid
 * for. `df` maps every scanned (normalized, lowercase) term to the number of
 * entries containing it, and `total` is the corpus row count — the real IDF
 * inputs, which fuseDenseAndKeyword would otherwise re-estimate from its
 * fetched sample. Both are null on every path that skipped or lost the scan,
 * so a consumer can trust that non-null stats are complete.
 */
export interface DistilledQuery {
  query: string;
  df: Map<string, number> | null;
  total: number | null;
}

export interface TimeBounds {
  after?: number;
  before?: number;
}

export async function distillToRareTerms(
  query: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
  only?: "personal" | "company",
  teamId?: string,
): Promise<DistilledQuery> {
  const words = query.split(/\s+/).filter(Boolean);
  // One vocabulary for the whole pipeline (#326): the terms counted here are the
  // ones the keyword arm binds, so corpus IDF covers everything fusion asks
  // about — search.ts requires all-or-nothing coverage.
  const tokensOf = new Map<string, string[]>();
  for (const w of words) if (!tokensOf.has(w)) tokensOf.set(w, tokenizeQuery(w));
  const content = words.filter(w => tokensOf.get(w)!.length > 0);
  const uniq = [...new Set(content.flatMap(w => tokensOf.get(w)!))].slice(0, KEYWORD_MAX_TOKENS);
  // Nothing to rank with at most one distinct term. A single whitespace word can
  // carry several terms once it is CJK; that case goes on to the scan.
  if (content.length <= 1 && uniq.length <= 1) {
    return { query: content.length ? content.join(" ") : query, df: null, total: null };
  }

  // One bound parameter and one SUM column per term, so this scan is bounded by
  // the same ceiling as the keyword clause it feeds. Sharing the constant is
  // what makes that true rather than coincidental: the widest set ranked here
  // is the widest set search.ts can carry, in either direction.
  // The DF denominator is the caller's readable corpus, not the deployment's:
  // another workspace's rows must not be able to saturate a term out of (or
  // inflate a term's rarity within) this caller's query.
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;
  try {
    const sums = uniq.map((_, i) => `SUM(CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS d${i}`).join(", ");
    let where = "";
    const timeBindings: number[] = [];
    if (bounds.after !== undefined) {
      where += " created_at >= ?";
      timeBindings.push(bounds.after);
    }
    if (bounds.before !== undefined) {
      where += `${where ? " AND" : ""} created_at < ?`;
      timeBindings.push(bounds.before);
    }
    if (scope) {
      where += `${where ? " AND" : ""} ${scope.clause}`;
    }
    // scope-checked: the caller's clause IS applied when an identity is present — it is appended into `where` above; the lexer cannot see into a JS-assembled fragment
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total, ${sums} FROM entries${where ? ` WHERE${where}` : ""}`)
      .bind(...uniq.map(t => `%${t}%`), ...timeBindings, ...(scope?.bindings ?? [])).first() as Record<string, number> | null;
    if (!row || !row.total) return { query: content.join(" "), df: null, total: null };
    const total = row.total;
    const df = new Map(uniq.map((t, i) => [t, (row[`d${i}`] as number) ?? 0]));
    let candidates = uniq.filter(t => (df.get(t) ?? 0) / total <= QUERY_SATURATION_FRACTION);
    if (!candidates.length) candidates = uniq;
    const keep = new Set(
      [...candidates].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, MAX_QUERY_TERMS)
    );
    const rebuilt = [...new Set(content.filter(w => tokensOf.get(w)!.some(t => keep.has(t))))];
    return { query: rebuilt.length ? rebuilt.join(" ") : content.join(" "), df, total };
  } catch {
    return { query: content.join(" "), df: null, total: null };
  }
}
