import { CHUNK_OVERLAP_CHARS } from "../constants";
import { getStatus } from "../memory/status";
import { DEFAULTS, type Config } from "../config";

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[] | Float32Array | Float64Array;
}

// Recency-decay floors: the minimum fraction of its semantic relevance a memory
// keeps regardless of age (applied in rerankWithTimeDecay). Because decay now
// bottoms out at a floor instead of exp()-ing toward zero, recency becomes a
// tie-breaker rather than a gate — a strong old match can no longer be buried
// under a fresh weak one. Durability sets the floor: settled/important memories
// barely fade, volatile tasks still do. Staleness is handled by status +
// contradiction, not by making old memories invisible.
export const RECENCY_FLOOR = 0.6;
export const RECENCY_FLOOR_DURABLE = 0.9;
export const RECENCY_FLOOR_VOLATILE = 0.15;

// MMR diversity: how much the final top-K trades relevance for variety. Higher =
// more relevance-focused, lower = more diverse. 0.7 keeps the top hit intact while
// stopping near-duplicate (usually recent) memories from taking every slot.
export const MMR_LAMBDA = 0.7;

export function getHalfLifeMs(tags: string[]): number {
  if (tags.includes("task")) return 7 * 24 * 60 * 60 * 1000;
  if (tags.includes("context")) return 180 * 24 * 60 * 60 * 1000;
  if (tags.includes("work")) return 90 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export function rerankWithTimeDecay(
  matches: VectorizeMatch[],
  recallCounts: Map<string, number> = new Map(),
  importanceScores: Map<string, number> = new Map(),
  queryTags: string[] = [],
  contradictionWins: Map<string, number> = new Map(),
  contradictionLosses: Map<string, number> = new Map(),
  // Ranking seam: config in, ordering out. Threaded rather than read from
  // module scope so this stays pure and directly assertable without an env.
  config: Readonly<Config> = DEFAULTS
): VectorizeMatch[] {
  const now = Date.now();

  return matches
    .map(match => {
      const meta = match.metadata as any;
      const createdAt = meta?.created_at ?? now;
      const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
      const ageMs = now - createdAt;
      const parentId = (meta?.parentId ?? match.id) as string;
      const rc = recallCounts.get(parentId) ?? 0;

      const halfLifeMs = getHalfLifeMs(tags);
      const imp = importanceScores.get(parentId) ?? 0;

      const recencyFloor =
        getStatus(tags) === "canonical" || imp >= 4 ? config.RECENCY_FLOOR_DURABLE
        : tags.includes("task") ? config.RECENCY_FLOOR_VOLATILE
        : config.RECENCY_FLOOR;
      const recencyMultiplier = recencyFloor + (1 - recencyFloor) * Math.exp(-ageMs / halfLifeMs);
      const frequencyMultiplier = 1 + Math.log1p(rc);
      const combinedMultiplier = Math.min(1.0, recencyMultiplier * frequencyMultiplier);
      const isShortAppend = match.id.includes("-update-") &&
        typeof meta?.content === "string" && meta.content.length < CHUNK_OVERLAP_CHARS;
      const appendPenalty = isShortAppend ? 0.2 : 1.0;
      const rolledUpPenalty = tags.includes("rolled-up") ? 0.4 : 1.0;

      const wins = contradictionWins.get(parentId) ?? 0;
      const losses = contradictionLosses.get(parentId) ?? 0;
      const net = wins - losses;
      let importanceMultiplier: number;
      if (imp === 0 && net === 0) {
        importanceMultiplier = 1.0;
      } else {
        const base = imp === 0 ? 3 : imp;
        const adj = Math.sign(net) * Math.log1p(Math.abs(net)) * config.CONTRADICTION_IMPORTANCE_STEP;
        const effectiveImp = Math.max(1, Math.min(5, base + adj));
        importanceMultiplier = 0.8 + (effectiveImp / 5) * 0.4;
      }

      const overlap = queryTags.length ? tags.filter(t => queryTags.includes(t)).length : 0;
      const tagBoost = overlap ? Math.min(config.TAG_BOOST_MAX, 1 + overlap * config.TAG_BOOST_STEP) : 1.0;

      return { ...match, score: match.score * combinedMultiplier * appendPenalty * rolledUpPenalty * importanceMultiplier * tagBoost };
    })
    .sort((a, b) => b.score - a.score);
}

export function mmrRerank<T extends VectorizeMatch>(candidates: T[], lambda: number, k: number): T[] {
  if (candidates.length <= 1 || k <= 1) return candidates.slice(0, k);
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  const maxRel = pool[0].score || 1;
  const rel = (m: VectorizeMatch) => (maxRel > 0 ? m.score / maxRel : 0);

  const selected: T[] = [pool.shift()!];
  while (selected.length < k && pool.length) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let maxSim = 0;
      if (cand.values) {
        for (const s of selected) {
          if (s.values) maxSim = Math.max(maxSim, cosineSim(cand.values, s.values));
        }
      }
      const mmr = lambda * rel(cand) - (1 - lambda) * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}
