import type { Env } from "../env";
import {
  D1_MAX_BOUND_PARAMS,
  DUPLICATE_FLAG_THRESHOLD,
  KEYWORD_CANDIDATE_LIMIT,
  VECTORIZE_GET_BY_IDS_BATCH,
  VECTORIZE_TOP_K_MULTIPLIER,
} from "../constants";
import { embed } from "../lib/ai";
import { expandGraph, GRAPH_HOP_DECAY, GRAPH_MAX_HOPS } from "../graph/traverse";
import type { EdgeProvenance, EdgeType } from "../graph/types";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { derivePattern } from "../compression/pattern";
import { parseTimePhrase } from "../text/temporal";
import { tokenizeQuery } from "../text/tokenize";
import { distillToRareTerms, inferQueryTags } from "./distill";
import { synthesizeInsight } from "./insight";
import { cosineSim, mmrRerank, MMR_LAMBDA, rerankWithTimeDecay, type VectorizeMatch } from "./math";
import { rrfFuse } from "./rrf";
import type { KeywordRow, RecallMatch, RecallSearchResult } from "./types";

async function keywordSearch(tokens: string[], env: Env): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  const where = tokens.map(() => "content LIKE ?").join(" OR ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries WHERE ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...tokens.map(t => `%${t}%`), KEYWORD_CANDIDATE_LIMIT).all();
  return results as unknown as KeywordRow[];
}

function fuseDenseAndKeyword(
  denseMatches: VectorizeMatch[],
  keywordRows: KeywordRow[],
  tokens: string[],
  allowKeywordOnly: boolean
): VectorizeMatch[] {
  const denseByParent = new Map<string, VectorizeMatch>();
  for (const m of [...denseMatches].sort((a, b) => b.score - a.score)) {
    const pid = ((m.metadata as any)?.parentId ?? m.id) as string;
    if (!denseByParent.has(pid)) denseByParent.set(pid, m);
  }
  const denseRanked = [...denseByParent.keys()];

  const kwLower = keywordRows.map(r => ({ row: r, lc: r.content.toLowerCase() }));
  const kwN = kwLower.length || 1;
  const kwDf = new Map(tokens.map(t => [t, kwLower.reduce((n, x) => n + (x.lc.includes(t) ? 1 : 0), 0)]));
  const kwIdf = (t: string) => Math.log(1 + kwN / ((kwDf.get(t) ?? 0) + 1));
  const keywordRanked = kwLower
    .map(x => ({ row: x.row, weight: tokens.reduce((s, t) => s + (x.lc.includes(t) ? kwIdf(t) : 0), 0) }))
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
  ctx: ExecutionContext
): Promise<RecallSearchResult> {
  const { query, topK } = params;
  const synthesize = params.synthesize ?? true;
  let { tag, after, before, kind } = params;
  const hops = Math.max(0, Math.min(GRAPH_MAX_HOPS, params.hops ?? 0));
  const now = Date.now();
  let semanticUnavailable = false;

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }
  embedQuery = await distillToRareTerms(embedQuery, env);

  const tokens = tokenizeQuery(embedQuery);
  const [values, queryTags] = await Promise.all([
    embed(embedQuery, env),
    inferQueryTags(embedQuery, env),
  ]);

  let keywordRows: KeywordRow[] = [];
  let results: { matches: VectorizeMatch[] };
  if (tag) {
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?`
    ).bind(`%"${tag}"%`).all();
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
    const [denseResults, kwRows] = await Promise.all([denseQuery(), keywordSearch(tokens, env)]);
    results = denseResults;
    keywordRows = kwRows;

    if (!semanticUnavailable && results.matches.length && results.matches[0].score < DUPLICATE_FLAG_THRESHOLD) {
      try {
        results = await env.VECTORIZE.query(values, { topK: 50, returnMetadata: "all", returnValues: true });
      } catch (e) {
        console.error("Vectorize widen-query failed (non-fatal, keeping narrow results):", e);
      }
    }
  }

  const fusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, tokens, !tag || semanticUnavailable);
  if (!fusedMatches.length) return { matches: [], insight: "", semanticUnavailable };

  const candidateIds = [...new Set(fusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcRows: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number }[] = [];
  for (let i = 0; i < candidateIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = candidateIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries WHERE id IN (${rcPlaceholders})`
    ).bind(...batch).all() as { results: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number }[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));

  const reranked = rerankWithTimeDecay(fusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses);

  const seen = new Set<string>();
  const dedupedAll = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  });
  const deduped = mmrRerank(dedupedAll, MMR_LAMBDA, topK);

  if (!deduped.length) return { matches: [], insight: "", semanticUnavailable };

  const seedParentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);

  let expandedScored: { parentId: string; score: number; hop: number; viaProvenance: EdgeProvenance; viaType: EdgeType; viaLinkedAt: number; viaFrom: string }[] = [];
  if (hops > 0) {
    const minSeedScore = deduped.reduce((mn, m) => Math.min(mn, m.score), Infinity);
    const expanded = await expandGraph(seedParentIds, { hops }, env);
    expandedScored = expanded.map(n => ({
      parentId: n.id,
      hop: n.hop,
      score: minSeedScore * Math.pow(GRAPH_HOP_DECAY, n.hop) * n.viaWeight,
      viaProvenance: n.viaProvenance,
      viaType: n.viaType,
      viaLinkedAt: n.viaLinkedAt,
      viaFrom: n.viaFrom,
    }));
  }

  const allParentIds = [...seedParentIds, ...expandedScored.map(e => e.parentId)];
  const placeholders = allParentIds.map(() => "?").join(", ");
  const d1Bindings: (string | number)[] = [...allParentIds];
  let d1Sql = `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders}) AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    d1Sql += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  if (after !== undefined) { d1Sql += ` AND created_at >= ?`; d1Bindings.push(after); }
  if (before !== undefined) { d1Sql += ` AND created_at <= ?`; d1Bindings.push(before); }
  const { results: d1Rows } = await env.DB.prepare(d1Sql).bind(...d1Bindings).all() as { results: Record<string, any>[] };

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
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: !!meta?.isUpdate,
      hop: 0,
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
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate: false,
      hop: e.hop,
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

  const insight = synthesize && matches.length > 1
    ? await synthesizeInsight(embedQuery, matches.map(m => ({ id: m.id, content: m.content })), env)
    : "";

  if (d1Rows.length >= 5) {
    ctx.waitUntil(
      derivePattern(d1Rows as { id: string; content: string }[], env, ctx)
        .catch(e => console.error("derivePattern failed (non-fatal):", e))
    );
  }

  return { matches, insight, semanticUnavailable, queryUsed: embedQuery, queryTokens: tokens };
}
