import { getKind, type MemoryKind } from "../memory/kind";
import type { Env } from "../env";
import { EDGE_TYPES, type EdgeProvenance, type EdgeType } from "./types";
import { MIRRORED_SOURCES } from "../constants";

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
 * Does a pair of memory kinds satisfy an edge type's `allowedKinds`?
 *
 * One gate for every writer — POST /link, the MCP link tool, capture-time
 * `follows` and the insight pass — because a type whose meaning depends on the
 * kinds it joins is only as good as the least careful writer.
 *
 * An unknown kind is refused rather than waved through: `null` means the
 * classifier has not spoken yet, which is not evidence the pair qualifies.
 * Types with no constraint (`allowedKinds: null`) accept anything, unknown
 * included.
 */
export function kindsAllowEdge(
  type: EdgeType,
  sourceKind: MemoryKind | null,
  targetKind: MemoryKind | null,
): boolean {
  const allowed = allowedKindsFor(type);
  if (!allowed) return true;
  if (sourceKind === null || targetKind === null) return false;
  return allowed.includes(sourceKind) && allowed.includes(targetKind);
}

/**
 * How close two episodic captures must sit to read as one train of thought.
 *
 * A module constant and deliberately NOT config: it is a claim about how people
 * write, not a deployment knob, and every brain that tuned it separately would
 * make `follows` mean something different per brain — which is exactly what the
 * type exists to stop. Start at 30 minutes; GET /stats/graph?deep=1 reports the
 * real gap distribution, which is what should move it.
 */
export const GRAPH_FOLLOWS_WINDOW_MS = 30 * 60_000;

/**
 * What POST /link and the MCP `link` tool both say when the two memories' kinds
 * do not permit the requested type. One sentence in one place, for the same
 * parity reason as CROSS_WORKSPACE_LINK_MESSAGE: the two surfaces are one
 * operation and must not drift.
 *
 * It names the fix, because "not allowed" alone leaves the caller guessing —
 * an unclassified memory looks identical to a wrongly-classified one from
 * outside.
 */
export function kindMismatchMessage(type: EdgeType): string {
  const allowed = allowedKindsFor(type)?.join(" or ") ?? "";
  return `${edgeLabel(type)} links only ${allowed} memories — both entries must be classified ${allowed} first`;
}

