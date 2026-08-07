import type { MemoryKind } from "../memory/kind";
import type { Env } from "../env";
import { EDGE_TYPES, type EdgeProvenance, type EdgeType } from "./types";

const DEFAULT_EDGE_WEIGHT = 0.5;

export function isValidEdgeType(type: string): type is EdgeType {
  return Object.prototype.hasOwnProperty.call(EDGE_TYPES, type);
}

export function isSymmetric(type: EdgeType): boolean {
  return !EDGE_TYPES[type].directed;
}

export function edgeLabel(type: EdgeType): string {
  return EDGE_TYPES[type].label;
}

export function allowedKindsFor(type: EdgeType): readonly MemoryKind[] | null {
  return EDGE_TYPES[type].allowedKinds;
}

export async function createEdge(
  sourceId: string,
  targetId: string,
  type: string,
  opts: { weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>; created_at?: number },
  env: Env,
): Promise<{ source_id: string; target_id: string; type: EdgeType } | null> {
  if (!isValidEdgeType(type)) return null;
  if (sourceId === targetId) return null;

  let source = sourceId;
  let target = targetId;
  if (isSymmetric(type) && source > target) [source, target] = [target, source];

  const weight = Math.max(0, Math.min(1, opts.weight ?? DEFAULT_EDGE_WEIGHT));
  const provenance = opts.provenance ?? "inferred";
  const metadata = JSON.stringify(opts.metadata ?? {});
  const now = Date.now();
  const createdAt = opts.created_at ?? now;

  await env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`
  ).bind(crypto.randomUUID(), source, target, type, weight, provenance, metadata, createdAt, now).run();

  return { source_id: source, target_id: target, type };
}

export async function deleteEdge(
  sourceId: string,
  targetId: string,
  type: string | undefined,
  env: Env,
): Promise<number> {
  let sql = `DELETE FROM edges WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`;
  const bindings: string[] = [sourceId, targetId, targetId, sourceId];
  if (type) {
    sql += ` AND type = ?`;
    bindings.push(type);
  }
  const result = await env.DB.prepare(sql).bind(...bindings).run();
  return result.meta.changes ?? 0;
}

const EDGE_INFER_THRESHOLD = 0.78;
const EDGE_INFER_MAX = 3;

export async function inferEdgesOnWrite(
  newId: string,
  neighbors: { id: string; score: number }[],
  env: Env,
): Promise<void> {
  const top = neighbors
    .filter(n => n.id !== newId && n.score >= EDGE_INFER_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, EDGE_INFER_MAX);
  for (const n of top) {
    await createEdge(newId, n.id, "relates_to", { weight: n.score, provenance: "inferred" }, env);
  }
}
