import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import { getKind } from "../memory/kind";
import { getStatus } from "../memory/status";
import { edgeLabel } from "./edges";
import type { Connection, EdgeProvenance, GraphNeighbor, GraphView } from "./types";

export const GRAPH_MAX_HOPS = 3;
const GRAPH_FANOUT_CAP = 8;
const GRAPH_MAX_NODES = 50;
// Ceiling on the /graph view's node set, applied even when the caller asks for
// no cap. The binding constraint is the Workers free-plan limit of 50
// subrequests per invocation, not row reads. buildGraph costs
//
//   1 (edge scan) + ceil(N/D1_MAX_BOUND_PARAMS) (node hydration)
//                 + ceil(N/EDGE_QUERY_BATCH)    (edge hydration)
//
// D1 queries for N nodes, plus one KV read for the config. At N=1500 that is
// 1 + 15 + 30 = 46, or 47 with the KV read. N=1600 lands on exactly 50 with
// nothing spare, and anything from 1634 up exceeds it outright — which would be
// a deterministically dead graph tab for every free-plan brain that large, and
// runGraphPass backfills edges nightly, so a brain arrives there on its own.
//
// 47 is the WARM figure. On a cold isolate the budget is shared with
// initializeDatabase, which fires under waitUntil and spends about 12 more on
// its DDL, so the first request against a fresh isolate costs ~59 and is over
// the limit — 1500 buys margin on the warm path, it does not clear the cold one.
// That is #282 (probe sqlite_master once instead of issuing twelve blind
// statements, taking cold /graph from 59 to 48), not something a lower cap here
// can fix: the tax is fixed, so it eats any N.
//
// Recompute the formula above before raising this, and count the cold case as
// well as the warm one. D1's 5M rows/day cap is the secondary bound and is
// nowhere near binding here; sizing against it is what produced a number that
// broke the free plan.
//
// It is a legibility limit too: the packed-cluster canvas is unreadable well
// before 1500 nodes.
export const GRAPH_VIEW_MAX_NODES = 1500;
export const GRAPH_HOP_DECAY = 0.6;
const EDGE_QUERY_BATCH = Math.floor(D1_MAX_BOUND_PARAMS / 2);

async function deprecatedIdsAmong(ids: string[], env: Env): Promise<Set<string>> {
  const deprecated = new Set<string>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, tags FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    for (const r of results) {
      if (getStatus(JSON.parse(r.tags ?? "[]")) === "deprecated") deprecated.add(r.id as string);
    }
  }
  return deprecated;
}

export async function expandGraph(
  seedIds: string[],
  opts: { hops: number; fanoutCap?: number; maxNodes?: number; includeDeprecated?: boolean },
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<GraphNeighbor[]> {
  const hops = Math.max(0, Math.min(config.GRAPH_MAX_HOPS, opts.hops));
  if (hops === 0 || seedIds.length === 0) return [];
  const fanoutCap = opts.fanoutCap ?? GRAPH_FANOUT_CAP;
  const maxNodes = opts.maxNodes ?? GRAPH_MAX_NODES;

  const visited = new Set(seedIds);
  const out: GraphNeighbor[] = [];
  let frontier = [...seedIds];

  for (let hop = 1; hop <= hops && frontier.length && out.length < maxNodes; hop++) {
    const edgeRows: { source_id: string; target_id: string; type: string; weight: number; provenance: EdgeProvenance; created_at: number }[] = [];
    for (let i = 0; i < frontier.length; i += EDGE_QUERY_BATCH) {
      const batch = frontier.slice(i, i + EDGE_QUERY_BATCH);
      const ph = batch.map(() => "?").join(", ");
      const { results } = await env.DB.prepare(
        `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph}) ORDER BY weight DESC`
      ).bind(...batch, ...batch).all() as { results: any[] };
      edgeRows.push(...results);
    }

    const frontierSet = new Set(frontier);
    const perNodeCount = new Map<string, number>();
    const candidates: GraphNeighbor[] = [];
    for (const e of edgeRows) {
      let from: string | null = null;
      let to: string | null = null;
      if (frontierSet.has(e.source_id)) { from = e.source_id; to = e.target_id; }
      else if (frontierSet.has(e.target_id)) { from = e.target_id; to = e.source_id; }
      if (!from || !to || visited.has(to)) continue;
      const n = perNodeCount.get(from) ?? 0;
      if (n >= fanoutCap) continue;
      perNodeCount.set(from, n + 1);
      candidates.push({ id: to, hop, viaWeight: e.weight, viaType: e.type as GraphNeighbor["viaType"], viaProvenance: e.provenance, viaLinkedAt: e.created_at, viaFrom: from });
    }

    let allowed = candidates;
    if (!opts.includeDeprecated && candidates.length) {
      const deprecated = await deprecatedIdsAmong([...new Set(candidates.map(c => c.id))], env);
      allowed = candidates.filter(c => !deprecated.has(c.id));
    }

    const nextFrontier: string[] = [];
    for (const c of allowed) {
      if (visited.has(c.id)) continue;
      if (out.length >= maxNodes) break;
      visited.add(c.id);
      out.push(c);
      nextFrontier.push(c.id);
    }
    frontier = nextFrontier;
  }

  return out;
}

async function hydrateGraphEntries(ids: string[], env: Env): Promise<Map<string, Record<string, any>>> {
  const map = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    for (const r of results) map.set(r.id as string, r);
  }
  return map;
}

