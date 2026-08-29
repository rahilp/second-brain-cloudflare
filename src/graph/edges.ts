import type { MemoryKind } from "../memory/kind";
import type { Env } from "../env";
import { EDGE_TYPES, type EdgeProvenance, type EdgeType } from "./types";

const DEFAULT_EDGE_WEIGHT = 0.5;

/**
 * What POST /link and the MCP `link` tool both say when a caller asks to join two
 * entries that live in different workspaces.
 *
 * One constant rather than two string literals: the two surfaces are one
 * operation, and the repo's parity convention (test/integration/update-parity.test.ts)
 * is that they must not be able to drift. It names a fix, because the alternative
 * the user is offered is otherwise invisible.
 *
 * It says "workspace" and not "layer", and it does not name WHICH side to move,
 * because the check is `source.workspace_id !== target.workspace_id` and three
 * shapes reach it — only one of which has a personal side:
 *
 *   - personal <-> company, the ordinary case;
 *   - company A <-> company B, for a member of two teams: both are the company
 *     layer, so "layer" is the wrong word and neither is personal;
 *   - "" <-> anything, for an admin: "" is the legacy/system space, and no share
 *     moves an entry INTO it.
 *
 * Naming the personal one was a single-team assumption, which spec item 4.1
 * forbids introducing.
 */
export const CROSS_WORKSPACE_LINK_MESSAGE =
  "Both memories must be in the same workspace — move one into the other's workspace first";

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
  //
  // The neighbours' workspaces come back from the SAME statement, which is what
  // makes the check below free: one read per write batch either way, no
  // per-neighbour subrequest. Ids are globally unique, so a by-id read needs no
  // scope clause of its own.
  const ids = [newId, ...top.map(n => n.id)];
  const { results } = await env.DB.prepare(
    // scope-exempt: by-id: reads each endpoint's own workspace, to stamp the edge with the source's and to refuse a pair whose workspaces disagree
    `SELECT id, workspace_id FROM entries WHERE id IN (${ids.map(() => "?").join(", ")})`
  ).bind(...ids).all() as { results: { id: string; workspace_id: string | null }[] };
  const workspaceById = new Map(results.map(r => [r.id, r.workspace_id ?? ""]));
  const workspaceId = workspaceById.get(newId) ?? "";

  for (const n of top) {
    // Two different members' private entries are never linked, whatever the
    // vector index returned. The write paths that call this DO filter their
    // Vectorize query by workspace, but that filter is best-effort by contract
    // (src/vectorize/scope.ts degrades to an unfiltered query on a filter-shaped
    // rejection and latches it per isolate) — so this is the check that still
    // holds in the degraded mode, and the one that makes the invariant true
    // rather than likely.
    //
    // A neighbour with no `entries` row at all — a vector whose entry has since
    // been forgotten — is NOT refused here. It has no workspace to disagree
    // with, so it is not the case this check is about, and the edge it produces
    // is inert: every graph read hydrates its endpoints through the caller's
    // scope and drops the ones that are missing. Narrowing that too would change
    // what the pass does for a reason unrelated to tenancy.
    //
    // Within one workspace nothing changes at all, which is every pair on a
    // solo brain.
    const neighborWorkspace = workspaceById.get(n.id);
    if (neighborWorkspace !== undefined && neighborWorkspace !== workspaceId) continue;
    await createEdge(newId, n.id, "relates_to", { weight: n.score, provenance: "inferred", workspaceId }, env);
  }
}
