/**
 * Per-page import helpers for the cursor-based bulk import (#217).
 *
 * Existence probes are page-scoped: one batched IN lookup for the whole page,
 * never per-row. The old ensureIdResolved path flushed after every unresolved
 * id and burned the free-plan 50-subrequest budget inside a few dozen rows.
 *
 * When DB.batch() fails, row-by-row retry proceeds only while the caller's
 * SubrequestBudget is under IMPORT_SUBREQUEST_SOFT_CAP; the rest of the page
 * becomes deferred_retry so the client can re-run the same page.
 */
import type { Env } from "../env";
import {
  D1_MAX_BOUND_PARAMS,
  IMPORT_D1_BATCH_SIZE,
  IMPORT_SUBREQUEST_SOFT_CAP,
} from "../constants";
import { isSymmetric, isValidEdgeType } from "../graph/edges";
import type { EdgeProvenance } from "../graph/types";
import { PROVENANCE_VALUES } from "../graph/types";

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

export interface PageImportOutcome {
  imported: number;
  skipped: number;
  failed: number;
  retriable_failed: number;
  results: ImportResultItem[];
}

/**
 * Counts D1 executions (prepare().run/first/all and batch) so continue can
 * stop retrying before the free-plan 50-subrequest ceiling.
 */
export class SubrequestBudget {
  spent = 0;
  constructor(public readonly softCap = IMPORT_SUBREQUEST_SOFT_CAP) {}
  charge(n = 1): void { this.spent += n; }
  get remaining(): number { return this.softCap - this.spent; }
  get canRetryRow(): boolean { return this.spent < this.softCap; }
}

const RETRIABLE_REASONS = new Set([
  "missing_endpoint",
  "deferred_retry",
  "insert_error",
  "create_failed",
]);

