/**
 * Cursor-based bulk import job (#217).
 *
 * Shape, one call = one page:
 *   POST /import/start   → create ledger row, return page counts + write estimate
 *   POST /import/append  → stage one page in KV (TTL 7d, no delete ops)
 *   POST /import/continue → process that page, upsert outcome in D1
 *   GET  /import/status  → sum the ledger
 *   POST /import/reset   → drop D1 rows; KV chunks expire on their own
 *
 * The client passes the page number. The server never infers position from a
 * cursor — that is what killed the livelock in the #264 attempt. Payload is
 * write-once in KV; the ledger is D1 so replay upserts keep counters exact.
 */
import type { Env } from "../env";
import {
  IMPORT_CHUNK_TTL_SECONDS,
  IMPORT_EDGE_ROW_WRITES,
  IMPORT_EDGES_PER_PAGE,
  IMPORT_ENTRIES_PER_PAGE,
  IMPORT_ENTRY_ROW_WRITES,
  IMPORT_FREE_PLAN_ROW_WRITES_PER_DAY,
  IMPORT_RESULTS_MAX,
} from "../constants";
import {
  type ExportEdge,
  type ExportEntry,
  type ImportResultItem,
  importEdgePage,
  importEntryPage,
  SubrequestBudget,
} from "./import";

export type ImportPhase = "entries" | "edges";

export interface ImportJobRow {
  id: string;
  version: number;
  entry_total: number;
  edge_total: number;
  entry_pages: number;
  edge_pages: number;
  created_at: number;
}

export interface ImportPageRow {
  job_id: string;
  phase: string;
  page: number;
  imported: number;
  skipped: number;
  failed: number;
  retriable_failed: number;
  done_at: number;
}

export type ImportJobErrorCode =
  | "invalid_body"
  | "invalid_version"
  | "invalid_phase"
  | "invalid_page"
  | "job_not_found"
  | "page_missing"
  | "page_already_processed"
  | "page_too_large";

export class ImportJobError extends Error {
  constructor(
    public readonly code: ImportJobErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ImportJobError";
  }
}

export function pageCount(total: number, perPage: number): number {
  if (total <= 0) return 0;
  return Math.ceil(total / perPage);
}

export function chunkKey(jobId: string, phase: ImportPhase, page: number): string {
  const prefix = phase === "entries" ? "e" : "g";
  return `import:${jobId}:${prefix}:${page}`;
}

export async function getJob(env: Env, jobId: string): Promise<ImportJobRow | null> {
  return await env.DB.prepare(
    `SELECT id, version, entry_total, edge_total, entry_pages, edge_pages, created_at
     FROM import_jobs WHERE id = ?`,
  ).bind(jobId).first() as ImportJobRow | null;
}

async function getPageLedger(
  env: Env,
  jobId: string,
  phase: ImportPhase,
  page: number,
): Promise<ImportPageRow | null> {
  return await env.DB.prepare(
    `SELECT job_id, phase, page, imported, skipped, failed, retriable_failed, done_at
     FROM import_job_pages WHERE job_id = ? AND phase = ? AND page = ?`,
  ).bind(jobId, phase, page).first() as ImportPageRow | null;
}

