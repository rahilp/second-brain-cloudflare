import type { Env } from "../env";
import { initializeDatabase } from "../db/init";

/**
 * Workspace rotation for the nightly maintenance passes (v3 Team Edition).
 *
 * Free-plan Workers allow ~50 D1 queries per invocation and the nightly passes already
 * spend ~30 of them on a single-user brain. Scanning the whole corpus per night grows
 * linearly with workspaces, so instead each invocation processes ONE workspace's slice
 * behind this round-robin cursor, keeping per-invocation cost roughly flat as teams grow.
 * The trade-off is coverage latency: the whole deployment cycles every K nights, where
 * K is the number of workspaces. Paid plans fit every workspace in one run anyway; the
 * cursor advancing each night costs them nothing but three cheap queries.
 *
 * LEGACY RULE: '' — the pre-team space every v2 brain lived in — participates in the
 * ring like any other value (it sorts first), so upgraded brains keep being processed
 * every cycle rather than falling out of maintenance at the migration boundary.
 *
 * Ring semantics: lexicographically ascending over the DISTINCT workspace_ids present
 * in `entries`, starting strictly AFTER the stored cursor value and wrapping to the
 * smallest when the cursor is at or past the maximum. The seeded cursor value is '',
 * so on a fresh ring the first nights process the named workspaces and '' gets its
 * turn at the wrap-around — one turn per cycle, same as everyone else.
 *
 * Race tolerance: two isolates firing together can both read the same cursor and both
 * advance it; the worst case is both processing the same slice, which is harmless
 * because these passes are idempotent. No CAS is worth adding for that.
 *
 * Returns NULL when the corpus has no workspaces at all (nothing to process), and also
 * on any read failure — callers then behave as they did pre-v3 and scan the whole
 * corpus, which degrades to the old cost rather than skipping maintenance entirely.
 */
export async function nextWorkspace(env: Env): Promise<string | null> {
  try {
    await initializeDatabase(env);

    const cursor = await env.DB.prepare(
      `SELECT workspace_id FROM maintenance_cursor WHERE id = ?`,
    ).bind(1).first<{ workspace_id: string }>();
    const current = cursor?.workspace_id ?? "";

    const { results } = await env.DB.prepare(
      `SELECT DISTINCT workspace_id FROM entries WHERE workspace_id > ? ORDER BY workspace_id LIMIT 1`,
    ).bind(current).all();
    let next = results[0]?.workspace_id as string | undefined;

    if (next === undefined) {
      // Past the end of the ring (or an empty corpus): wrap to the first workspace.
      const wrap = await env.DB.prepare(
        // scope-exempt: cron: ring wrap-around; returns one workspace id, never a row
        `SELECT DISTINCT workspace_id FROM entries ORDER BY workspace_id LIMIT 1`,
      ).all();
      next = wrap.results[0]?.workspace_id as string | undefined;
      if (next === undefined) return null;
    }

    const updated = await env.DB.prepare(
      `UPDATE maintenance_cursor SET workspace_id = ?, advanced_at = ? WHERE id = ?`,
    ).bind(next, Date.now(), 1).run();
    if (((updated.meta as Record<string, unknown> | undefined)?.changes ??
        (updated.meta as Record<string, unknown> | undefined)?.rows_written ?? 0) === 0) {
      // The row was never seeded — a deployment whose cron fired before its first
      // request, so tenancy bootstrap has not run yet. Seed it rather than silently
      // re-processing the same slice every night forever.
      await env.DB.prepare(
        `INSERT INTO maintenance_cursor (id, workspace_id, advanced_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(1, next, Date.now()).run();
    }
    return next;
  } catch (e) {
    console.error("Maintenance rotation read failed; processing the whole corpus (non-fatal):", e);
    return null;
  }
}