/** Shared by import-job status and tests — terminal vs retriable must not diverge. */
export function isRetriableReason(reason: string | undefined): boolean {
  if (!reason) return false;
  if (RETRIABLE_REASONS.has(reason)) return true;
  // Any other I/O-shaped reason (not invalid_*/missing_* validation) is retriable.
  if (reason.startsWith("invalid_") || reason.startsWith("missing_")) return false;
  return true;
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

export async function loadExistingIds(env: Env, ids: string[], budget?: SubrequestBudget): Promise<Set<string>> {
  const found = new Set<string>();
  if (!ids.length) return found;
  for (let i = 0; i < ids.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = ids.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    budget?.charge();
    const { results } = await env.DB.prepare(
      `SELECT id FROM entries WHERE id IN (${placeholders})`,
    ).bind(...batch).all() as { results: { id: string }[] };
    for (const row of results) found.add(row.id);
  }
  return found;
}

export async function loadExistingEdgeKeys(
  env: Env,
  endpoints: string[],
  budget?: SubrequestBudget,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!endpoints.length) return keys;
  for (let i = 0; i < endpoints.length; i += EDGE_ENDPOINT_QUERY_BATCH) {
    const batch = endpoints.slice(i, i + EDGE_ENDPOINT_QUERY_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    budget?.charge();
    const { results } = await env.DB.prepare(
      `SELECT source_id, target_id, type FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    ).bind(...batch, ...batch).all() as {
      results: { source_id: string; target_id: string; type: string }[];
    };
    for (const row of results) keys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
  }
  return keys;
}

export function collectPayloadEntryIds(entries: ExportEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (!isImportRecordObject(entry)) continue;
    const parsed = parseRequiredString(entry.id, "missing", "invalid");
    if (parsed.ok) ids.push(parsed.value);
  }
  return ids;
}

export function collectEdgeEndpoints(edges: ExportEdge[]): string[] {
  const endpoints = new Set<string>();
  for (const edge of edges) {
    if (!isImportRecordObject(edge)) continue;
    const sourceParsed = parseRequiredString(edge.source_id, "missing", "invalid");
    const targetParsed = parseRequiredString(edge.target_id, "missing", "invalid");
    if (sourceParsed.ok) endpoints.add(sourceParsed.value);
    if (targetParsed.ok) endpoints.add(targetParsed.value);
  }
  return [...endpoints];
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
    row.created_at,
    "[]",
    row.recall_count,
    row.importance_score,
    row.contradiction_wins,
    row.contradiction_losses,
  );
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

function countRetriable(results: ImportResultItem[]): number {
  let n = 0;
  for (const r of results) {
    if (r.status === "failed" && isRetriableReason(r.reason)) n++;
  }
  return n;
}

async function flushInsertBatch(
  env: Env,
  batch: PendingInsert[],
  existingIds: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
  budget: SubrequestBudget,
): Promise<PendingInsert[]> {
  if (!batch.length) return [];

  const stmts = batch.map(row => bindInsert(env, row));
  budget.charge();
  try {
    await env.DB.batch(stmts);
    for (const row of batch) {
      existingIds.add(row.id);
      counters.imported++;
    }
    return [];
  } catch {
    const deferred: PendingInsert[] = [];
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      if (!budget.canRetryRow) {
        deferred.push(...batch.slice(i));
        break;
      }
      budget.charge();
      try {
        await bindInsert(env, row).run();
        existingIds.add(row.id);
        counters.imported++;
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
    return deferred;
  }
}

async function flushEdgeBatch(
  env: Env,
  batch: PendingEdge[],
  existingEdgeKeys: Set<string>,
  results: ImportResultItem[],
  counters: { imported: number; failed: number },
  budget: SubrequestBudget,
): Promise<PendingEdge[]> {
  if (!batch.length) return [];

  const stmts = batch.map(row => bindEdgeInsert(env, row));
  budget.charge();
  try {
    await env.DB.batch(stmts);
    for (const row of batch) {
      existingEdgeKeys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
      counters.imported++;
    }
    return [];
  } catch {
    const deferred: PendingEdge[] = [];
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      if (!budget.canRetryRow) {
        deferred.push(...batch.slice(i));
        break;
      }
      budget.charge();
      try {
        await bindEdgeInsert(env, row).run();
        existingEdgeKeys.add(normalizedEdgeKey(row.source_id, row.target_id, row.type));
        counters.imported++;
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
    return deferred;
  }
}

function parseEntryRow(
  entry: unknown,
): { ok: true; row: PendingInsert } | { ok: false; result: ImportEntryResult } {
  if (!isImportRecordObject(entry)) {
    return { ok: false, result: { id: "", status: "failed", reason: "invalid_entry" } };
  }

  const idParsed = parseRequiredString(entry.id, "missing_id", "invalid_id");
  if (!idParsed.ok) {
    return {
      ok: false,
      result: {
        id: typeof entry.id === "string" ? entry.id : String(entry.id ?? ""),
        status: "failed",
        reason: idParsed.reason,
      },
    };
  }
  const id = idParsed.value;

  const contentParsed = parseRequiredString(entry.content, "missing_content", "invalid_content");
  if (!contentParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: contentParsed.reason } };
  }

  const tagsParsed = parseTags(entry.tags);
  if (!tagsParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: tagsParsed.reason } };
  }

  let source = "import";
  if (entry.source !== undefined && entry.source !== null) {
    if (typeof entry.source !== "string") {
      return { ok: false, result: { id, status: "failed", reason: "invalid_source" } };
    }
    source = entry.source.trim() || "import";
  }

  const createdAtParsed = parseCreatedAt(entry.created_at);
  if (!createdAtParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: createdAtParsed.reason } };
  }

  const recallCountParsed = parseOptionalNumber(entry.recall_count, "invalid_recall_count");
  if (!recallCountParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: recallCountParsed.reason } };
  }
  const importanceParsed = parseOptionalNumber(entry.importance_score, "invalid_importance_score");
  if (!importanceParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: importanceParsed.reason } };
  }
  const winsParsed = parseOptionalNumber(entry.contradiction_wins, "invalid_contradiction_wins");
  if (!winsParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: winsParsed.reason } };
  }
  const lossesParsed = parseOptionalNumber(entry.contradiction_losses, "invalid_contradiction_losses");
  if (!lossesParsed.ok) {
    return { ok: false, result: { id, status: "failed", reason: lossesParsed.reason } };
  }

  return {
    ok: true,
    row: {
      id,
      content: contentParsed.value,
      tags: tagsParsed.tags,
      source,
      created_at: createdAtParsed.value,
      recall_count: recallCountParsed.value,
      importance_score: importanceParsed.value,
      contradiction_wins: winsParsed.value,
      contradiction_losses: lossesParsed.value,
    },
  };
}

/** Import one page of entries. Existence is probed once for the whole page. */
export async function importEntryPage(
  env: Env,
  entries: ExportEntry[],
  budget = new SubrequestBudget(),
): Promise<PageImportOutcome> {
  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  const pageIds = collectPayloadEntryIds(entries);
  const existingIds = await loadExistingIds(env, pageIds, budget);

  const pendingBatch: PendingInsert[] = [];
  const batchCounters = { imported: 0, failed: 0 };
  let deferRest = false;

  const deferRow = (row: PendingInsert) => {
    failed++;
    results.push({ id: row.id, status: "failed", reason: "deferred_retry" });
  };

  for (const entry of entries) {
    if (deferRest) {
      const parsed = parseEntryRow(entry);
      if (parsed.ok && !existingIds.has(parsed.row.id)) deferRow(parsed.row);
      else if (!parsed.ok) {
        failed++;
        results.push(parsed.result);
      } else {
        skipped++;
      }
      continue;
    }

    const parsed = parseEntryRow(entry);
    if (!parsed.ok) {
      failed++;
      results.push(parsed.result);
      continue;
    }

    if (existingIds.has(parsed.row.id)) {
      skipped++;
      continue;
    }

    pendingBatch.push(parsed.row);
    if (pendingBatch.length >= IMPORT_D1_BATCH_SIZE) {
      const deferred = await flushInsertBatch(
        env, pendingBatch.splice(0), existingIds, results, batchCounters, budget,
      );
      imported += batchCounters.imported;
      failed += batchCounters.failed;
      batchCounters.imported = 0;
      batchCounters.failed = 0;
      if (deferred.length) {
        for (const row of deferred) deferRow(row);
        deferRest = true;
      }
    }
  }

  if (!deferRest && pendingBatch.length) {
    const deferred = await flushInsertBatch(
      env, pendingBatch.splice(0), existingIds, results, batchCounters, budget,
    );
    imported += batchCounters.imported;
    failed += batchCounters.failed;
    for (const row of deferred) deferRow(row);
  } else if (deferRest && pendingBatch.length) {
    for (const row of pendingBatch.splice(0)) deferRow(row);
  }

  return {
    imported,
    skipped,
    failed,
    retriable_failed: countRetriable(results),
    results,
  };
}

/** Import one page of edges. Endpoints and edge keys are probed once for the page. */
export async function importEdgePage(
  env: Env,
  edges: ExportEdge[],
  budget = new SubrequestBudget(),
): Promise<PageImportOutcome> {
  const results: ImportResultItem[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  const endpoints = collectEdgeEndpoints(edges);
  const existingIds = await loadExistingIds(env, endpoints, budget);
  const existingEdgeKeys = await loadExistingEdgeKeys(env, endpoints, budget);

  const pendingEdgeBatch: PendingEdge[] = [];
  const edgeBatchCounters = { imported: 0, failed: 0 };
  let deferRest = false;

  const deferEdge = (edge: PendingEdge) => {
    failed++;
    results.push({
      source_id: edge.source_id,
      target_id: edge.target_id,
      type: edge.type,
      status: "failed",
      reason: "deferred_retry",
    });
  };

  for (const edge of edges) {
    if (!isImportRecordObject(edge)) {
      failed++;
      results.push({
        source_id: "",
        target_id: "",
        type: "",
        status: "failed",
        reason: "invalid_edge",
      });
      continue;
    }

    const sourceParsed = parseRequiredString(edge.source_id, "missing_endpoint", "invalid_endpoint");
    const targetParsed = parseRequiredString(edge.target_id, "missing_endpoint", "invalid_endpoint");
    const type = typeof edge.type === "string" ? edge.type.trim() || "relates_to" : "relates_to";

    if (!sourceParsed.ok || !targetParsed.ok) {
      failed++;
      let reason = "missing_endpoint";
      if (!sourceParsed.ok) reason = sourceParsed.reason;
      else if (!targetParsed.ok) reason = targetParsed.reason;
      results.push({
        source_id: typeof edge.source_id === "string" ? edge.source_id : String(edge.source_id ?? ""),
        target_id: typeof edge.target_id === "string" ? edge.target_id : String(edge.target_id ?? ""),
        type,
        status: "failed",
        reason,
      });
      continue;
    }

    const source_id = sourceParsed.value;
    const target_id = targetParsed.value;

    if (!isValidEdgeType(type)) {
      failed++;
      results.push({ source_id, target_id, type, status: "failed", reason: "invalid_type" });
      continue;
    }

    if (deferRest) {
      if (!existingIds.has(source_id) || !existingIds.has(target_id)) {
        failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: "missing_endpoint" });
        continue;
      }
      const edgeKey = normalizedEdgeKey(source_id, target_id, type);
      if (existingEdgeKeys.has(edgeKey)) {
        skipped++;
        continue;
      }
      const weightParsed = parseEdgeWeight(edge.weight);
      if (!weightParsed.ok) {
        failed++;
        results.push({ source_id, target_id, type, status: "failed", reason: weightParsed.reason });
        continue;
      }
      deferEdge({
        source_id,
        target_id,
        type,
        weight: weightParsed.value,
        provenance: "explicit",
        created_at: typeof edge.created_at === "number" ? edge.created_at : Date.now(),
      });
      continue;
    }

    if (!existingIds.has(source_id) || !existingIds.has(target_id)) {
      failed++;
      results.push({ source_id, target_id, type, status: "failed", reason: "missing_endpoint" });
      continue;
    }

    const edgeKey = normalizedEdgeKey(source_id, target_id, type);
    if (existingEdgeKeys.has(edgeKey)) {
      skipped++;
      continue;
    }

    const weightParsed = parseEdgeWeight(edge.weight);
    if (!weightParsed.ok) {
      failed++;
      results.push({ source_id, target_id, type, status: "failed", reason: weightParsed.reason });
      continue;
    }

    const provenance = edge.provenance && typeof edge.provenance === "string" && isValidProvenance(edge.provenance)
      ? edge.provenance
      : "explicit";

    pendingEdgeBatch.push({
      source_id,
      target_id,
      type,
      weight: weightParsed.value,
      provenance,
      created_at: typeof edge.created_at === "number" ? edge.created_at : Date.now(),
    });

    if (pendingEdgeBatch.length >= IMPORT_D1_BATCH_SIZE) {
      const deferred = await flushEdgeBatch(
        env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters, budget,
      );
      imported += edgeBatchCounters.imported;
      failed += edgeBatchCounters.failed;
      edgeBatchCounters.imported = 0;
      edgeBatchCounters.failed = 0;
      if (deferred.length) {
        for (const row of deferred) deferEdge(row);
        deferRest = true;
      }
    }
  }

  if (!deferRest && pendingEdgeBatch.length) {
    const deferred = await flushEdgeBatch(
      env, pendingEdgeBatch.splice(0), existingEdgeKeys, results, edgeBatchCounters, budget,
    );
    imported += edgeBatchCounters.imported;
    failed += edgeBatchCounters.failed;
    for (const row of deferred) deferEdge(row);
  } else if (deferRest && pendingEdgeBatch.length) {
    for (const row of pendingEdgeBatch.splice(0)) deferEdge(row);
  }

  return {
    imported,
    skipped,
    failed,
    retriable_failed: countRetriable(results),
    results,
  };
}
