import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { initializeDatabase } from "../db/init";
import { embed } from "../lib/ai";
import { inferEdgesOnWrite } from "./edges";

const GRAPH_PASS_BACKFILL_LIMIT = 25;

/**
 * The UTC weekday the dangling sweep runs on: Sunday. See the gate below for
 * why it is a weekday rather than a cron trigger of its own.
 */
const GRAPH_SWEEP_WEEKDAY_UTC = 0;
const EDGE_PRUNE_WEIGHT = 0.3;
const EDGE_PRUNE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `workspaceId` narrows the backfill candidates to one workspace's slice of the ring
 * (v3 Team Edition, see src/runtime/rotation.ts). Undefined/null — every direct and
 * manual caller — keeps the pre-v3 whole-corpus scan, whose SQL must stay byte-for-byte
 * identical. The prune DELETE below stays whole-deployment on purpose: it is a single
 * unindexed-scan statement either way and inferred-edge weights are not workspace state.
 */
export async function runGraphPass(
  env: Env,
  ctx: ExecutionContext,
  workspaceId?: string | null,
): Promise<void> {
  // One resolve for the whole pass: every embed below must use the same model
  // the capture and recall paths use.
  const cfg = await resolveConfig(env);
  await initializeDatabase(env);

  try {
    await env.DB.prepare(
      // scope-exempt: cron: prune of low-weight inferred edges, deployment-wide by design
      `DELETE FROM edges WHERE provenance = 'inferred' AND weight < ? AND updated_at < ?`
    ).bind(EDGE_PRUNE_WEIGHT, Date.now() - EDGE_PRUNE_MIN_AGE_MS).run();
  } catch (e) {
    console.error("Graph prune failed (non-fatal):", e);
  }

  // WEEKLY, not nightly. The sweep is a full scan of `edges` with two correlated
  // endpoint lookups per inferred row, and it is the one scheduled full edge
  // scan in the deployment — the cost GET /stats/graph refuses to let an
  // operator schedule.
  //
  // Expressed as a weekday gate inside the nightly pass rather than as its own
  // trigger because the free plan allows five cron schedules and all five are
  // spoken for (see wrangler.jsonc, which says so explicitly). Gating on the day
  // costs no query; a "last swept at" timestamp would spend a read every night
  // to save a scan on six of them.
  //
  // Weekly is enough because inference no longer CREATES these rows: it refuses
  // a neighbour missing from its endpoint read, so the sweep now clears
  // historical rows and the occasional failed vector cascade rather than a
  // steady stream. A missed Sunday defers idempotent cleanup by a week, which is
  // not worth a state table to prevent.
  if (new Date(Date.now()).getUTCDay() === GRAPH_SWEEP_WEEKDAY_UTC) {
    try {
      // Edges that outlived the entry they point at. Inert for reads today —
      // every walk hydrates both endpoints and drops what is missing — but not
      // permanently harmless: src/entries/import.ts accepts caller-supplied ids,
      // so a later import can create a row with that id in ANOTHER workspace and
      // turn a dead edge into a live crossing one.
      //
      // Inferred only. An explicit link pointing at a forgotten entry is
      // something a person asserted, and deleting it silently would lose it;
      // GET /stats/graph?deep=1 reports those instead.
      await env.DB.prepare(
        // scope-exempt: cron: sweep of inferred edges with a missing endpoint, deployment-wide by design
        `DELETE FROM edges
         WHERE provenance = 'inferred'
           AND (NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.source_id)
             OR NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = edges.target_id))`
      ).run();
    } catch (e) {
      // Its own sentence: this used to report a prune failure, which sends
      // anyone reading the logs to the wrong statement.
      console.error("Graph dangling sweep failed (non-fatal):", e);
    }
  }

  let unlinked: { id: string; content: string }[] = [];
  try {
    const sliceSql = workspaceId != null ? `\n         AND workspace_id = ?` : "";
    const stmt = env.DB.prepare(
      // scope-exempt: cron: nightly backfill, narrowed by the workspace slice in sliceSql
      `SELECT id, content FROM entries
       WHERE id NOT IN (SELECT source_id FROM edges) AND id NOT IN (SELECT target_id FROM edges)
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"duplicate-candidate"%'${sliceSql}
       ORDER BY created_at DESC LIMIT ${GRAPH_PASS_BACKFILL_LIMIT}`
    );
    const { results } = await (workspaceId != null ? stmt.bind(workspaceId) : stmt)
      .all() as { results: { id: string; content: string }[] };
    unlinked = results;
  } catch (e) {
    console.error("Graph backfill query failed (non-fatal):", e);
  }

  for (const entry of unlinked) {
    try {
      const values = await embed(entry.content, env, cfg);
      // DELIBERATELY UNFILTERED, and the containment is enforced instead by
      // inferEdgesOnWrite, which refuses a pair whose endpoints sit in different
      // workspaces — reading the workspaces from `entries`, the authoritative
      // source, rather than from vector metadata.
      //
      // A workspace metadata filter here would be a result-quality optimisation
      // (it keeps foreign candidates out of the five slots), never the
      // correctness mechanism. On this path it cannot even be relied on for
      // that, because the pass runs over the WHOLE corpus, including rows whose
      // vectors predate src/capture/store.ts stamping `workspace_id` at all —
      // and tenancy bootstrap backfills the entries ROWS
      // (src/lib/tenancy.ts) without ever restamping their vectors. On an
      // upgraded brain the row therefore has a real workspace and its vector has
      // none.
      //
      // Whether Vectorize's `$in` matches a vector that is MISSING the field is
      // not determinable from this repo: there is no local Vectorize to observe
      // it against, so the real answer is only available from a live deployment,
      // and the type declarations do not say either. Under
      // the unfavourable reading a filtered query returns nothing for every such
      // row, and the nightly pass silently stops inferring any edges at all on
      // exactly the brains the upgrade path produces — which is the
      // same-workspace narrowing this fix is forbidden to cause. Unfiltered is
      // correct under BOTH readings, and is no narrower than the pre-tenancy
      // behaviour; the only cost is that foreign candidates can still occupy
      // result slots, which is a ranking imperfection and not a leak.
      //
      // Reinstating the filter is a one-line change once vectors are restamped
      // on upgrade (restampVectorWorkspace in src/capture/share.ts already does
      // this for a share) — at which point it is worth it for the slots.
      const { matches } = await env.VECTORIZE.query(values, { topK: 5, returnMetadata: "all" });
      const scores = new Map<string, number>();
      for (const m of matches) {
        const pid = (m.metadata as any)?.parentId ?? m.id;
        scores.set(pid, Math.max(scores.get(pid) ?? 0, m.score));
      }
      const neighbors = [...scores.entries()].map(([id, score]) => ({ id, score }));
      await inferEdgesOnWrite(entry.id, neighbors, env);
    } catch (e) {
      console.error(`Graph backfill failed for ${entry.id} (non-fatal):`, e);
    }
  }
}
