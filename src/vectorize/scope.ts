import type { Identity } from "../lib/identity";
import { readScopeWorkspaces } from "../lib/scope";

/** Build the best-effort Vectorize workspace filter for a caller. */

export interface VectorizeWorkspaceFilter {
  // Vectorize metadata filter shape (equality on a metadata field).
  filter: { workspace_id: { $in: string[] } };
}

export function workspaceFilter(
  identity: Identity,
  only?: "personal" | "company",
  teamId?: string,
): VectorizeWorkspaceFilter | undefined {
  return { filter: { workspace_id: { $in: readScopeWorkspaces(identity, { layer: only, teamId }) } } };
}

/** Single-workspace variant for write-path checks (dedupe within the target). */
export function singleWorkspaceFilter(workspaceId: string): VectorizeWorkspaceFilter {
  return { filter: { workspace_id: { $in: [workspaceId] } } };
}

type Queryable = {
  query(...args: unknown[]): Promise<{ matches?: unknown[] }>;
};

/** Query with filtering, falling back when the index rejects the filter. */
let workspaceFiltersSupported: boolean | null = null;

// Counts unfiltered queries for the health signal.
let degradedQueryCount = 0;

// Scopes probed and found empty, by when, so repeated writes into an empty
// workspace pay for the unfiltered probe once per window rather than every time.
const probedEmptyScopes = new Map<string, number>();
const PROBED_EMPTY_TTL_MS = 5 * 60_000;

// Maintenance callers may discover degradation without having a request context
// in which to report it, so notification has its own latch.
let degradeNotified = false;

/** Current filter support state for this isolate. Read by GET /health. */
export function vectorizeFilterState(): { supported: boolean | null; degradedQueries: number } {
  return { supported: workspaceFiltersSupported, degradedQueries: degradedQueryCount };
}

/** Test-only: clears the latch and counter, mirroring resetDatabaseInit's role. */
export function resetVectorizeFilterState(): void {
  workspaceFiltersSupported = null;
  degradedQueryCount = 0;
  degradeNotified = false;
  probedEmptyScopes.clear();
}

export async function queryVectorizeScoped<M = unknown>(
  vectorize: Queryable,
  values: number[],
  opts: { topK: number; filter: VectorizeWorkspaceFilter["filter"]; onDegrade?: () => void },
): Promise<{ matches: M[]; degraded: boolean }> {
  const unfiltered = async (): Promise<{ matches: M[]; degraded: boolean }> => {
    degradedQueryCount++;
    const result = await vectorize.query(values, {
      topK: opts.topK,
      returnMetadata: "all",
      returnValues: true,
    });
    return { matches: (result?.matches ?? []) as M[], degraded: true };
  };

  // Report degradation to the first caller that can record it.
  const notifyOnce = (): void => {
    if (degradeNotified || !opts.onDegrade) return;
    degradeNotified = true;
    opts.onDegrade();
  };

  // Do not retry a known-unsupported filter.
  if (workspaceFiltersSupported === false) {
    notifyOnce();
    return unfiltered();
  }
  let filtered: unknown[];
  try {
    const result = await vectorize.query(values, {
      topK: opts.topK,
      returnMetadata: "all",
      returnValues: true,
      filter: opts.filter,
    });
    filtered = result.matches ?? [];
  } catch (e) {
    if (!/filter/i.test(String(e))) throw e;
    console.error("Vectorize rejected the workspace filter (falling back to unfiltered queries for this isolate):", e);
    workspaceFiltersSupported = false;
    // Fire the durable-marker callback only once per isolate, so a deployment
    // pays for this discovery exactly once — but on the first caller that can
    // report it rather than the first that hits it.
    notifyOnce();
    return unfiltered();
  }
  if (filtered.length > 0) {
    workspaceFiltersSupported = true;
    return { matches: filtered as M[], degraded: false };
  }
  // Zero matches is also what a filter on an unindexed workspace_id returns (#394).
  // Once this isolate has seen the filter match, an empty result is real.
  if (workspaceFiltersSupported === true) return { matches: [], degraded: false };
  const scopeKey = [...opts.filter.workspace_id.$in].sort().join("\u0000");
  const probedAt = probedEmptyScopes.get(scopeKey);
  if (probedAt !== undefined && Date.now() - probedAt < PROBED_EMPTY_TTL_MS) return { matches: [], degraded: false };
  const result = await probeEmptyFilter<M>(vectorize, values, opts, notifyOnce);
  if (result.emptyScope) {
    if (probedEmptyScopes.size >= 1000) probedEmptyScopes.clear();
    probedEmptyScopes.set(scopeKey, Date.now());
  }
  return { matches: result.matches, degraded: result.degraded };
}

/** Tells a filter that matches nothing from a scope that holds nothing. */
async function probeEmptyFilter<M>(
  vectorize: Queryable,
  values: number[],
  opts: { topK: number; filter: VectorizeWorkspaceFilter["filter"] },
  notifyOnce: () => void,
): Promise<{ matches: M[]; degraded: boolean; emptyScope: boolean }> {
  let probe: unknown[];
  try {
    probe = (await vectorize.query(values, { topK: opts.topK, returnMetadata: "all", returnValues: true }))?.matches ?? [];
  } catch (e) {
    // Not evidence either way, so the scope is not remembered as empty.
    console.error("Vectorize unfiltered probe failed (keeping the empty filtered result):", e);
    return { matches: [], degraded: false, emptyScope: false };
  }
  const readable = new Set(opts.filter.workspace_id.$in);
  const ownExists = probe.some((m) => {
    const ws = (m as { metadata?: { workspace_id?: unknown } })?.metadata?.workspace_id;
    // A vector from before workspaces carries none; it belongs to the pre-tenancy "" workspace.
    return readable.has(ws === undefined || ws === null ? "" : String(ws));
  });
  // Nothing of the caller's in the probe window: treat the scope as empty. The
  // latch stays unset and the memo expires, so it is checked again later.
  if (!ownExists) return { matches: [], degraded: false, emptyScope: true };
  console.error("Vectorize workspace filter matched none of the caller's vectors; the workspace_id metadata index is probably missing (falling back to unfiltered queries for this isolate)");
  workspaceFiltersSupported = false;
  degradedQueryCount++;
  notifyOnce();
  return { matches: probe as M[], degraded: true, emptyScope: false };
}