/** The kind on an entry row whose `tags` column was projected, or null. */
export function kindOfRow(row: { tags?: string | null }): MemoryKind | null {
  try {
    return getKind(JSON.parse(row.tags ?? "[]"));
  } catch {
    return null;
  }
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
  opts: {
    weight?: number; provenance?: EdgeProvenance; metadata?: Record<string, unknown>;
    created_at?: number; workspaceId?: string;
    /**
     * Write nothing if the pair already carries an edge of any type other than
     * relates_to. For the GENERIC edge only: a typed edge is the more specific
     * statement, and laying an undirected relates_to beside it says less about
     * the same pair while competing with it for the fanout cap.
     *
     * Expressed in the statement rather than as a lookup, so it costs no
     * additional D1 call — the whole reason edge writes are batched.
     */
    onlyIfNoTypedEdge?: boolean;
  },
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

  const values = [crypto.randomUUID(), source, target, type, weight, provenance, metadata, createdAt, now, opts.workspaceId ?? ""];

  if (opts.onlyIfNoTypedEdge) {
    // INSERT ... SELECT rather than VALUES, because only the SELECT form takes a
    // WHERE. SQLite needs that WHERE for the upsert clause to parse unambiguously
    // after a SELECT, which this has.
    return env.DB.prepare(
      // scope-exempt: by-id: the guard reads only the pair being written, whose endpoints the caller has already workspace-checked
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM edges g
         WHERE ((g.source_id = ? AND g.target_id = ?) OR (g.source_id = ? AND g.target_id = ?))
           AND g.type <> 'relates_to')
       ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`
    ).bind(...values, source, target, target, source);
  }

  return env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`
  ).bind(...values);
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
  opts: { suppressId?: string; newKind?: MemoryKind | null } = {},
): Promise<void> {
  // `suppressId` is the entry capture already flagged this one as a duplicate
  // of. It is the highest-scoring neighbour by construction, so left alone it
  // takes an inference slot to record what the duplicate-candidate tag says.
  const top = neighbors
    .filter(n => n.id !== newId && n.id !== opts.suppressId && n.score >= EDGE_INFER_THRESHOLD)
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
    `SELECT id, workspace_id, tags, created_at, source FROM entries WHERE id IN (${ids.map(() => "?").join(", ")})`
  ).bind(...ids).all() as { results: { id: string; workspace_id: string | null; tags: string | null; created_at: number | null; source: string | null }[] };
  const workspaceById = new Map(results.map(r => [r.id, r.workspace_id ?? ""]));
  const workspaceId = workspaceById.get(newId) ?? "";
  const statements: D1PreparedStatement[] = [];

  // tags and created_at ride along on the statement above rather than costing a
  // second read: the neighbour's kind is in its tags, and `follows` needs both
  // ends' timestamps to know which way it points.
  const kindById = new Map(results.map(r => {
    let tags: string[] = [];
    try { tags = JSON.parse(r.tags ?? "[]"); } catch { tags = []; }
    return [r.id, getKind(tags)];
  }));
  const createdAtById = new Map(results.map(r => [r.id, r.created_at]));
  const sourceById = new Map(results.map(r => [r.id, r.source ?? ""]));

  /**
   * The kind the `follows` gate reads.
   *
   * The caller passes one only on the capture path, where the classifier has
   * just run and `null` is a real answer meaning classification failed — so an
   * explicit null is honoured rather than second-guessed from the tags. Every
   * other caller (the nightly backfill, the update path, the append path) passes
   * nothing, and for those the row's own classifier kind is already in hand from
   * the SELECT above. Without this fallback those three paths could never type
   * an edge at all, which matters because a Vectorize write is not immediately
   * queryable: the predecessor written moments ago is often invisible to capture
   * and only ever seen by the backfill.
   */
  const newKind = opts.newKind !== undefined ? opts.newKind : (kindById.get(newId) ?? null);

  /**
   * A mirrored record is a mailbox or calendar entry, not a thought someone had
   * next. An import writes dozens of them minutes apart, and typing those as
   * `follows` would describe the order the mailbox synced — the shape of a bulk
   * write, which is the artefact the burst guard already refuses by another
   * route. Cheap to exclude: the source is on the row the workspace check reads.
   */
  const mirrored = (id: string) => MIRRORED_SOURCES.has(sourceById.get(id) ?? "");

  const newCreatedAt = createdAtById.get(newId) ?? null;
  // Absent from the read means the entry does not exist, which is refused
  // below — so an unknown neighbour is not "same workspace" either.
  const sameWorkspace = (id: string) => workspaceById.get(id) === workspaceId;
  /** Strictly earlier than the new entry, and close enough to be one thought. */
  const precedesInWindow = (id: string) => {
    const at = createdAtById.get(id);
    if (newCreatedAt === null || at === null || at === undefined) return false;
    const gap = newCreatedAt - at;
    return gap > 0 && gap <= GRAPH_FOLLOWS_WINDOW_MS;
  };

  // The burst guard. A bulk import or a chunked transcript writes many episodic
  // entries at once, and each would "follow" the last — a chain that records the
  // shape of the write rather than the thinking. So `follows` is claimed only
  // when exactly one candidate qualifies. Measured over the neighbours that were
  // going to be linked anyway, which costs nothing; it is not a general check
  // for "what else was written in this window", which would need its own read.
  const qualifying = mirrored(newId) ? [] : top.filter(n =>
    sameWorkspace(n.id)
    && !mirrored(n.id)
    && kindsAllowEdge("follows", newKind, kindById.get(n.id) ?? null)
    && precedesInWindow(n.id));
  const followsTarget = qualifying.length === 1 ? qualifying[0].id : null;

  for (const n of top) {
    // Two different members' private entries are never linked, whatever the
    // vector index returned. This is the ENFORCEMENT, not a backstop behind one:
    // of the three paths that reach here, two send the vector index no workspace
    // filter at all.
    //
    //   - src/graph/pass.ts (nightly backfill) queries unfiltered on purpose —
    //     its candidate rows include entries whose vectors predate workspace
    //     stamping, so a filter on that field can match nothing (see the comment
    //     there);
    //   - src/capture/store.ts's append and update paths go through
    //     neighborsFromVectorQuery (src/graph/traverse.ts), a plain unfiltered
    //     query;
    //   - only src/capture/entry.ts's capture path filters, via
    //     checkDuplicateAndContradiction — and that filter is best-effort by
    //     contract anyway (src/vectorize/scope.ts degrades to an unfiltered query
    //     on a filter-shaped rejection and latches it per isolate).
    //
    // So a foreign neighbour arriving here is the ordinary case rather than the
    // degraded one, and this check — which reads both endpoints' workspaces from
    // `entries`, the authoritative source, never from vector metadata — is the
    // only thing that makes the invariant true.
    //
    // A neighbour with no `entries` row at all — a vector that outlived the
    // entry it indexed — is refused here too, which it did NOT used to be.
    //
    // The edge such a neighbour produces is unreachable: every graph read
    // hydrates both endpoints through the caller's scope and drops what is
    // missing. It was tolerated on the grounds that it changed nothing. It does
    // now, in two ways:
    //
    //   - the nightly sweep (src/graph/pass.ts) deletes inferred edges with a
    //     missing endpoint, which makes the source edgeless, which returns it to
    //     the backfill's slate, which draws the same edge again. Left alone the
    //     two passes trade the same row back and forth every night, spending an
    //     embed, a Vectorize query and one of 25 backfill slots each time;
    //   - a dangling id is not permanently dangling. src/entries/import.ts
    //     accepts caller-supplied ids, so a later import can create a row with
    //     that id in ANOTHER workspace and turn this into a live crossing edge.
    //
    // Refusing costs nothing: the absence is already visible in the endpoint
    // read above. Within one workspace nothing else changes, which is every pair
    // on a solo brain.
    if (workspaceById.get(n.id) !== workspaceId) continue;

    if (n.id === followsTarget) {
      // Typed replaces generic: an earlier pass may already have drawn the
      // undirected relates_to this edge supersedes. Only the INFERRED one goes
      // — a relates_to the user drew themselves is a statement, not a guess.
      //
      // Ordered immediately before the insert in the same batch, because the
      // two are one replacement: issued as separate calls, a failure between
      // them leaves the pair with no edge at all, which is worse than either
      // the old edge or the new one.
      statements.push(env.DB.prepare(
        // scope-exempt: by-id: the pair whose typed edge is being written, both endpoints already workspace-checked above
        `DELETE FROM edges
         WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
           AND type = 'relates_to' AND provenance = 'inferred'`,
      ).bind(newId, n.id, n.id, newId));
      const typed = edgeInsertStatement(newId, n.id, "follows", { weight: n.score, provenance: "inferred", workspaceId }, env);
      if (typed) statements.push(typed);
      continue;
    }

    // Guarded: a later write touching a pair that already has a typed edge —
    // an edit, an append, the nightly backfill — falls to this branch outside
    // the follows window and would otherwise stack relates_to on top of it.
    const generic = edgeInsertStatement(newId, n.id, "relates_to", { weight: n.score, provenance: "inferred", workspaceId, onlyIfNoTypedEdge: true }, env);
    if (generic) statements.push(generic);
  }

  // One call for every edge this write produces. Capture spends most of a
  // Worker's 50-subrequest budget embedding chunks before it ever gets here, so
  // a call per edge is what puts a large multi-chunk capture over the line.
  if (statements.length) await env.DB.batch(statements);
}
