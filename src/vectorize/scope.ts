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
  try {
    const result = await vectorize.query(values, {
      topK: opts.topK,
      returnMetadata: "all",
      returnValues: true,
      filter: opts.filter,
    });
    workspaceFiltersSupported = true;
    return { matches: (result.matches ?? []) as M[], degraded: false };
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
}
