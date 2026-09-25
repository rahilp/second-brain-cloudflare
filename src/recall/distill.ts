import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import {
  FTS_MATCH_BUDGET,
  KEYWORD_MAX_TOKENS,
  MAX_QUERY_TERMS,
  QUERY_SATURATION_FRACTION,
} from "../constants";
import { readStreamText } from "../lib/ai";
import type { Identity } from "../lib/identity";
import { scopeWhereForRead, type ScopeClause } from "../lib/scope";
import { tokenizeQuery } from "../text/tokenize";
import { extractHashtags } from "../text/hashtags";
import { isTopicTag } from "../compression/eligibility";
import { getTagVocabulary } from "../tags/vocabulary";
import { deterministicVariants } from "./query-profile";
import { FTS_LIVENESS_SQL, ftsCountSafeToken, ftsEligibleToken, ftsMatchQuery, ftsReady, isFtsLiveRows } from "./fts";

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
  /** How df/total were obtained: the FTS index, the LIKE full scan, or skipped (no terms). */
  distillSource: "fts" | "like" | "shortcut";
}

export interface TimeBounds {
  after?: number;
  before?: number;
}

/** Shared by both the FTS and LIKE df sources so their ranking can never drift apart. */
function rankAndRebuild(
  uniq: string[],
  content: string[],
  tokensOf: Map<string, string[]>,
  df: Map<string, number>,
  total: number,
): string {
  let candidates = uniq.filter(t => (df.get(t) ?? 0) / total <= QUERY_SATURATION_FRACTION);
  if (!candidates.length) candidates = uniq;
  const keep = new Set(
    [...candidates].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, MAX_QUERY_TERMS)
  );
  const rebuilt = [...new Set(content.filter(w => tokensOf.get(w)!.some(t => keep.has(t))))];
  return rebuilt.length ? rebuilt.join(" ") : content.join(" ");
}

/** One term's scoped, time-bounded FTS MATCH count, capped at the saturation point. */
function ftsTermCountStmt(
  env: Env,
  term: string,
  bounds: Readonly<TimeBounds>,
  scope: ScopeClause | null,
  cap: number,
) {
  const match = ftsMatchQuery([term])!; // pre-filtered eligible by the caller
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) { timeWhere += " AND e.created_at >= ?"; timeBindings.push(bounds.after); }
  if (bounds.before !== undefined) { timeWhere += " AND e.created_at < ?"; timeBindings.push(bounds.before); }
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  // scope-checked: the caller's clause IS applied — scopeSql is built as ` AND ${scope.clause}` above and appended here; the lexer sees only the fragment name. workspace_id exists only on entries, not on entries_fts's id/content columns, so the unqualified column in scope.clause resolves unambiguously to e.workspace_id in this join, same as keywordSearchFts in search.ts
  return env.DB.prepare(
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ?${timeWhere}${scopeSql}
       LIMIT ?
     )`
  ).bind(match, ...timeBindings, ...(scope?.bindings ?? []), cap);
}

/** Scoped, time-bounded COUNT(*), batched with the liveness check (one subrequest). Time-bounded callers only — entry_counts has no time dimension. */
async function ftsScopedTotal(
  env: Env,
  bounds: Readonly<TimeBounds>,
  scope: ScopeClause | null,
): Promise<{ liveness: { name: string; sql: string | null }[] | undefined; total: number }> {
  let where = "";
  const bindings: number[] = [];
  if (bounds.after !== undefined) { where += " created_at >= ?"; bindings.push(bounds.after); }
  if (bounds.before !== undefined) { where += `${where ? " AND" : ""} created_at < ?`; bindings.push(bounds.before); }
  if (scope) where += `${where ? " AND" : ""} ${scope.clause}`;
  // scope-checked: the caller's clause IS applied when an identity is present — it is appended into `where` above; the lexer cannot see into a JS-assembled fragment
  const [livenessResult, totalResult] = await env.DB.batch([
    env.DB.prepare(FTS_LIVENESS_SQL),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM entries${where ? ` WHERE${where}` : ""}`)
      .bind(...bindings, ...(scope?.bindings ?? [])),
  ]);
  const totalRow = totalResult.results?.[0] as Record<string, number> | undefined;
  return {
    liveness: livenessResult.results as { name: string; sql: string | null }[] | undefined,
    total: (totalRow?.total as number) ?? 0,
  };
}

