import type { Env } from "../env";
import {
  D1_MAX_BOUND_PARAMS,
  KEYWORD_MAX_TOKENS,
  VECTORIZE_GET_BY_IDS_BATCH,
  VECTORIZE_TOP_K_MULTIPLIER,
} from "../constants";
import { resolveConfig, type Config } from "../config";
import { embed } from "../lib/ai";
import { expandGraph } from "../graph/traverse";
import type { EdgeProvenance, EdgeType } from "../graph/types";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { derivePattern } from "../compression/pattern";
import { parseTimePhrase } from "../text/temporal";
import { tokenizeQuery } from "../text/tokenize";
import { distillToRareTerms, inferQueryTags, type DistilledQuery } from "./distill";
import { synthesizeInsight } from "./insight";
import { hasStaleAsOf } from "../memory/stale";
import { cosineSim, mmrRerank, rerankWithTimeDecay, type VectorizeMatch } from "./math";
import { rrfFuse } from "./rrf";
import { computeCompoundStale } from "./compound-stale";
import type { KeywordRow, RecallMatch, RecallSearchResult } from "./types";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";

async function keywordSearch(tokens: string[], env: Env, limit: number): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  // Capped here rather than at distillation's uncapped exits because this is
  // the only place a token count becomes SQL, and there are two such exits —
  // one of which needs nothing worse than an empty corpus to fire (#276). Query
  // order is the only ordering available on those paths: they are exactly the
  // paths where the frequencies that would rank the terms are missing.
  const terms = tokens.slice(0, KEYWORD_MAX_TOKENS);
  const where = terms.map(() => "content LIKE ?").join(" OR ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries WHERE ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...terms.map(t => `%${t}%`), limit).all();
  return results as unknown as KeywordRow[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fuseDenseAndKeyword(
  denseMatches: VectorizeMatch[],
  keywordRows: KeywordRow[],
  tokens: string[],
  allowKeywordOnly: boolean,
  corpus: Pick<DistilledQuery, "df" | "total">,
  substringWeight: number
): VectorizeMatch[] {
  const denseByParent = new Map<string, VectorizeMatch>();
  for (const m of [...denseMatches].sort((a, b) => b.score - a.score)) {
    const pid = ((m.metadata as any)?.parentId ?? m.id) as string;
    if (!denseByParent.has(pid)) denseByParent.set(pid, m);
  }
  const denseRanked = [...denseByParent.keys()];

  const kwLower = keywordRows.map(r => ({ row: r, lc: r.content.toLowerCase() }));

  // IDF from the corpus-wide frequencies distillToRareTerms already computed,
  // when they cover every token; otherwise the old estimate from the fetched
  // rows. All-or-nothing rather than per-token, because the two denominators
  // (corpus size vs fetch-window size) are different scales — mixing them in
  // one weight sum would let the source of a token's IDF, not its rarity,
  // decide the ranking.
  let idf: (t: string) => number;
  if (corpus.df && corpus.total && tokens.every(t => corpus.df!.has(t))) {
    const { df, total } = corpus;
    idf = t => Math.log(1 + total / ((df.get(t) ?? 0) + 1));
  } else {
    const kwN = kwLower.length || 1;
    const kwDf = new Map(tokens.map(t => [t, kwLower.reduce((n, x) => n + (x.lc.includes(t) ? 1 : 0), 0)]));
    idf = t => Math.log(1 + kwN / ((kwDf.get(t) ?? 0) + 1));
  }

  // A token found at a word boundary earns full IDF; found only inside a longer
  // word ("cat" in "concatenate") it earns a configured fraction. Lookarounds
  // rather than \b so identifier-shaped tokens ("#149", "v1.9") keep matching —
  // \b treats their punctuation as the boundary itself.
  const boundary = new Map(tokens.map(t => [t, new RegExp(`(?<![\\w])${escapeRegExp(t)}(?![\\w])`)]));
  const tokenWeight = (lc: string, t: string) => {
    if (!lc.includes(t)) return 0;
    return boundary.get(t)!.test(lc) ? idf(t) : idf(t) * substringWeight;
  };

  const keywordRanked = kwLower
    .map(x => ({ row: x.row, weight: tokens.reduce((s, t) => s + tokenWeight(x.lc, t), 0) }))
    .filter(x => x.weight > 0 && (allowKeywordOnly || denseByParent.has(x.row.id)))
    .sort((a, b) => b.weight - a.weight || b.row.created_at - a.row.created_at || (a.row.id < b.row.id ? -1 : 1));

  const fused = rrfFuse(denseRanked, keywordRanked.map(x => ({ id: x.row.id, weight: x.weight })));
  const keywordRowById = new Map(keywordRows.map(r => [r.id, r]));

  const out: VectorizeMatch[] = [];
  for (const [pid, score] of fused) {
    const dm = denseByParent.get(pid);
    if (dm) {
      out.push({ id: dm.id, score, metadata: dm.metadata, values: dm.values });
    } else {
      const r = keywordRowById.get(pid)!;
      out.push({ id: pid, score, metadata: { parentId: pid, created_at: r.created_at, tags: JSON.parse(r.tags ?? "[]"), content: r.content, source: r.source } });
    }
  }
  return out;
}

export async function recallEntries(
  params: { query: string; topK: number; tag?: string; after?: number; before?: number; kind?: MemoryKind; hops?: number; synthesize?: boolean },
  env: Env,
  ctx: ExecutionContext,
  // Resolved once at request entry by the route/MCP caller and threaded down.
  // Optional so this stays callable without a config in tests and any future
  // internal caller; the fallback costs one KV read.
  config?: Readonly<Config>
): Promise<RecallSearchResult> {
  const cfg = config ?? await resolveConfig(env);
  const { query, topK } = params;
  const synthesize = params.synthesize ?? true;
  let { tag, after, before, kind } = params;
  const hops = Math.max(0, Math.min(cfg.GRAPH_MAX_HOPS, params.hops ?? cfg.DEFAULT_HOPS));
  const now = Date.now();
  let semanticUnavailable = false;

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }
  const distilled = await distillToRareTerms(embedQuery, env, cfg);
  embedQuery = distilled.query;

  const tokens = tokenizeQuery(embedQuery);
  const [values, queryTags] = await Promise.all([
    embed(embedQuery, env, cfg),
    inferQueryTags(embedQuery, env, cfg, ctx),
  ]);

  let keywordRows: KeywordRow[] = [];
  let results: { matches: VectorizeMatch[] };
  if (tag) {
    // Escaped: a tag is user data and LIKE reads _ and % as wildcards. This is a read, so
    // the failure is over-broad results rather than the permanent rollup the same bug
    // caused in compressTag — but `?tag=%` silently defeats the filter entirely and
    // returns the whole brain, which is not a recoverable-looking answer either.
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ? ${TAG_LIKE_ESCAPE}`
    ).bind(tagLikePattern(tag)).all();
    if (!tagRows.length) return { matches: [], insight: "", semanticUnavailable };
    keywordRows = tagRows as unknown as KeywordRow[];

    const vectorIds = [...new Set(
      (tagRows as any[]).flatMap(r => JSON.parse((r.vector_ids as string) ?? "[]") as string[])
    )];
    if (!vectorIds.length) return { matches: [], insight: "", semanticUnavailable };

    const vectors: VectorizeVector[] = [];
    try {
      for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
        vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
      }
    } catch (e) {
      console.error("Vectorize getByIds failed (degrading to keyword-only):", e);
      semanticUnavailable = true;
    }

    results = {
      matches: vectors.map(v => ({
        id: v.id,
        score: cosineSim(values, v.values as number[]),
        metadata: v.metadata,
        values: v.values as number[],
      })) as VectorizeMatch[],
    };
  } else {
    const vectorizeTopK = Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
    const denseQuery = async (): Promise<{ matches: VectorizeMatch[] }> => {
      try {
        return await env.VECTORIZE.query(values, { topK: vectorizeTopK, returnMetadata: "all", returnValues: true });
      } catch (e) {
        console.error("Vectorize query failed (degrading to keyword-only):", e);
        semanticUnavailable = true;
        return { matches: [] as VectorizeMatch[] };
      }
    };
    const [denseResults, kwRows] = await Promise.all([denseQuery(), keywordSearch(tokens, env, cfg.KEYWORD_CANDIDATE_LIMIT)]);
    results = denseResults;
    keywordRows = kwRows;

    // Governed by its own threshold, not the write-path duplicate flag: the two
    // shared a constant until #245, so retuning duplicate detection silently
    // retuned recall widening.
    if (!semanticUnavailable && results.matches.length && results.matches[0].score < cfg.RECALL_WIDEN_THRESHOLD) {
      try {
        results = await env.VECTORIZE.query(values, { topK: 50, returnMetadata: "all", returnValues: true });
      } catch (e) {
        console.error("Vectorize widen-query failed (non-fatal, keeping narrow results):", e);
      }
    }
  }

  const fusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, tokens, !tag || semanticUnavailable, distilled, cfg.SUBSTRING_MATCH_WEIGHT);
  if (!fusedMatches.length) return { matches: [], insight: "", semanticUnavailable };

  const candidateIds = [...new Set(fusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcRows: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; tags: string }[] = [];
  for (let i = 0; i < candidateIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = candidateIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, recall_count, importance_score, contradiction_wins, contradiction_losses, tags FROM entries WHERE id IN (${rcPlaceholders})`
    ).bind(...batch).all() as { results: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; tags: string }[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));
  const d1Tags = new Map(rcRows.map(r => [r.id, JSON.parse(r.tags ?? "[]") as string[]]));

  const reranked = rerankWithTimeDecay(fusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, cfg);

  const seen = new Set<string>();
  const dedupedAll = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  });
  const deduped = mmrRerank(dedupedAll, cfg.MMR_LAMBDA, topK);

  if (!deduped.length) return { matches: [], insight: "", semanticUnavailable };

  const seedParentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);

  let expandedScored: { parentId: string; score: number; hop: number; viaProvenance: EdgeProvenance; viaType: EdgeType; viaLinkedAt: number; viaFrom: string }[] = [];
  if (hops > 0) {
    const minSeedScore = deduped.reduce((mn, m) => Math.min(mn, m.score), Infinity);
    const expanded = await expandGraph(seedParentIds, { hops }, env, cfg);
    expandedScored = expanded.map(n => ({
      parentId: n.id,
      hop: n.hop,
      score: minSeedScore * Math.pow(cfg.GRAPH_HOP_DECAY, n.hop) * n.viaWeight,
      viaProvenance: n.viaProvenance,
      viaType: n.viaType,
      viaLinkedAt: n.viaLinkedAt,
      viaFrom: n.viaFrom,
    }));
  }

  // Chunked like the recall-count fetch above. This id list is the seeds plus
  // whatever the graph expansion returned, so its length is the sum of two caps
  // this query does not own — topK and GRAPH_MAX_NODES. They sum to 70 today,
  // which fits one statement; the loop is what makes raising either of them a
  // tuning change here rather than a query D1 rejects. One consequence if a
  // second batch ever runs: d1Rows is then batch order, not one result set's
  // order, which derivePattern's rows.slice(0, 20) below samples from.
  const allParentIds = [...seedParentIds, ...expandedScored.map(e => e.parentId)];
  let d1Filters = ` AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  const filterBindings: number[] = [];
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    d1Filters += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  if (after !== undefined) { d1Filters += ` AND created_at >= ?`; filterBindings.push(after); }
  if (before !== undefined) { d1Filters += ` AND created_at <= ?`; filterBindings.push(before); }
  const d1Rows: Record<string, any>[] = [];
  const idBatchSize = D1_MAX_BOUND_PARAMS - filterBindings.length;
  for (let i = 0; i < allParentIds.length; i += idBatchSize) {
    const batch = allParentIds.slice(i, i + idBatchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, updated_at FROM entries WHERE id IN (${placeholders})${d1Filters}`
    ).bind(...batch, ...filterBindings).all() as { results: Record<string, any>[] };
    d1Rows.push(...results);
  }

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));

  const seedIdSet = new Set(seedParentIds);
  ctx.waitUntil(
    Promise.all(
      [...d1Map.keys()].filter(id => seedIdSet.has(id)).map(id =>
        env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`).bind(id).run()
      )
    ).catch(e => console.error("recall_count update failed (non-fatal):", e))
  );

  const seedMatches: RecallMatch[] = deduped.flatMap((m) => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    if (!row) return [];
    return [{
      id: parentId,
      content: row.content as string,
      score: m.score,
      createdAt: row.created_at as number,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: !!meta?.isUpdate,
      hop: 0,
      staleAsOf: hasStaleAsOf(JSON.parse(row.tags ?? "[]")),
    }];
  });

  const expandedMatches: RecallMatch[] = expandedScored.flatMap((e) => {
    const row = d1Map.get(e.parentId);
    if (!row) return [];
    return [{
      id: e.parentId,
      content: row.content as string,
      score: e.score,
      createdAt: row.created_at as number,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: false,
      hop: e.hop,
      staleAsOf: hasStaleAsOf(JSON.parse(row.tags ?? "[]")),
      viaProvenance: e.viaProvenance,
      viaType: e.viaType,
      viaLinkedAt: e.viaLinkedAt,
      viaFrom: e.viaFrom,
    }];
  });

  const matches: RecallMatch[] = [...seedMatches, ...expandedMatches]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;

  const compoundStale = computeCompoundStale(matches);

  const insight = synthesize && matches.length > 1
    ? await synthesizeInsight(embedQuery, matches.map(m => ({ id: m.id, content: m.content })), env, cfg)
    : "";

  if (d1Rows.length >= 5) {
    ctx.waitUntil(
      derivePattern(d1Rows as { id: string; content: string }[], env, ctx, cfg)
        .catch(e => console.error("derivePattern failed (non-fatal):", e))
    );
  }

  return { matches, insight, semanticUnavailable, queryUsed: embedQuery, queryTokens: tokens, compoundStale };
}
