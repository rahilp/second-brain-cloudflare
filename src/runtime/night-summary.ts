import type { Env } from "../env";

/**
 * What the nightly maintenance passes did, written once per workspace per
 * night by src/index.ts's scheduled() handler and read back by GET
 * /stats/night. Never derived from D1 at read time, see the comment on that
 * route for why (edges has no index to make "since last night" cheap).
 */
export interface NightSummary {
  ranAt: number;
  linksInferred: number;
  insightsProposed: number;
  digestsWritten: number;
  claimsFlagged: number;
}

export function nightSummaryKey(workspaceId: string): string {
  return `night:${workspaceId}`;
}

/**
 * Writes the whole record in one KV put, never partially. Callers pass every
 * count they have in hand at once, there is no append/patch form, so a pass
 * that threw before this runs simply leaves last night's record in place
 * rather than corrupting it with a half-built one.
 *
 * Never throws: a failed put is logged and swallowed, matching every other
 * nightly-pass error path (src/graph/pass.ts, src/staleness/pass.ts,
 * src/compression/nightly.ts all log and continue on their own failures).
 */
export async function recordNightSummary(
  env: Env,
  workspaceId: string,
  counts: Omit<NightSummary, "ranAt">,
): Promise<void> {
  const record: NightSummary = { ranAt: Date.now(), ...counts };
  try {
    await env.OAUTH_KV.put(nightSummaryKey(workspaceId), JSON.stringify(record));
  } catch (e) {
    console.error(`Night summary write failed for workspace ${workspaceId} (non-fatal):`, e);
  }
}

/** Reads one workspace's record, or null if none was ever written (or the read failed). */
export async function readNightSummary(env: Env, workspaceId: string): Promise<NightSummary | null> {
  try {
    const raw = await env.OAUTH_KV.get(nightSummaryKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NightSummary>;
    if (typeof parsed.ranAt !== "number") return null;
    return {
      ranAt: parsed.ranAt,
      linksInferred: parsed.linksInferred ?? 0,
      insightsProposed: parsed.insightsProposed ?? 0,
      digestsWritten: parsed.digestsWritten ?? 0,
      claimsFlagged: parsed.claimsFlagged ?? 0,
    };
  } catch (e) {
    console.error(`Night summary read failed for workspace ${workspaceId} (non-fatal):`, e);
    return null;
  }
}