export async function getConnections(id: string, type: string | undefined, env: Env, config: Readonly<Config> = DEFAULTS): Promise<Connection[]> {
  let neighbors = await expandGraph([id], { hops: 1 }, env, config);
  if (type) neighbors = neighbors.filter(n => n.viaType === type);
  if (!neighbors.length) return [];

  const rows = await hydrateGraphEntries(neighbors.map(n => n.id), env);
  const out: Connection[] = [];
  for (const n of neighbors) {
    const row = rows.get(n.id);
    if (!row) continue;
    out.push({
      id: n.id,
      content: row.content as string,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      created_at: row.created_at as number,
      type: n.viaType,
      label: edgeLabel(n.viaType),
      weight: n.viaWeight,
      provenance: n.viaProvenance,
      linkedAt: n.viaLinkedAt,
    });
  }
  return out;
}

export async function buildGraph(opts: { seed?: string; limit?: number }, env: Env, config: Readonly<Config> = DEFAULTS): Promise<GraphView> {
  // "No cap" resolves to GRAPH_VIEW_MAX_NODES, never to Infinity. Anything that
  // is not a positive finite number — absent, 0, negative, NaN — takes that
  // branch, so a caller who reaches here past the route's own validation still
  // cannot ask for an unbounded result set. Keeping `limit` a finite integer is
  // also what makes it safe to interpolate into the SQL below.
  //
  // The LIMIT bounds rows *returned*, not rows read: `weight` has no index, so
  // SQLite full-scans and sorts `edges` either way and rows_read is unchanged.
  // Bounding the result is still the point — it is what caps the node set, and
  // the node set is what drives the query count above.
  const asked = Number.isFinite(opts.limit) && (opts.limit as number) > 0
    ? Math.floor(opts.limit as number)
    : GRAPH_VIEW_MAX_NODES;
  const limit = Math.min(asked, GRAPH_VIEW_MAX_NODES);

  let nodeIds: string[];
  if (opts.seed) {
    const neighbors = await expandGraph([opts.seed], { hops: 2, maxNodes: limit, includeDeprecated: true }, env, config);
    nodeIds = [opts.seed, ...neighbors.map(n => n.id)].slice(0, limit);
  } else {
    const { results } = await env.DB.prepare(
      `SELECT source_id, target_id FROM edges ORDER BY weight DESC LIMIT ${limit * 4}`
    ).all() as { results: { source_id: string; target_id: string }[] };
    const ids: string[] = [];
    const seenIds = new Set<string>();
    for (const r of results) {
      for (const id of [r.source_id, r.target_id]) {
        if (ids.length >= limit) break;
        if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); }
      }
      if (ids.length >= limit) break;
    }
    nodeIds = ids;
  }
  if (!nodeIds.length) return { nodes: [], edges: [] };

  const nodeRows = new Map<string, Record<string, any>>();
  for (let i = 0; i < nodeIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = nodeIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, importance_score, created_at FROM entries WHERE id IN (${ph})`
    ).bind(...batch).all() as { results: Record<string, any>[] };
    for (const r of results) nodeRows.set(r.id as string, r);
  }

  const nodes: GraphView["nodes"] = [];
  for (const id of nodeIds) {
    const r = nodeRows.get(id);
    if (!r) continue;
    const tags: string[] = JSON.parse(r.tags ?? "[]");
    nodes.push({
      id,
      label: (r.content as string).slice(0, 80),
      tags,
      kind: getKind(tags),
      status: getStatus(tags),
      importance: (r.importance_score as number) ?? 0,
      created_at: r.created_at as number,
    });
  }
  const nodeIdSet = new Set(nodes.map(n => n.id));
  if (!nodeIdSet.size) return { nodes: [], edges: [] };

  const presentIds = [...nodeIdSet];
  const edgeSeen = new Set<string>();
  const edges: GraphView["edges"] = [];
  for (let i = 0; i < presentIds.length; i += EDGE_QUERY_BATCH) {
    const batch = presentIds.slice(i, i + EDGE_QUERY_BATCH);
    const ph = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges WHERE source_id IN (${ph}) OR target_id IN (${ph}) ORDER BY weight DESC`
    ).bind(...batch, ...batch).all() as { results: any[] };
    for (const e of results) {
      if (!nodeIdSet.has(e.source_id) || !nodeIdSet.has(e.target_id)) continue;
      const key = `${e.source_id}|${e.target_id}|${e.type}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ source: e.source_id, target: e.target_id, type: e.type, weight: e.weight, provenance: e.provenance });
    }
  }

  return { nodes, edges };
}

export async function neighborsFromVectorQuery(values: number[], env: Env): Promise<{ id: string; score: number }[]> {
  const { matches } = await env.VECTORIZE.query(values, { topK: 5, returnMetadata: "all" });
  const scores = new Map<string, number>();
  for (const m of matches) {
    const pid = (m.metadata as any)?.parentId ?? m.id;
    scores.set(pid, Math.max(scores.get(pid) ?? 0, m.score));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score }));
}
