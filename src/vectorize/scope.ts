import type { Identity } from "../lib/identity";
import { readScopeWorkspaces } from "../lib/scope";

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

// Counts every unfiltered query this isolate has served — not just the one
// that discovered the rejection — so the health signal reflects ongoing
// result-quality exposure, not a one-time event.
let degradedQueryCount = 0;

// Separate from workspaceFiltersSupported so the "fire onDegrade once" check
// is a plain boolean read-then-set with no re-derivation from the latch — two
// concurrent in-flight queries can both reach the catch block before either
// has written the latch (no `await` sits between reading and setting this
// flag, so the check-and-set itself cannot interleave).
//
// It means "the degradation has been REPORTED", not "the degradation has been
// discovered" — the latch above is what records discovery. The two are not the
// same event: not every caller can report. A system pass has no request to hang
// a waitUntil off and so supplies no handler, and if its discovery set this flag
// it would write no marker AND silence every later recall and capture that could
// have written one. So this is set only by a caller that actually had somewhere
// to report to.
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

  // Reports the degradation to the first caller that can actually record it,
  // whenever that caller arrives — which is not necessarily the one that
  // discovered it. Sync read-then-set, so the interleaving argument above still
  // holds.
  const notifyOnce = (): void => {
    if (degradeNotified || !opts.onDegrade) return;
    degradeNotified = true;
    opts.onDegrade();
  };

  // Already known to be unsupported. The filtered query is not re-attempted, so
  // this is the only place a later handler-bearing caller can be asked to record
  // what an earlier handler-less one found.
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