/**
 * The read-cost cap on a term's FTS count. Saturation alone (30% of the
 * corpus) is not enough: keywordSearch's cost router (T-0058) sums these same
 * df values against FTS_MATCH_BUDGET, an ABSOLUTE match-count threshold
 * unrelated to corpus size. On a corpus under ~6,700 rows, 30% is smaller than
 * the budget, so capping at the saturation point alone would report a common
 * term as cheaper than it is and route an expensive query to FTS. Flooring
 * the cap at FTS_MATCH_BUDGET + 1 keeps every count exact through the budget's
 * own threshold — the only range the router's `dfSum > FTS_MATCH_BUDGET`
 * comparison depends on — while still bounding the read on a saturating term
 * in a large corpus.
 */
function saturationCap(total: number): number {
  return Math.max(Math.floor(QUERY_SATURATION_FRACTION * total) + 1, FTS_MATCH_BUDGET + 1);
}

/**
 * T-0065: entry_counts' exact, O(1) total for the SAME scope, embedded as a
 * scalar subquery rather than passed as a JS-computed cap — the cap needs
 * total first, and embedding it lets total, every per-term count, AND the
 * liveness check ride in ONE batch (see distillViaFts) instead of a second
 * round trip. CAST(...AS INTEGER) truncates like Math.floor for the
 * non-negative totals here, and multi-arg max() is SQLite's scalar (not
 * aggregate) max, matching saturationCap's formula exactly.
 */
function saturationCapSql(scope: ScopeClause | null): { sql: string; bindings: string[] } {
  const scopeSql = scope ? ` WHERE ${scope.clause}` : "";
  return {
    sql: `(SELECT max(CAST(${QUERY_SATURATION_FRACTION} * COALESCE(SUM(n), 0) AS INTEGER) + 1, ${FTS_MATCH_BUDGET + 1}) FROM entry_counts${scopeSql})`,
    bindings: scope?.bindings ?? [],
  };
}

/** entry_counts' exact, unbounded, scoped total — no time dimension, no cache needed: it costs the same cold or warm. */
function entryCountsTotalStmt(env: Env, scope: ScopeClause | null) {
  const scopeSql = scope ? ` WHERE ${scope.clause}` : "";
  return env.DB.prepare(`SELECT COALESCE(SUM(n), 0) AS total FROM entry_counts${scopeSql}`).bind(...(scope?.bindings ?? []));
}

/** One term's scoped FTS MATCH count, capped via a SQL subquery on entry_counts (see saturationCapSql) rather than a JS-bound number. No time bounds: those callers use ftsTermCountStmt/ftsScopedTotal instead. */
function ftsTermCountStmtSqlCap(env: Env, term: string, scope: ScopeClause | null) {
  const match = ftsMatchQuery([term])!; // pre-filtered eligible by the caller
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  const cap = saturationCapSql(scope);
  // scope-checked: the caller's clause IS applied, twice — once in scopeSql
  // (the row filter) and once inside cap.sql (entry_counts' own scope); the
  // lexer sees only the fragment names, both are `scope.clause`.
  return env.DB.prepare(
    `SELECT count(*) AS n FROM (
       SELECT 1 FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid AND e.id = entries_fts.id
       WHERE entries_fts MATCH ?${scopeSql}
       LIMIT ${cap.sql}
     )`
  ).bind(match, ...(scope?.bindings ?? []), ...cap.bindings);
}

/**
 * T-0059/T-0065: df/total via the FTS index instead of a full LIKE scan.
 * No time bounds (the common case): entry_counts' total is exact and O(1),
 * so total, every per-term count, and the liveness check ride in ONE batch
 * always — cold costs the same as warm, and there is no cache to go stale.
 * Time-bounded calls keep the two-batch shape (liveness+total, then counts
 * with a JS-computed cap): entry_counts has no time dimension, so their
 * total still comes from a scoped, bounded COUNT(*) on entries. Returns null
 * on any disqualifier (index not live, empty corpus) so the caller falls
 * back to the existing LIKE statement.
 */
