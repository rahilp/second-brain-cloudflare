import type { Env } from "../env";
import {
  D1_MAX_BOUND_PARAMS,
  KEYWORD_MAX_TOKENS,
  VECTORIZE_GET_BY_IDS_BATCH,
  VECTORIZE_TOP_K_MULTIPLIER,
} from "../constants";
import { resolveConfig, type Config } from "../config";
import { embed } from "../lib/ai";
import type { Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { expandGraph } from "../graph/traverse";
import type { GraphNeighbor } from "../graph/types";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { parseTimePhrase } from "../text/temporal";
import { tokenizeQuery } from "../text/tokenize";
import { distillToRareTerms, inferQueryTags, type DistilledQuery, type TimeBounds } from "./distill";
import { synthesizeInsight } from "./insight";
import { hasStaleAsOf } from "../memory/stale";
import { cosineSim, mmrRerank, rerankWithTimeDecay, type VectorizeMatch } from "./math";
import { rrfFuse } from "./rrf";
import { computeCompoundStale } from "./compound-stale";
import { exactQueryMatchCount, graphSeedLimit, relatedSlotLimit, scoreLinkedEvidence } from "./neighborhood";
import { queryCoverage } from "./neighborhood";
import { buildQueryProfile, DEFAULT_EMBEDDING_QUERY_MODE, embeddingInput } from "./query-profile";
import { localEvidenceOf } from "./root-candidate";
import { selectGraphRoots, type RootCandidate } from "./root-selector";
import type { KeywordRow, RecallInternalOptions, RecallMatch, RecallSearchResult, RecallStage } from "./types";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { workspaceFilter, queryVectorizeScoped } from "../vectorize/scope";
import { observeRecallEnv } from "./diagnostics";
import { chooseEvidenceSlot, type EvidenceSlotCandidate } from "./evidence-rescue";
import { queryRelevantWindow } from "./snippet";

async function keywordSearch(
  tokens: string[],
  env: Env,
  limit: number,
  bounds: Readonly<TimeBounds> = {},
  identity?: Identity,
): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  // Capped here rather than at distillation's uncapped exits because this is
  // the only place a token count becomes SQL, and there are two such exits —
  // one of which needs nothing worse than an empty corpus to fire (#276). Query
  // order is the only ordering available on those paths: they are exactly the
  // paths where the frequencies that would rank the terms are missing.
  const terms = tokens.slice(0, KEYWORD_MAX_TOKENS);
  const where = terms.map(() => "content LIKE ?").join(" OR ");
  let timeWhere = "";
  const timeBindings: number[] = [];
  if (bounds.after !== undefined) {
    timeWhere += " AND created_at >= ?";
    timeBindings.push(bounds.after);
  }
  if (bounds.before !== undefined) {
    timeWhere += " AND created_at < ?";
    timeBindings.push(bounds.before);
  }
  // Scoped before ORDER BY so LIMIT ranks only readable rows, not readable rows
  // plus strangers' rows truncated by the window.
  const scope = identity ? scopeWhere(identity) : null;
  const scopeSql = scope ? ` AND ${scope.clause}` : "";
  const tokenWhere = timeWhere ? `(${where})` : where;
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries WHERE ${tokenWhere}${timeWhere}${scopeSql} ORDER BY created_at DESC LIMIT ?`
  ).bind(...terms.map(t => `%${t}%`), ...timeBindings, ...(scope?.bindings ?? []), limit).all();
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
  config?: Readonly<Config>,
  internal: RecallInternalOptions = {},
): Promise<RecallSearchResult> {
  const totalStartedAt = performance.now();
  let stageStartedAt = totalStartedAt;
  const markStage = (stage: RecallStage) => {
    if (internal.diagnostics) {
      internal.diagnostics.stageMs ??= {};
      internal.diagnostics.stageMs[stage] = performance.now() - stageStartedAt;
    }
    stageStartedAt = performance.now();
  };
  if (internal.diagnostics) env = observeRecallEnv(env, internal.diagnostics);
  const cfg = config ?? await resolveConfig(env);
  const { query, topK } = params;
  const synthesize = params.synthesize ?? true;
  let { tag, after, before, kind } = params;
  const hops = Math.max(0, Math.min(cfg.GRAPH_MAX_HOPS, params.hops ?? cfg.DEFAULT_HOPS));
  const now = Date.now();
  let semanticUnavailable = false;
  // One clause, computed once: every entries read below ANDs it in when an
  // Identity rides along, and appends nothing — byte for byte — when one does
  // not. workspaceFilter narrows the same clause to a single layer.
  const scope = internal.identity ? scopeWhere(internal.identity, internal.workspaceFilter) : null;
  const identity = internal.identity;

  let semanticQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    semanticQuery = parsed.cleanQuery;
  }
  const bounds = { after, before };
  const distilled = await distillToRareTerms(semanticQuery, env, cfg, bounds, identity, internal.workspaceFilter);
  const profile = buildQueryProfile(semanticQuery, distilled);
  const embeddingQueryMode = internal.embeddingQueryMode ?? DEFAULT_EMBEDDING_QUERY_MODE;
  const embedQuery = embeddingInput(profile, embeddingQueryMode);
  const lexicalQuery = profile.lexicalQuery;
  internal.diagnostics && (internal.diagnostics.embeddingMode = embeddingQueryMode);
  markStage("setup");

  const tokens = profile.lexicalTokens;
  const [values, queryTags] = await Promise.all([
    embed(embedQuery, env, cfg),
    inferQueryTags(lexicalQuery, env, cfg, ctx, identity, internal.workspaceFilter),
  ]);
  markStage("querySignals");

  let keywordRows: KeywordRow[] = [];
  let results: { matches: VectorizeMatch[] };
  if (tag) {
    // Escaped: a tag is user data and LIKE reads _ and % as wildcards. This is a read, so
    // the failure is over-broad results rather than the permanent rollup the same bug
    // caused in compressTag — but `?tag=%` silently defeats the filter entirely and
    // returns the whole brain, which is not a recoverable-looking answer either.
    const tagScopeSql = scope ? ` AND ${scope.clause}` : "";
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ? ${TAG_LIKE_ESCAPE}${tagScopeSql}`
    ).bind(tagLikePattern(tag), ...(scope?.bindings ?? [])).all();
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
    // Scoped when an Identity is in play: the workspace filter keeps foreign
    // candidates out of the result slots. queryVectorizeScoped retries
    // unfiltered if Vectorize rejects the filter; hydration below is scoped at
    // the SQL layer either way, so correctness never rides on this.
    const wsFilter = identity ? workspaceFilter(identity, internal.workspaceFilter)?.filter : undefined;
    const denseQuery = async (): Promise<{ matches: VectorizeMatch[] }> => {
      try {
        if (wsFilter) {
          const { matches } = await queryVectorizeScoped<VectorizeMatch>(
            env.VECTORIZE, values, { topK: vectorizeTopK, filter: wsFilter },
          );
          return { matches };
        }
        return await env.VECTORIZE.query(values, { topK: vectorizeTopK, returnMetadata: "all", returnValues: true });
      } catch (e) {
        console.error("Vectorize query failed (degrading to keyword-only):", e);
        semanticUnavailable = true;
        return { matches: [] as VectorizeMatch[] };
      }
    };
    const [denseResults, kwRows] = await Promise.all([
      denseQuery(),
      keywordSearch(profile.retrievalTokens, env, cfg.KEYWORD_CANDIDATE_LIMIT, bounds, identity),
    ]);
    results = denseResults;
    keywordRows = kwRows;

    // Governed by its own threshold, not the write-path duplicate flag: the two
    // shared a constant until #245, so retuning duplicate detection silently
    // retuned recall widening.
    if (!semanticUnavailable && results.matches.length && results.matches[0].score < cfg.RECALL_WIDEN_THRESHOLD) {
      try {
        if (wsFilter) {
          const { matches } = await queryVectorizeScoped<VectorizeMatch>(
            env.VECTORIZE, values, { topK: 50, filter: wsFilter },
          );
          results = { matches };
        } else {
          results = await env.VECTORIZE.query(values, { topK: 50, returnMetadata: "all", returnValues: true });
        }
      } catch (e) {
        console.error("Vectorize widen-query failed (non-fatal, keeping narrow results):", e);
      }
    }
  }

  if (internal.diagnostics) {
    internal.diagnostics.denseIds = [...new Set(results.matches.map(m => ((m.metadata as any)?.parentId ?? m.id) as string))];
    internal.diagnostics.keywordIds = [...new Set(keywordRows.map(row => row.id))];
  }
  markStage("candidateGeneration");

  const semanticRankByParent = new Map<string, number>();
  [...results.matches]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .forEach(match => {
      const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
      if (!semanticRankByParent.has(parentId)) semanticRankByParent.set(parentId, semanticRankByParent.size + 1);
    });

  const rootFusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, profile.retrievalTokens, !tag || semanticUnavailable, distilled, cfg.SUBSTRING_MATCH_WEIGHT);
  const lexicalFusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, tokens, !tag || semanticUnavailable, distilled, cfg.SUBSTRING_MATCH_WEIGHT);
  const fusedMatches = lexicalFusedMatches.length ? lexicalFusedMatches : rootFusedMatches;
  if (!rootFusedMatches.length && !fusedMatches.length) return { matches: [], insight: "", semanticUnavailable };

  const candidateIds = [...new Set([...fusedMatches, ...rootFusedMatches].map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  internal.diagnostics && (internal.diagnostics.fusedIds = [...new Set(rootFusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[]);
  type CandidateSignalRow = { id: string; content?: string; source?: string; created_at?: number; last_updated?: number; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number; tags: string };
  const rcRows: CandidateSignalRow[] = [];
  const candidateSignalProjection = hops > 0
    ? `id, content, source, created_at, COALESCE(updated_at, created_at) AS last_updated, recall_count, importance_score, contradiction_wins, contradiction_losses, tags, workspace_id`
    : "id, recall_count, importance_score, contradiction_wins, contradiction_losses, tags, workspace_id";
  // Scoped too: this is the leak-catcher for unscoped Vectorize hits — until
  // namespaces land (P3) the dense arm can surface a stranger's id, and the
  // scope clause here is what stops that id from hydrating into signals. The
  // scope's two bindings count toward D1's bound-parameter ceiling exactly as
  // the ids do, so the batch shrinks by them rather than overrunning.
  const rcScopeSql = scope ? ` AND ${scope.clause}` : "";
  const rcBatchSize = D1_MAX_BOUND_PARAMS - (scope?.bindings.length ?? 0);
  for (let i = 0; i < candidateIds.length; i += rcBatchSize) {
    const batch = candidateIds.slice(i, i + rcBatchSize);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT ${candidateSignalProjection} FROM entries WHERE id IN (${rcPlaceholders})${rcScopeSql}`
    ).bind(...batch, ...(scope?.bindings ?? [])).all() as { results: CandidateSignalRow[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));
  const d1Tags = new Map(rcRows.map(r => [r.id, JSON.parse(r.tags ?? "[]") as string[]]));

  const directReranked = rerankWithTimeDecay(fusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, cfg);
  internal.diagnostics && (internal.diagnostics.candidateIds = directReranked.map(m => ((m.metadata as any)?.parentId ?? m.id) as string));

  const seen = new Set<string>();
  const dedupedAll = directReranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  });
  const directCandidates = mmrRerank(dedupedAll, cfg.MMR_LAMBDA, topK);
  markStage("candidateHydration");

  if (!directCandidates.length) return { matches: [], insight: "", semanticUnavailable };

  const directParentIds = directCandidates.map((m) => (m.metadata as any)?.parentId ?? m.id);
  let selectedRoots: ReturnType<typeof selectGraphRoots> = [];
  let rootCandidates: RootCandidate[] = [];
  if (hops > 0) {
    const candidateContent = new Map(rcRows.map(r => [r.id, r.content ?? ""]));
    const rootReranked = rerankWithTimeDecay(rootFusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses, d1Tags, cfg, { useRecallFrequency: false });
    const rootSeen = new Set<string>();
    rootCandidates = rootReranked.flatMap(match => {
      const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
      if (rootSeen.has(parentId)) return [];
      rootSeen.add(parentId);
      const tags = d1Tags.get(parentId) ?? [];
      const localEvidence = localEvidenceOf(match, candidateContent.get(parentId) ?? "", tokens);
      const tagAlignment = queryTags.length ? tags.filter(value => queryTags.includes(value)).length / queryTags.length : 0;
      const episodicAlignment = ["causal", "chronology"].includes(profile.intent) && tags.includes("kind:episodic") ? 1 : 0;
      const authorityAlignment = ["current", "direct"].includes(profile.intent) && tags.includes("status:canonical") ? 1 : 0;
      return [{ ...match, parentId, rootScore: match.score, localEvidence, tags,
        lexicalCoverage: queryCoverage(localEvidence, tokens, distilled).score,
        metadataAlignment: Math.min(1, .6 * tagAlignment + .2 * episodicAlignment + .2 * authorityAlignment),
        semanticRank: semanticRankByParent.get(parentId) }];
    });
    selectedRoots = selectGraphRoots(rootCandidates, graphSeedLimit(topK, rootCandidates.length), cfg.MMR_LAMBDA);
  }
  const graphSeedIds = selectedRoots.map(x => x.candidate.parentId);
  if (internal.diagnostics && hops > 0) {
    internal.diagnostics.rootSelections = selectedRoots.map(x => ({ id: x.candidate.parentId, selectedBy: x.selectedBy }));
    internal.diagnostics.rejections = [];
  }

  let expanded: GraphNeighbor[] = [];
  if (hops > 0) {
    expanded = await expandGraph(graphSeedIds, { hops, only: internal.workspaceFilter }, env, cfg, identity);
  }
  markStage("graphExpansion");
  if (internal.diagnostics && hops > 0) internal.diagnostics.expandedIds = expanded.map(x => x.id);

  // The graph view can include up to 50 roots and 50 expanded nodes in addition
  // to direct candidates. Keep the union unique and chunked: with a topK above
  // the public route's cap this can span multiple D1 statements, and time
  // filters consume bindings in every statement.
  const allParentIds = [...new Set([
    ...directParentIds,
    ...graphSeedIds,
    ...expanded.map(e => e.id),
  ])];
  let d1Filters = ` AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"auto-insight"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  const filterBindings: (string | number)[] = [];
  if (tag) {
    d1Filters += ` AND tags LIKE ? ${TAG_LIKE_ESCAPE}`;
    filterBindings.push(tagLikePattern(tag));
  }
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    d1Filters += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  if (after !== undefined) { d1Filters += ` AND created_at >= ?`; filterBindings.push(after); }
  if (before !== undefined) { d1Filters += ` AND created_at < ?`; filterBindings.push(before); }
  // Last filter in, so the scope's bindings are already inside filterBindings
  // when idBatchSize subtracts them from the bound-parameter ceiling — the same
  // accounting every other filter's bindings get.
  if (scope) {
    d1Filters += ` AND ${scope.clause}`;
    filterBindings.push(...scope.bindings);
  }
  const d1Rows: Record<string, any>[] = [];
  const idBatchSize = D1_MAX_BOUND_PARAMS - filterBindings.length;
  for (let i = 0; i < allParentIds.length; i += idBatchSize) {
    const batch = allParentIds.slice(i, i + idBatchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, updated_at, workspace_id FROM entries WHERE id IN (${placeholders})${d1Filters}`
    ).bind(...batch, ...filterBindings).all() as { results: Record<string, any>[] };
    d1Rows.push(...results);
  }

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));
  // Which layer a memory lives in, resolved against the caller's own workspace
  // ids: personal and company map to themselves, anything else ('' legacy rows,
  // system insights) reads as "system". Clients use this to offer share/unshare
  // and to badge results.
  const layerOf = (wid: unknown): "personal" | "company" | "system" =>
    wid === identity?.personalWorkspaceId ? "personal"
    : wid === identity?.companyWorkspaceId ? "company"
    : "system";
  const candidateSignalById = new Map(rcRows.map(row => [row.id, row]));
  markStage("finalHydration");

  const directMatches: RecallMatch[] = directCandidates.flatMap((m) => {
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
      workspace: layerOf(row.workspace_id),
      staleAsOf: hasStaleAsOf(JSON.parse(row.tags ?? "[]")),
    }];
  }).sort((a, b) => b.score - a.score);

  const maximumRootScore = Math.max(...selectedRoots.map(x => x.candidate.rootScore));
  const normalizedRootDivisor = maximumRootScore > 0 ? maximumRootScore : 1;
  const rootById = new Map(selectedRoots.map(x => [x.candidate.parentId, x.candidate]));
  const rootIdByNode = new Map(selectedRoots.map(x => [x.candidate.parentId, x.candidate.parentId]));
  const fallbackRootScore = directCandidates.at(-1)?.score ?? 0;
  for (const e of expanded) {
    rootIdByNode.set(e.id, rootIdByNode.get(e.viaFrom) ?? e.viaFrom);
  }
  const relatedLimit = relatedSlotLimit(topK);
  const replacement = directMatches[topK - relatedLimit];
  const replacementCoverage = replacement ? Math.max(
    queryCoverage(replacement.content, tokens, distilled).score,
    queryCoverage(replacement.content, profile.evidenceTokens, distilled).score,
  ) : 0;
  const expandedMatches: { match: RecallMatch; eligible: boolean; evidenceText: string; coverage: number }[] = expanded.flatMap((e) => {
    const row = d1Map.get(e.id);
    if (!row) return [];
    const root = rootById.get(rootIdByNode.get(e.id) ?? "");
    const rootScore = root ? root.rootScore / normalizedRootDivisor : fallbackRootScore;
    const evidence = scoreLinkedEvidence({
      parentScore: rootScore,
      parentContent: root?.localEvidence ?? "",
      content: row.content as string,
      queryTokens: tokens,
      evidenceTokens: profile.evidenceTokens,
      corpus: distilled,
      hop: e.hop,
      edgeWeight: e.viaWeight,
      provenance: e.viaProvenance,
      hopDecay: cfg.GRAPH_HOP_DECAY,
      replacementCoverage,
      intent: profile.intent,
      edgeType: e.viaType,
    });
    if (!evidence.eligible) internal.diagnostics?.rejections?.push({ id: e.id, reason: evidence.rejection ?? "weak-neighborhood" });
    const linkedEvidence = queryRelevantWindow(
      row.content as string,
      [...tokens, ...profile.evidenceTokens],
    );
    const evidenceText = `${root?.localEvidence ?? ""}\n${linkedEvidence}`;
    const coverage = queryCoverage(evidenceText, profile.evidenceTokens, distilled).score;
    return [{
      eligible: evidence.eligible,
      evidenceText,
      coverage,
      match: {
        id: e.id,
        content: row.content as string,
        score: evidence.score,
        createdAt: row.created_at as number,
        updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
        tags: JSON.parse(row.tags ?? "[]"),
        source: row.source as string,
        isUpdate: false,
        hop: e.hop,
        workspace: layerOf(row.workspace_id),
        staleAsOf: hasStaleAsOf(JSON.parse(row.tags ?? "[]")),
        viaProvenance: e.viaProvenance,
        viaType: e.viaType,
        viaLinkedAt: e.viaLinkedAt,
        viaFrom: e.viaFrom,
      },
    }];
  });

  const sortedExpanded = expandedMatches
    .sort((a, b) => b.match.score - a.match.score || a.match.id.localeCompare(b.match.id));
  if (internal.diagnostics) {
    internal.diagnostics.eligibleRelatedIds = sortedExpanded
      .filter(entry => entry.eligible && !directParentIds.includes(entry.match.id))
      .map(entry => entry.match.id);
  }
  const selectedRelated = sortedExpanded
    .filter(e => e.eligible && !directParentIds.includes(e.match.id))
    .slice(0, relatedLimit)
    .map(e => e.match);
  const selectedDirect = directMatches.slice(0, topK - selectedRelated.length);
  const baselineMatches: RecallMatch[] = [...selectedDirect, ...selectedRelated];
  let matches = baselineMatches;
  if (hops > 0 && topK >= 5 && baselineMatches.length >= 5) {
    const replacementIndex = baselineMatches.length - 1;
    const replacementMatch = baselineMatches[replacementIndex];
    const replacementEvidence = queryCoverage(
      replacementMatch.content,
      profile.evidenceTokens,
      distilled,
    ).score;
    const protectedIds = new Set(baselineMatches.slice(0, replacementIndex).map(match => match.id));
    const matchById = new Map<string, RecallMatch>();
    const candidates: EvidenceSlotCandidate[] = [];

    const selectedRootIds = new Set(selectedRoots.map(selection => selection.candidate.parentId));
    const omittedChallenger = rootCandidates
      .filter(root => !selectedRootIds.has(root.parentId) && !directParentIds.includes(root.parentId))
      .filter(root => root.semanticRank !== undefined)
      .sort((a, b) => a.semanticRank! - b.semanticRank!
        || b.rootScore - a.rootScore
        || a.parentId.localeCompare(b.parentId))[0];
    const rootsForEvidence = [
      ...selectedRoots.map(selection => ({ root: selection.candidate, semanticEligible: selection.selectedBy === "semantic" })),
      ...(omittedChallenger ? [{ root: omittedChallenger, semanticEligible: true }] : []),
    ];

    for (const { root, semanticEligible } of rootsForEvidence) {
      if (directParentIds.includes(root.parentId) || protectedIds.has(root.parentId)) continue;
      const row = d1Map.get(root.parentId) ?? candidateSignalById.get(root.parentId);
      if (!row) continue;
      const rowTags = JSON.parse(row.tags ?? "[]") as string[];
      const normalizedRowTags = rowTags.map(value => value.toLowerCase());
      if (normalizedRowTags.some(value => ["auto-pattern", "auto-insight", "status:deprecated"].includes(value))) continue;
      if (tag && !normalizedRowTags.includes(tag.toLowerCase())) continue;
      if (kind && !rowTags.includes(`kind:${kind}`)) continue;
      if (after !== undefined && Number(row.created_at) < after) continue;
      if (before !== undefined && Number(row.created_at) >= before) continue;
      const supplemental = queryCoverage(root.localEvidence, profile.evidenceTokens, distilled);
      const match: RecallMatch = {
        id: root.parentId,
        content: row.content as string,
        score: root.rootScore,
        createdAt: row.created_at as number,
        updatedAt: "last_updated" in row
          ? row.last_updated as number
          : ((row as Record<string, any>).updated_at as number | null) ?? (row.created_at as number),
        tags: rowTags,
        source: row.source as string,
        isUpdate: false,
        hop: 0,
        workspace: layerOf((row as Record<string, unknown>).workspace_id),
        staleAsOf: hasStaleAsOf(rowTags),
      };
      matchById.set(match.id, match);
      candidates.push({
        id: match.id,
        coverage: supplemental.score,
        exactHighIdf: supplemental.exactHighIdf,
        exactMatchCount: exactQueryMatchCount(root.localEvidence, profile.evidenceTokens),
        metadataAlignment: root.metadataAlignment,
        score: root.rootScore,
        source: "omitted-root",
        semanticRank: root.semanticRank,
        semanticEligible,
      });
    }

    for (const entry of sortedExpanded) {
      if (!entry.eligible || protectedIds.has(entry.match.id) || directParentIds.includes(entry.match.id)) continue;
      const precision = queryCoverage(entry.evidenceText, profile.evidenceTokens, distilled);
      matchById.set(entry.match.id, entry.match);
      candidates.push({
        id: entry.match.id,
        coverage: entry.coverage,
        exactHighIdf: precision.exactHighIdf,
        exactMatchCount: exactQueryMatchCount(entry.evidenceText, profile.evidenceTokens),
        metadataAlignment: 0,
        score: entry.match.score,
        source: "related",
      });
    }

    const chosen = chooseEvidenceSlot({
      coverage: replacementEvidence,
      semanticRank: semanticRankByParent.get(replacementMatch.id),
      semanticAllowed: replacementMatch.hop === 0,
    }, candidates);
    const chosenMatch = chosen && matchById.get(chosen.id);
    if (chosenMatch) matches = [...baselineMatches.slice(0, replacementIndex), chosenMatch];
  }
  const finalDirectIds = new Set(matches.filter(match => match.hop === 0).map(match => match.id));
  const finalRelated = matches.filter(match => match.hop > 0);
  if (internal.diagnostics) internal.diagnostics.selectedRelatedIds = finalRelated.map(x => x.id);
  if (internal.diagnostics) internal.diagnostics.finalIds = matches.map(match => match.id);
  markStage("selection");

  const presentedDirectIds = finalDirectIds;
  ctx.waitUntil(
    Promise.all(
      [...presentedDirectIds].map(id =>
        env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`).bind(id).run()
      )
    ).catch(e => console.error("recall_count update failed (non-fatal):", e))
  );

  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;

  const compoundStale = computeCompoundStale(matches);

  const insight = synthesize && matches.length > 1
    ? await synthesizeInsight(lexicalQuery, matches.map(m => ({ id: m.id, content: m.content })), env, cfg)
    : "";

  markStage("synthesis");
  if (internal.diagnostics) {
    internal.diagnostics.stageMs ??= {};
    internal.diagnostics.stageMs.total = performance.now() - totalStartedAt;
  }

  return { matches, insight, semanticUnavailable, queryUsed: lexicalQuery, queryTokens: tokens, compoundStale };
}