async function upsertPageLedger(
  env: Env,
  jobId: string,
  phase: ImportPhase,
  page: number,
  outcome: { imported: number; skipped: number; failed: number; retriable_failed: number },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO import_job_pages
       (job_id, phase, page, imported, skipped, failed, retriable_failed, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, phase, page) DO UPDATE SET
       imported = excluded.imported,
       skipped = excluded.skipped,
       failed = excluded.failed,
       retriable_failed = excluded.retriable_failed,
       done_at = excluded.done_at`,
  ).bind(
    jobId,
    phase,
    page,
    outcome.imported,
    outcome.skipped,
    outcome.failed,
    outcome.retriable_failed,
    now,
  ).run();
}

function parseNonNegInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ImportJobError("invalid_body", `${field} must be a non-negative integer`, 400);
  }
  return value;
}

function parsePhase(value: unknown): ImportPhase {
  if (value !== "entries" && value !== "edges") {
    throw new ImportJobError("invalid_phase", 'phase must be "entries" or "edges"', 400);
  }
  return value;
}

function parsePage(value: unknown, maxPages: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ImportJobError("invalid_page", "page must be a non-negative integer", 400);
  }
  if (maxPages === 0 || value >= maxPages) {
    throw new ImportJobError("invalid_page", `page must be in [0, ${Math.max(0, maxPages - 1)}]`, 400);
  }
  return value;
}

export interface StartJobResult {
  ok: true;
  job_id: string;
  entry_total: number;
  edge_total: number;
  entry_pages: number;
  edge_pages: number;
  estimated_row_writes: number;
  days_at_least: number;
  write_ceiling_hint: string;
}

export async function startJob(env: Env, body: unknown): Promise<StartJobResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ImportJobError("invalid_body", "body must be an object", 400);
  }
  const o = body as Record<string, unknown>;
  if (o.version !== 2) {
    throw new ImportJobError("invalid_version", "version must be 2", 400);
  }
  const entry_total = parseNonNegInt(o.entry_total, "entry_total");
  const edge_total = parseNonNegInt(o.edge_total, "edge_total");

  const entry_pages = pageCount(entry_total, IMPORT_ENTRIES_PER_PAGE);
  const edge_pages = pageCount(edge_total, IMPORT_EDGES_PER_PAGE);
  const estimated_row_writes =
    entry_total * IMPORT_ENTRY_ROW_WRITES + edge_total * IMPORT_EDGE_ROW_WRITES;
  const days_at_least = Math.max(1, Math.ceil(estimated_row_writes / IMPORT_FREE_PLAN_ROW_WRITES_PER_DAY));

  const job_id = crypto.randomUUID();
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO import_jobs
       (id, version, entry_total, edge_total, entry_pages, edge_pages, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(job_id, 2, entry_total, edge_total, entry_pages, edge_pages, created_at).run();

  return {
    ok: true,
    job_id,
    entry_total,
    edge_total,
    entry_pages,
    edge_pages,
    estimated_row_writes,
    days_at_least,
    write_ceiling_hint:
      `~${IMPORT_FREE_PLAN_ROW_WRITES_PER_DAY} D1 row writes/day on the free plan ` +
      `(~${Math.floor(IMPORT_FREE_PLAN_ROW_WRITES_PER_DAY / IMPORT_ENTRY_ROW_WRITES)} entries/day at ${IMPORT_ENTRY_ROW_WRITES} writes/entry)`,
  };
}

export interface AppendPageResult {
  ok: true;
  job_id: string;
  phase: ImportPhase;
  page: number;
  rows: number;
}

export async function appendPage(env: Env, body: unknown): Promise<AppendPageResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ImportJobError("invalid_body", "body must be an object", 400);
  }
  const o = body as Record<string, unknown>;
  if (typeof o.job_id !== "string" || !o.job_id.trim()) {
    throw new ImportJobError("invalid_body", "job_id is required", 400);
  }
  const job_id = o.job_id.trim();
  const job = await getJob(env, job_id);
  if (!job) throw new ImportJobError("job_not_found", `No import job: ${job_id}`, 404);

  const phase = parsePhase(o.phase);
  const maxPages = phase === "entries" ? job.entry_pages : job.edge_pages;
  const page = parsePage(o.page, maxPages);

  if (!Array.isArray(o.rows)) {
    throw new ImportJobError("invalid_body", "rows must be an array", 400);
  }
  const maxRows = phase === "entries" ? IMPORT_ENTRIES_PER_PAGE : IMPORT_EDGES_PER_PAGE;
  if (o.rows.length > maxRows) {
    throw new ImportJobError(
      "page_too_large",
      `rows.length ${o.rows.length} exceeds ${phase} page size ${maxRows}`,
      413,
    );
  }

  const existing = await getPageLedger(env, job_id, phase, page);
  if (existing) {
    throw new ImportJobError(
      "page_already_processed",
      `page ${page} of ${phase} was already processed; reset the job to restage`,
      409,
    );
  }

  await env.OAUTH_KV.put(
    chunkKey(job_id, phase, page),
    JSON.stringify(o.rows),
    { expirationTtl: IMPORT_CHUNK_TTL_SECONDS },
  );

  return { ok: true, job_id, phase, page, rows: o.rows.length };
}

export interface ContinuePageResult {
  ok: true;
  job_id: string;
  phase: ImportPhase;
  page: number;
  imported: number;
  skipped: number;
  failed: number;
  retriable_failed: number;
  results: ImportResultItem[];
  results_truncated: boolean;
  next_page: number | null;
  done: boolean;
  clean: boolean;
  vectorize_hint: string;
}

function truncateResults(results: ImportResultItem[]): {
  results: ImportResultItem[];
  results_truncated: boolean;
} {
  const failedOnly = results.filter(r => r.status === "failed");
  if (failedOnly.length <= IMPORT_RESULTS_MAX) {
    return { results: failedOnly, results_truncated: false };
  }
  return {
    results: failedOnly.slice(0, IMPORT_RESULTS_MAX),
    results_truncated: true,
  };
}

export async function runPage(env: Env, body: unknown): Promise<ContinuePageResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ImportJobError("invalid_body", "body must be an object", 400);
  }
  const o = body as Record<string, unknown>;
  if (typeof o.job_id !== "string" || !o.job_id.trim()) {
    throw new ImportJobError("invalid_body", "job_id is required", 400);
  }
  const job_id = o.job_id.trim();
  const job = await getJob(env, job_id);
  if (!job) throw new ImportJobError("job_not_found", `No import job: ${job_id}`, 404);

  const phase = parsePhase(o.phase);
  const maxPages = phase === "entries" ? job.entry_pages : job.edge_pages;
  const page = parsePage(o.page, maxPages);

  const raw = await env.OAUTH_KV.get(chunkKey(job_id, phase, page));
  if (raw == null) {
    throw new ImportJobError(
      "page_missing",
      `page ${page} of ${phase} is not staged; append it first (KV miss may need a short retry)`,
      409,
    );
  }

  let rows: unknown[];
  try {
    rows = JSON.parse(raw) as unknown[];
    if (!Array.isArray(rows)) throw new Error("not an array");
  } catch {
    throw new ImportJobError("invalid_body", "staged page is corrupt; re-append it", 400);
  }

  const budget = new SubrequestBudget();
  // getJob already spent one SELECT; count it so the soft cap matches reality.
  budget.charge();

  const outcome = phase === "entries"
    ? await importEntryPage(env, rows as ExportEntry[], budget)
    : await importEdgePage(env, rows as ExportEdge[], budget);

  budget.charge();
  await upsertPageLedger(env, job_id, phase, page, outcome);

  const status = await readStatus(env, job_id);
  const next_page = phase === "entries" ? status.next_entry_page : status.next_edge_page;
  const truncated = truncateResults(outcome.results);

  return {
    ok: true,
    job_id,
    phase,
    page,
    imported: outcome.imported,
    skipped: outcome.skipped,
    failed: outcome.failed,
    retriable_failed: outcome.retriable_failed,
    results: truncated.results,
    results_truncated: truncated.results_truncated,
    next_page,
    done: status.done,
    clean: status.clean,
    vectorize_hint: status.done
      ? "POST /vectorize-pending until remaining is 0 (entries already have vector_ids=[])"
      : "finish remaining pages, then POST /vectorize-pending until remaining is 0",
  };
}

export interface FailedPageRef {
  phase: ImportPhase;
  page: number;
  retriable_failed: number;
}

export interface ImportStatusResult {
  ok: true;
  job_id: string;
  entry_total: number;
  edge_total: number;
  entry_pages: number;
  edge_pages: number;
  pages_done_entries: number;
  pages_done_edges: number;
  imported: number;
  skipped: number;
  failed: number;
  retriable_failed: number;
  next_entry_page: number | null;
  next_edge_page: number | null;
  failed_pages: FailedPageRef[];
  done: boolean;
  clean: boolean;
}

function nextMissingPage(donePages: Set<number>, totalPages: number): number | null {
  for (let i = 0; i < totalPages; i++) {
    if (!donePages.has(i)) return i;
  }
  return null;
}

export async function readStatus(env: Env, jobId: string): Promise<ImportStatusResult> {
  const job = await getJob(env, jobId);
  if (!job) throw new ImportJobError("job_not_found", `No import job: ${jobId}`, 404);

  const { results: pages } = await env.DB.prepare(
    `SELECT job_id, phase, page, imported, skipped, failed, retriable_failed, done_at
     FROM import_job_pages WHERE job_id = ?`,
  ).bind(jobId).all() as { results: ImportPageRow[] };

  const entryDone = new Set<number>();
  const edgeDone = new Set<number>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let retriable_failed = 0;
  const failed_pages: FailedPageRef[] = [];

  for (const p of pages) {
    imported += p.imported;
    skipped += p.skipped;
    failed += p.failed;
    retriable_failed += p.retriable_failed;
    if (p.phase === "entries") entryDone.add(p.page);
    else if (p.phase === "edges") edgeDone.add(p.page);
    if (p.retriable_failed > 0 && (p.phase === "entries" || p.phase === "edges")) {
      failed_pages.push({
        phase: p.phase,
        page: p.page,
        retriable_failed: p.retriable_failed,
      });
    }
  }

  failed_pages.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase === "entries" ? -1 : 1;
    return a.page - b.page;
  });

  const next_entry_page = nextMissingPage(entryDone, job.entry_pages);
  const next_edge_page = nextMissingPage(edgeDone, job.edge_pages);
  const done = next_entry_page === null && next_edge_page === null;
  const clean = done && failed_pages.length === 0;

  return {
    ok: true,
    job_id: jobId,
    entry_total: job.entry_total,
    edge_total: job.edge_total,
    entry_pages: job.entry_pages,
    edge_pages: job.edge_pages,
    pages_done_entries: entryDone.size,
    pages_done_edges: edgeDone.size,
    imported,
    skipped,
    failed,
    retriable_failed,
    next_entry_page,
    next_edge_page,
    failed_pages,
    done,
    clean,
  };
}

export async function resetJob(env: Env, body: unknown): Promise<{ ok: true; job_id: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ImportJobError("invalid_body", "body must be an object", 400);
  }
  const o = body as Record<string, unknown>;
  if (typeof o.job_id !== "string" || !o.job_id.trim()) {
    throw new ImportJobError("invalid_body", "job_id is required", 400);
  }
  const job_id = o.job_id.trim();
  const job = await getJob(env, job_id);
  if (!job) throw new ImportJobError("job_not_found", `No import job: ${job_id}`, 404);

  await env.DB.prepare(`DELETE FROM import_job_pages WHERE job_id = ?`).bind(job_id).run();
  await env.DB.prepare(`DELETE FROM import_jobs WHERE id = ?`).bind(job_id).run();
  // KV chunks expire via TTL — deleting them would burn the free-plan delete quota.
  return { ok: true, job_id };
}
