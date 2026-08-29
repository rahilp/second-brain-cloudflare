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

/**
 * The INSERT createEdge issues, prepared and bound but not run — so a caller
 * with several edges to write can hand them all to env.DB.batch(...) as one
 * subrequest instead of paying one subrequest per createEdge call.
 *
 * Symmetric-type reordering and the weight clamp live here, not in createEdge,
 * so a batched caller gets them too rather than just the direct one.
 *
 * `workspaceId` is the SOURCE entry's workspace, copied rather than left to the
 * column default: edges.workspace_id is denormalized from the source entry so a
 * scoped graph walk needs no join (see schema.sql). Callers that know it pass it;
 * "" keeps the legacy-owner value and changes nothing for pre-tenancy rows.
 */
export function edgeInsertStatement(
  sourceId: string,
  targetId: string,
  type: string,
  opts: { weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>; created_at?: number; workspaceId?: string },
  env: Env,
): D1PreparedStatement | null {
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

  return env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`
  ).bind(crypto.randomUUID(), source, target, type, weight, provenance, metadata, createdAt, now, opts.workspaceId ?? "");
}

export async function createEdge(
  sourceId: string,
  targetId: string,
  type: string,
  opts: { weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>; created_at?: number; workspaceId?: string },
  env: Env,
): Promise<{ source_id: string; target_id: string; type: EdgeType } | null> {
  const stmt = edgeInsertStatement(sourceId, targetId, type, opts, env);
  if (!stmt) return null;
  await stmt.run();

  let source = sourceId;
  let target = targetId;
  if (isValidEdgeType(type) && isSymmetric(type) && source > target) [source, target] = [target, source];

  return { source_id: source, target_id: target, type: type as EdgeType };
}

export async function deleteEdge(
  sourceId: string,
  targetId: string,
  type: string | undefined,
  env: Env,
): Promise<number> {
  // scope-exempt: by-id: both endpoints checked readable at the route/MCP edge
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
  if (!top.length) return;

  // Edges inherit the SOURCE entry's workspace rather than the column default:
  // the nightly graph backfill (src/graph/pass.ts) runs corpus-wide by design, and
  // without this copy every edge it inferred would land in "" no matter which
  // workspace the entry itself lives in — invisible to that owner's scoped walks.
  // One read per write batch; ids are globally unique so no scoping is needed.
  const source = await env.DB.prepare(
    `SELECT workspace_id FROM entries WHERE id = ?`
  ).bind(newId).first<{ workspace_id: string | null }>();
  const workspaceId = source?.workspace_id ?? "";

  for (const n of top) {
    await createEdge(newId, n.id, "relates_to", { weight: n.score, provenance: "inferred", workspaceId }, env);
  }
}
