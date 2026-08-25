import type { Identity } from "../lib/identity";
import { readableWorkspaces } from "../lib/scope";

/**
 * Workspace scoping for Vectorize queries. Vectors carry workspace_id in their
 * metadata (stamped at upsert, src/capture/store.ts), and user-facing queries
 * pass a metadata filter so foreign candidates never consume result slots.
 *
 * The filter is best-effort by design: Vectorize metadata-filter syntax has
 * moved more than once, and a rejected filter must degrade to an unfiltered
 * query rather than fail recall. Correctness does not depend on it — every
 * downstream hydration is already scoped at the SQL layer — the filter only
 * stops foreign candidates from crowding out the caller's own.
 */

export interface VectorizeWorkspaceFilter {
  // Vectorize metadata filter shape (equality on a metadata field).
  filter: { workspace_id: { $in: string[] } };
}

export function workspaceFilter(identity: Identity): VectorizeWorkspaceFilter | undefined {
  return { filter: { workspace_id: { $in: readableWorkspaces(identity) } } };
}

/** Single-workspace variant for write-path checks (dedupe within the target). */
export function singleWorkspaceFilter(workspaceId: string): VectorizeWorkspaceFilter {
  return { filter: { workspace_id: { $in: [workspaceId] } } };
}

type Queryable = {
  query(...args: unknown[]): Promise<{ matches?: unknown[] }>;
};

/**
 * Query with the workspace filter applied. A filter-shaped rejection (unknown
 * syntax, unsupported field — Vectorize's filter surface has moved before)
 * degrades to one unfiltered retry and latches per isolate, so a deployment
 * whose index cannot filter pays for that discovery exactly once. Any other
 * error propagates: callers already have their own degradation paths (keyword-
 * only recall, narrow results, skip duplicate checks), and silently widening a
 * failed query would mask real outages.
 */
let workspaceFiltersSupported: boolean | null = null;

export async function queryVectorizeScoped<M = unknown>(
  vectorize: Queryable,
  values: number[],
  opts: { topK: number; filter: VectorizeWorkspaceFilter["filter"] },
): Promise<{ matches: M[]; degraded: boolean }> {
  const unfiltered = async (): Promise<{ matches: M[]; degraded: boolean }> => {
    const result = await vectorize.query(values, {
      topK: opts.topK,
      returnMetadata: "all",
      returnValues: true,
    });
    return { matches: (result?.matches ?? []) as M[], degraded: true };
  };

  if (workspaceFiltersSupported === false) return unfiltered();
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
    return unfiltered();
  }
}