async function distillViaFts(
  dfTerms: string[],
  env: Env,
  bounds: Readonly<TimeBounds>,
  scope: ScopeClause | null,
): Promise<{ df: Map<string, number>; total: number } | null> {
  const hasBounds = bounds.after !== undefined || bounds.before !== undefined;

  let total: number;
  let liveness: { name: string; sql: string | null }[] | undefined;
  let countResults: { results?: unknown[] }[];

  if (!hasBounds) {
    const results = await env.DB.batch([
      env.DB.prepare(FTS_LIVENESS_SQL),
      entryCountsTotalStmt(env, scope),
      ...dfTerms.map(t => ftsTermCountStmtSqlCap(env, t, scope)),
    ]);
    liveness = results[0].results as { name: string; sql: string | null }[] | undefined;
    const totalRow = results[1].results?.[0] as Record<string, number> | undefined;
    total = (totalRow?.total as number) ?? 0;
    countResults = results.slice(2);
  } else {
    const scoped = await ftsScopedTotal(env, bounds, scope);
    liveness = scoped.liveness;
    total = scoped.total;
    if (!isFtsLiveRows(liveness) || !total) return null;
    const cap = saturationCap(total);
    countResults = await env.DB.batch(dfTerms.map(t => ftsTermCountStmt(env, t, bounds, scope, cap)));
  }

  if (!isFtsLiveRows(liveness) || !total) return null;
  const df = new Map(dfTerms.map((t, i) => {
    const row = countResults[i].results?.[0] as Record<string, number> | undefined;
    return [t, (row?.n as number) ?? 0];
  }));
  return { df, total };
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
  // keywordSearch's budget check needs df for every retrieval token, and
  // retrieval appends deterministicVariants — plural/stemmed forms this scan
  // would otherwise never count ("widgets gadgets" would route to FTS on a
  // corpus the singular routes to LIKE). They join a separate list for the df
  // statement only: `uniq` stays exactly as it is, so keep/rebuilt still rank
  // original content terms alone. Originals win the KEYWORD_MAX_TOKENS cap
  // and variants only fill the slots they leave; a variant left without a df
  // entry (cap bound) keeps the router's FTS default.
  const evidence = tokenizeQuery(query).slice(0, KEYWORD_MAX_TOKENS);
  const dfTerms = [...new Set([...uniq, ...deterministicVariants(query, evidence)])].slice(0, KEYWORD_MAX_TOKENS);
  // Even one term needs corpus df/total for keyword fusion and FTS routing.
  if (!content.length) {
    return { query, df: null, total: null, distillSource: "shortcut" };
  }

  // One bound parameter and one SUM column per term, so this scan is bounded by
  // the same ceiling as the keyword clause it feeds. Sharing the constant is
  // what makes that true rather than coincidental: the widest set ranked here
  // is the widest set search.ts can carry, in either direction.
  // The DF denominator is the caller's readable corpus, not the deployment's:
  // another workspace's rows must not be able to saturate a term out of (or
  // inflate a term's rarity within) this caller's query.
  const scope = identity ? scopeWhereForRead(identity, { layer: only, teamId }) : null;

  // T-0059: prefer the FTS index over the full LIKE scan when it is live and
  // every term can be counted through it with no risk of a different answer
  // than LIKE would give (ftsCountSafeToken — LIKE folds ASCII case only,
  // trigram folds Unicode case). Any disqualifier, or a thrown error, falls
  // through to the existing LIKE statement below, unchanged.
  if (dfTerms.every(t => ftsEligibleToken(t) && ftsCountSafeToken(t)) && await ftsReady(env)) {
    try {
      const viaFts = await distillViaFts(dfTerms, env, bounds, scope);
      // Every original term saturated and at least one count hit its LIMIT
      // cap: the capped counts can no longer order the terms against each
      // other, so the FTS ranking could differ from LIKE's. Discard them and
      // count exactly through the LIKE fallback — the byte-identical
      // statement below.
      const unrankable = !!viaFts
        && uniq.every(t => (viaFts.df.get(t) ?? 0) / viaFts.total > QUERY_SATURATION_FRACTION)
        && uniq.some(t => (viaFts.df.get(t) ?? 0) === saturationCap(viaFts.total));
      if (viaFts && !unrankable) {
        const { df, total } = viaFts;
        return { query: rankAndRebuild(uniq, content, tokensOf, df, total), df, total, distillSource: "fts" };
      }
    } catch (e) {
      console.error("FTS distillation count failed (degrading to LIKE):", e);
    }
  }

  try {
    const sums = dfTerms.map((_, i) => `SUM(CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS d${i}`).join(", ");
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
      .bind(...dfTerms.map(t => `%${t}%`), ...timeBindings, ...(scope?.bindings ?? [])).first() as Record<string, number> | null;
    if (!row || !row.total) return { query: content.join(" "), df: null, total: null, distillSource: "like" };
    const total = row.total;
    const df = new Map(dfTerms.map((t, i) => [t, (row[`d${i}`] as number) ?? 0]));
    return { query: rankAndRebuild(uniq, content, tokensOf, df, total), df, total, distillSource: "like" };
  } catch {
    return { query: content.join(" "), df: null, total: null, distillSource: "like" };
  }
}
