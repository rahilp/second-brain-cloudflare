import type { Env } from "../env";
import { D1_MAX_BOUND_PARAMS } from "../constants";
import { isSymmetric, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";

/**
 * Default page size: array positions examined per call, inserts and skips alike.
 * Sized so a worst-case page (one existence lookup + one insert batch, then the
 * same again for edges) stays well inside the D1 free plan's ~50 queries per
 * invocation, with room for the schema-init probe on a cold isolate.
 */
export const IMPORT_DEFAULT_LIMIT = 40;
export const IMPORT_MAX_LIMIT = 1000;
/** D1 batch chunk size for inserts. */
export const IMPORT_D1_BATCH_SIZE = 50;
/** Edge endpoint lookups bind each id twice (source IN + target IN). */
export const EDGE_ENDPOINT_QUERY_BATCH = Math.floor(D1_MAX_BOUND_PARAMS / 2);

const ENTRY_INSERT_SQL_TEMPLATE =
  `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, recall_count, importance_score, contradiction_wins, contradiction_losses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseInsertColumns(sql: string): readonly string[] {
  const match = sql.match(/INSERT INTO entries \(([^)]+)\)/i);
  if (!match) throw new Error("INSERT INTO entries missing column list");
  return match[1].split(",").map(c => c.trim());
}

export const ENTRY_INSERT_COLUMNS = parseInsertColumns(ENTRY_INSERT_SQL_TEMPLATE);
export const ENTRY_INSERT_SQL = ENTRY_INSERT_SQL_TEMPLATE;

export type ImportEntryStatus = "imported" | "skipped" | "failed";
export type ImportEdgeStatus = "imported" | "skipped" | "failed";

export interface ImportEntryResult {
  id: string;
  status: ImportEntryStatus;
  reason?: string;
  detail?: string;
}

export interface ImportEdgeResult {
  source_id: string;
  target_id: string;
  type: string;
  status: ImportEdgeStatus;
  reason?: string;
  detail?: string;
}

export type ImportResultItem = ImportEntryResult | ImportEdgeResult;

export interface ExportEntry {
  id: string;
  content: string;
  tags?: string[];
  source?: string;
  created_at?: number;
  updated_at?: number;
  recall_count?: number;
  importance_score?: number;
  contradiction_wins?: number;
  contradiction_losses?: number;
}

export interface ExportEdge {
  source_id: string;
  target_id: string;
  type?: string;
  weight?: number;
  provenance?: string;
  created_at?: number;
}

export interface ExportPayload {
  version?: number;
  entries: ExportEntry[];
  edges?: ExportEdge[];
}

export interface ImportOptions {
  /** Page size — how many array positions of `entries` (then `edges`) one call examines. */
  limit?: number;
  /** Index into `entries` where this call's page starts. */
  offset?: number;
  /** Index into `edges` where this call's page starts. */
  edgeOffset?: number;
}

export interface ImportSummary {
  ok: true;
  imported: number;
  skipped: number;
  failed: number;
  edges_imported: number;
  edges_skipped: number;
  edges_failed: number;
  remaining_entries: number;
  remaining_edges: number;
  /** Pass back as ?offset= to continue. Equals entries.length when entries are done. */
  next_offset: number;
  /** Pass back as ?edge_offset= to continue. Advances only once entries are done. */
  next_edge_offset: number;
  results: ImportResultItem[];
  vectorize_hint: string;
}

interface PendingEdge {
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  provenance: EdgeProvenance;
  created_at: number;
}

const DEFAULT_EDGE_WEIGHT = 0.5;

interface PendingInsert {
  id: string;
  content: string;
  tags: string[];
  source: string;
  created_at: number;
  /** Validated payload value, defaulted to created_at — camelCase per the in-memory convention (see recall's updatedAt). */
  updatedAt: number;
  recall_count: number;
  importance_score: number;
  contradiction_wins: number;
  contradiction_losses: number;
}

function isValidProvenance(p: string): p is EdgeProvenance {
  return (PROVENANCE_VALUES as readonly string[]).includes(p);
}

export function isImportRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseTags(
  tags: unknown,
): { ok: true; tags: string[] } | { ok: false; reason: "invalid_tag" } {
  if (tags === undefined || tags === null) return { ok: true, tags: [] };
  if (!Array.isArray(tags)) return { ok: false, reason: "invalid_tag" };
  if (!tags.every(t => typeof t === "string")) return { ok: false, reason: "invalid_tag" };
  return { ok: true, tags };
}

export function normalizedEdgeKey(sourceId: string, targetId: string, type: string): string {
  let source = sourceId;
  let target = targetId;
  if (isValidEdgeType(type) && isSymmetric(type) && source > target) {
    [source, target] = [target, source];
  }
  return `${source}\0${target}\0${type}`;
}

export function parseRequiredString(
  value: unknown,
  missingReason: string,
  invalidReason: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, reason: missingReason };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: invalidReason };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: missingReason };
  return { ok: true, value: trimmed };
}

export function formatDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

export function parseImportBody(
  body: unknown,
): { ok: true; payload: ExportPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const o = body as Record<string, unknown>;
  if (o.version !== undefined && o.version !== 2) return { ok: false, error: "version must be 2" };
  if (!Array.isArray(o.entries)) return { ok: false, error: "entries must be an array" };
  return {
    ok: true,
    payload: {
      version: o.version as number | undefined,
      entries: o.entries as ExportEntry[],
      edges: o.edges as ExportEdge[] | undefined,
    },
  };
}

export function parseImportOffset(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function parseImportLimit(raw: string | null): number {
  if (!raw) return IMPORT_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return IMPORT_DEFAULT_LIMIT;
  return Math.min(n, IMPORT_MAX_LIMIT);
}

async function loadExistingIds(env: Env, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!ids.length) return found;
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id FROM entries WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string }[] };
    for (const row of results) found.add(row.id);
  }
  return found;
}

async function loadExistingEdgeKeys(env: Env, endpoints: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!endpoints.length) return keys;
  for (let i = 0; i < endpoints.length; i += EDGE_ENDPOINT_QUERY_BATCH) {
    const batch = endpoints.slice(i, i + EDGE_ENDPOINT_QUERY_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT source_id, target_id, type FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    ).bind(...batch, ...batch).all() as {
      results: { source_id: string; target_id: string; type: string }[];
    };
    for (const row of results) keys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
  }
  return keys;
}

export function parseEdgeWeight(
  weight: unknown,
): { ok: true; value: number } | { ok: false; reason: "invalid_weight" } {
  if (weight === undefined || weight === null) return { ok: true, value: DEFAULT_EDGE_WEIGHT };
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { ok: false, reason: "invalid_weight" };
  return { ok: true, value: Math.max(0, Math.min(1, weight)) };
}

type NumericFieldReason =
  | "invalid_recall_count"
  | "invalid_importance_score"
  | "invalid_contradiction_wins"
  | "invalid_contradiction_losses";

export function parseOptionalNumber(
  value: unknown,
  invalidReason: NumericFieldReason,
): { ok: true; value: number } | { ok: false; reason: NumericFieldReason } {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: invalidReason };
  return { ok: true, value };
}

export function parseCreatedAt(
  value: unknown,
): { ok: true; value: number } | { ok: false; reason: "invalid_created_at" } {
  if (value === undefined || value === null) return { ok: true, value: Date.now() };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "invalid_created_at" };
  return { ok: true, value };
}

function bindInsert(env: Env, row: PendingInsert) {
  return env.DB.prepare(ENTRY_INSERT_SQL).bind(
    row.id,
    row.content,
    JSON.stringify(row.tags),
    row.source,
    row.created_at,
    row.updatedAt,
    "[]",
    row.recall_count,
    row.importance_score,
    row.contradiction_wins,
    row.contradiction_losses,
  );
}

async function flushInsertBatch(
  env: Env,
  batch: PendingInsert[],
  existingIds: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
): Promise<void> {
  if (!batch.length) return;

  const stmts = batch.map(row => bindInsert(env, row));
  try {
    await env.DB.batch(stmts);
    for (const row of batch) {
      existingIds.add(row.id);
      counters.imported++;
      results.push({ id: row.id, status: "imported" });
    }
  } catch {
    for (const row of batch) {
      try {
        await bindInsert(env, row).run();
        existingIds.add(row.id);
        counters.imported++;
        results.push({ id: row.id, status: "imported" });
      } catch (e) {
        counters.failed++;
        results.push({
          id: row.id,
          status: "failed",
          reason: "insert_error",
          detail: formatDbError(e),
        });
      }
    }
  }
}

function bindEdgeInsert(env: Env, edge: PendingEdge) {
  let source = edge.source_id;
  let target = edge.target_id;
  if (isValidEdgeType(edge.type) && isSymmetric(edge.type) && source > target) {
    [source, target] = [target, source];
  }
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight = max(weight, excluded.weight), updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), source, target, edge.type, edge.weight, edge.provenance, "{}", edge.created_at, now);
}

async function flushEdgeBatch(
  env: Env,
  batch: PendingEdge[],
  existingEdgeKeys: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
): Promise<void> {
  if (!batch.length) return;

  const stmts = batch.map(row => bindEdgeInsert(env, row));
  try {
    await env.DB.batch(stmts);
    for (const row of batch) {
      const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
      existingEdgeKeys.add(key);
      counters.imported++;
      results.push({
        source_id: row.source_id,
        target_id: row.target_id,
        type: row.type,
        status: "imported",
      });
    }
  } catch {
    for (const row of batch) {
      try {
        await bindEdgeInsert(env, row).run();
        const key = normalizedEdgeKey(row.source_id, row.target_id, row.type);
        existingEdgeKeys.add(key);
        counters.imported++;
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          type: row.type,
          status: "imported",
        });
      } catch (e) {
        counters.failed++;
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          type: row.type,
          status: "failed",
          reason: "create_failed",
          detail: formatDbError(e),
        });
      }
    }
  }
}

/**
 * One page of a restore. `offset`/`edgeOffset` are positions in the payload arrays,
 * and a call examines exactly one page: entries[offset .. offset+limit), then — only
 * once the entries array is exhausted — edges[edgeOffset .. edgeOffset+limit).
 *
 * Positional paging is what keeps the cost flat on the D1 free plan (~50 queries per
 * invocation). Each page resolves only its own ids: one chunked existence lookup plus
 * one insert batch, so a default page costs 2-3 round trips whether the file holds
 * 40 entries or 50,000, and page 500 costs the same as page 1. The alternative —
 * scanning from the top and skipping — re-resolves every already-imported id on
 * every call, which is how a 5,000-entry restore spends its whole daily budget
 * before finishing.
 *
 * Re-running a page is safe: existing ids and edge keys are skipped, and the
 * ON CONFLICT upsert makes a re-inserted edge a weight merge rather than an error.
 */
export async function importExportPayload(
  env: Env,
  body: ExportPayload,
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  const limit = opts.limit ?? IMPORT_DEFAULT_LIMIT;
  const entries = body.entries;
  const edges = body.edges ?? [];
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), entries.length);
  const edgeOffset = Math.min(Math.max(opts.edgeOffset ?? 0, 0), edges.length);

  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let edges_imported = 0;
  let edges_skipped = 0;
  let edges_failed = 0;

  // ---- entries page ------------------------------------------------------------
  const page = entries.slice(offset, offset + limit);
  const next_offset = offset + page.length;

  // Parse the whole page before touching D1, so the existence lookup can be one
  // chunked query over exactly the ids that might insert.
  const parsedPage: ({ row: PendingInsert } | { failure: ImportEntryResult })[] = [];
  for (const entry of page) {
    parsedPage.push(parseEntryRow(entry));
  }

  const pageIds = [...new Set(parsedPage.flatMap(p => ("row" in p ? [p.row.id] : [])))];
  const existingIds = await loadExistingIds(env, pageIds);

  const pendingBatch: PendingInsert[] = [];
  const batchCounters = { imported: 0, failed: 0 };
  for (const p of parsedPage) {
    if ("failure" in p) {
      failed++;
      results.push(p.failure);
      continue;
    }
    if (existingIds.has(p.row.id)) {
      skipped++;
      continue;
    }
    // Marking the id as seen at queue time makes a duplicate later in the same page
    // a skip; letting it into the batch would be a PRIMARY KEY conflict that fails
    // the whole batch into the per-row fallback.
    existingIds.add(p.row.id);
    pendingBatch.push(p.row);

    if (pendingBatch.length >= IMPORT_D1_BATCH_SIZE) {
      await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters);
    }
  }
  if (pendingBatch.length) {
    await flushInsertBatch(env, pendingBatch.splice(0), existingIds, results, batchCounters);
  }
  imported += batchCounters.imported;
  failed += batchCounters.failed;

  const remaining_entries = entries.length - next_offset;

  // ---- edges page --------------------------------------------------------------
  // Deferred until the entries array is exhausted, so every endpoint an edge can
  // name either predates this import or was written by an earlier page.
  let next_edge_offset = edgeOffset;
  if (remaining_entries === 0) {
    const edgePage = edges.slice(edgeOffset, edgeOffset + limit);
    next_edge_offset = edgeOffset + edgePage.length;

    type ParsedEdge = { edge: PendingEdge } | { failure: ImportEdgeResult };
    const parsedEdges: ParsedEdge[] = [];
    for (const edge of edgePage) {
      parsedEdges.push(parseEdgeRow(edge));
    }

    // Endpoints this call has not already proven to exist (entries imported above
    // are in existingIds), resolved in one chunked query.
    const endpoints = [
      ...new Set(parsedEdges.flatMap(p => ("edge" in p ? [p.edge.source_id, p.edge.target_id] : []))),
    ];
    const unknown = endpoints.filter(id => !existingIds.has(id));
    for (const id of await loadExistingIds(env, unknown)) existingIds.add(id);
    const existingEdgeKeys = await loadExistingEdgeKeys(env, endpoints);

    const pendingEdgeBatch: PendingEdge[] = [];
    const edgeBatchCounters = { imported: 0, failed: 0 };
    for (const p of parsedEdges) {
      if ("failure" in p) {
        edges_failed++;
        results.push(p.failure);
        continue;
      }
      const { source_id, target_id, type } = p.edge;
      if (!existingIds.has(source_id) || !existingIds.has(target_id)) {
        edges_failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: "missing_endpoint" });
        continue;
      }
      const edgeKey = normalizedEdgeKey(source_id, target_id, type);
      if (existingEdgeKeys.has(edgeKey)) {
        edges_skipped++;
        continue;
      }
      existingEdgeKeys.add(edgeKey);
      pendingEdgeBatch.push(p.edge);

      if (pendingEdgeBatch.length >= IMPORT_D1_BATCH_SIZE) {
        await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters);
      }
    }
    if (pendingEdgeBatch.length) {
      await flushEdgeBatch(env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters);
    }
    edges_imported += edgeBatchCounters.imported;
    edges_failed += edgeBatchCounters.failed;
  }

  return {
    ok: true,
    imported,
    skipped,
    failed,
    edges_imported,
    edges_skipped,
    edges_failed,
    remaining_entries,
    remaining_edges: edges.length - next_edge_offset,
    next_offset,
    next_edge_offset,
    results,
    vectorize_hint: "POST /vectorize-pending until remaining is 0",
  };
}

/** Parse one entry row into an insertable record, or the failure to report. */
function parseEntryRow(entry: ExportEntry): { row: PendingInsert } | { failure: ImportEntryResult } {
  if (!isImportRecordObject(entry)) {
    return { failure: { id: "", status: "failed", reason: "invalid_entry" } };
  }
  const idParsed = parseRequiredString(entry.id, "missing_id", "invalid_id");
  if (!idParsed.ok) {
    const id = typeof entry.id === "string" ? entry.id : String(entry.id ?? "");
    return { failure: { id, status: "failed", reason: idParsed.reason } };
  }
  const id = idParsed.value;

  const contentParsed = parseRequiredString(entry.content, "missing_content", "invalid_content");
  if (!contentParsed.ok) return { failure: { id, status: "failed", reason: contentParsed.reason } };

  const tagsParsed = parseTags(entry.tags);
  if (!tagsParsed.ok) return { failure: { id, status: "failed", reason: tagsParsed.reason } };

  let source = "import";
  if (entry.source !== undefined && entry.source !== null) {
    if (typeof entry.source !== "string") {
      return { failure: { id, status: "failed", reason: "invalid_source" } };
    }
    source = entry.source.trim() || "import";
  }

  const createdAtParsed = parseCreatedAt(entry.created_at);
  if (!createdAtParsed.ok) return { failure: { id, status: "failed", reason: createdAtParsed.reason } };
  const created_at = createdAtParsed.value;

  // Absent in exports taken before /export carried the field; created_at is what the
  // column would have coalesced to anyway. A restore must not launder a bad value into
  // a "recently touched" ranking signal, so a malformed one fails the row instead.
  const updatedAt = entry.updated_at ?? created_at;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return { failure: { id, status: "failed", reason: "invalid_updated_at" } };
  }

  const recallCountParsed = parseOptionalNumber(entry.recall_count, "invalid_recall_count");
  if (!recallCountParsed.ok) return { failure: { id, status: "failed", reason: recallCountParsed.reason } };
  const importanceParsed = parseOptionalNumber(entry.importance_score, "invalid_importance_score");
  if (!importanceParsed.ok) return { failure: { id, status: "failed", reason: importanceParsed.reason } };
  const winsParsed = parseOptionalNumber(entry.contradiction_wins, "invalid_contradiction_wins");
  if (!winsParsed.ok) return { failure: { id, status: "failed", reason: winsParsed.reason } };
  const lossesParsed = parseOptionalNumber(entry.contradiction_losses, "invalid_contradiction_losses");
  if (!lossesParsed.ok) return { failure: { id, status: "failed", reason: lossesParsed.reason } };

  return {
    row: {
      id,
      content: contentParsed.value,
      tags: tagsParsed.tags,
      source,
      created_at,
      updatedAt,
      recall_count: recallCountParsed.value,
      importance_score: importanceParsed.value,
      contradiction_wins: winsParsed.value,
      contradiction_losses: lossesParsed.value,
    },
  };
}

/** Parse one edge row into an insertable record, or the failure to report. */
function parseEdgeRow(edge: ExportEdge): { edge: PendingEdge } | { failure: ImportEdgeResult } {
  if (!isImportRecordObject(edge)) {
    return { failure: { source_id: "", target_id: "", type: "", status: "failed", reason: "invalid_edge" } };
  }
  const sourceParsed = parseRequiredString(edge.source_id, "missing_endpoint", "invalid_endpoint");
  const targetParsed = parseRequiredString(edge.target_id, "missing_endpoint", "invalid_endpoint");
  const type = typeof edge.type === "string" ? edge.type.trim() || "relates_to" : "relates_to";

  if (!sourceParsed.ok || !targetParsed.ok) {
    const reason = !sourceParsed.ok ? sourceParsed.reason : !targetParsed.ok ? targetParsed.reason : "missing_endpoint";
    return {
      failure: {
        source_id: typeof edge.source_id === "string" ? edge.source_id : String(edge.source_id ?? ""),
        target_id: typeof edge.target_id === "string" ? edge.target_id : String(edge.target_id ?? ""),
        type,
        status: "failed",
        reason,
      },
    };
  }
  const source_id = sourceParsed.value;
  const target_id = targetParsed.value;

  if (!isValidEdgeType(type)) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "invalid_type" } };
  }
  // The capture path never creates these (graph/edges.ts returns null), so one in a
  // payload is hand-edited data the graph should not inherit.
  if (source_id === target_id) {
    return { failure: { source_id, target_id, type, status: "failed", reason: "self_edge" } };
  }
  const weightParsed = parseEdgeWeight(edge.weight);
  if (!weightParsed.ok) {
    return { failure: { source_id, target_id, type, status: "failed", reason: weightParsed.reason } };
  }
  const provenance =
    edge.provenance && typeof edge.provenance === "string" && isValidProvenance(edge.provenance)
      ? edge.provenance
      : "explicit";

  return {
    edge: {
      source_id,
      target_id,
      type,
      weight: weightParsed.value,
      provenance,
      created_at: typeof edge.created_at === "number" ? edge.created_at : Date.now(),
    },
  };
}
