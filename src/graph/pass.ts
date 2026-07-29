import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { initializeDatabase } from "../db/init";
import { embed } from "../lib/ai";
import { inferEdgesOnWrite } from "./edges";

const GRAPH_PASS_BACKFILL_LIMIT = 25;
const EDGE_PRUNE_WEIGHT = 0.3;
const EDGE_PRUNE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function runGraphPass(env: Env, ctx: ExecutionContext): Promise<void> {
  // One resolve for the whole pass: every embed below must use the same model
  // the capture and recall paths use.
  const cfg = await resolveConfig(env);
  await initializeDatabase(env);

  try {
    await env.DB.prepare(
      `DELETE FROM edges WHERE provenance = 'inferred' AND weight < ? AND updated_at < ?`
    ).bind(EDGE_PRUNE_WEIGHT, Date.now() - EDGE_PRUNE_MIN_AGE_MS).run();
  } catch (e) {
    console.error("Graph prune failed (non-fatal):", e);
  }

  let unlinked: { id: string; content: string }[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, content FROM entries
       WHERE id NOT IN (SELECT source_id FROM edges) AND id NOT IN (SELECT target_id FROM edges)
         AND tags NOT LIKE '%"status:deprecated"%'
       ORDER BY created_at DESC LIMIT ${GRAPH_PASS_BACKFILL_LIMIT}`
    ).all() as { results: { id: string; content: string }[] };
    unlinked = results;
  } catch (e) {
    console.error("Graph backfill query failed (non-fatal):", e);
  }

  for (const entry of unlinked) {
    try {
      const values = await embed(entry.content, env, cfg);
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
