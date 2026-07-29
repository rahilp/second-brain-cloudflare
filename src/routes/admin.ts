import type { Env } from "../env";
import { resolveConfig } from "../config";
import { SB_VERSION } from "../env";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql } from "../compression/eligibility";
import { json, requireAuth } from "../lib/http";
import { graceMs } from "../lib/ai";
import { classifyEntry } from "../capture/classify";
import { storeEntry } from "../capture/store";
import { deprecateEntry } from "../capture/lifecycle";
import { getStatus, withStatus } from "../memory/status";
import { withKind } from "../memory/kind";
import { checkVectorizeHealth } from "../vectorize/health";

export async function handleAdminRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const cfg = await resolveConfig(env);
  // GET /stats
  if (url.pathname === "/stats" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const graceCutoff = Date.now() - graceMs(env);
    const [summary, tagRows, candidateRows] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
         SUM(CASE WHEN vector_ids = '[]' AND created_at < ? THEN 1 ELSE 0 END) as unvectorized,
         SUM(CASE WHEN tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%' THEN 1 ELSE 0 END) as unclassified
         FROM entries`
      ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
      env.DB.prepare(`SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags) GROUP BY value ORDER BY n DESC LIMIT 5`).all(),
      env.DB.prepare(`
        SELECT value as tag, COUNT(*) as count
        FROM entries, json_each(entries.tags)
        WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
          AND value NOT LIKE 'status:%'
          AND value NOT LIKE 'kind:%'
          AND entries.tags NOT LIKE '%"rolled-up"%'
          AND entries.tags NOT LIKE '%"synthesized"%'
          AND entries.tags NOT LIKE '%"auto-pattern"%'
          AND ${compressionEligibilitySql("entries.", cfg)}
        GROUP BY value
        HAVING count > 10
        ORDER BY count DESC
        LIMIT 10
      `).bind(Date.now() - cfg.COMPRESSION_MIN_AGE_MS).all(),
    ]);

    const cutoff = Date.now() - 86400000;
    const digestCandidates: { tag: string; count: number }[] = [];
    for (const row of candidateRows.results as any[]) {
      const existing = await env.DB.prepare(
        `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? AND created_at > ? LIMIT 1`
      ).bind(`%"${row.tag}"%`, cutoff).first();
      if (!existing) digestCandidates.push({ tag: row.tag as string, count: row.count as number });
    }

    return json({
      count: (summary?.count as number) ?? 0,
      avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
      top_tags: (tagRows.results as any[]).map(r => r.value as string),
      digest_candidates: digestCandidates,
      unvectorized: (summary?.unvectorized as number) ?? 0,
      vectorize_grace_ms: graceMs(env),
      unclassified: (summary?.unclassified as number) ?? 0,
    });
  }

  // GET /health — index/runtime health, used by the dashboard banner, the
  // README verify step, and external uptime checks.
  if (url.pathname === "/health" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const vectorize = await checkVectorizeHealth(env);
    return json({ ok: vectorize.ok, version: SB_VERSION, vectorize });
  }

  // POST /patterns/resolve — confirm or dismiss an auto-derived pattern.
  // Dashboard-only, no MCP twin: pattern review is a human curation act, not an
  // agent capability. Confirm promotes the pattern into a real recallable memory;
  // dismiss deprecates it (audit row kept, vectors removed).
  if (url.pathname === "/patterns/resolve" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { id?: string; action?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const id = body.id?.trim();
    if (!id) return json({ ok: false, error: "id is required" }, 400);
    const action = body.action;
    if (action !== "confirm" && action !== "dismiss") {
      return json({ ok: false, error: `action must be "confirm" or "dismiss"` }, 400);
    }

    const row = await env.DB.prepare(`SELECT id, tags FROM entries WHERE id = ?`).bind(id).first() as Record<string, any> | null;
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    if (!tags.includes("auto-pattern")) {
      return json({ ok: false, error: "Entry is not an auto-derived pattern" }, 400);
    }

    if (action === "confirm") {
      // Losing the auto-pattern tag is what exits the recall exclusion — it's
      // enforced at D1 hydration, not vector metadata, so this tag update alone
      // makes the entry recallable. No re-embed: content is unchanged and vectors
      // already exist (the stale auto-pattern flag in vector metadata is harmless).
      const promoted = withStatus(withKind(tags.filter(t => t !== "auto-pattern"), "semantic"), "canonical");
      await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(promoted), id).run();
    } else {
      await deprecateEntry(id, env);
    }
    return json({ ok: true, id, action });
  }

  // POST /vectorize-pending
  if (url.pathname === "/vectorize-pending" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const graceCutoff = Date.now() - graceMs(env);

    const { results: toProcess } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at FROM entries
       WHERE vector_ids = '[]' AND created_at < ?
       ORDER BY created_at DESC LIMIT 25`
    ).bind(graceCutoff).all();

    let processed = 0;
    let failed = 0;

    for (const row of toProcess as Record<string, any>[]) {
      try {
        await storeEntry(
          env,
          row.id as string,
          row.content as string,
          JSON.parse(row.tags as string),
          row.source as string,
          row.created_at as number
        );
        processed++;
      } catch (e) {
        console.error("Re-embed failed for entry", row.id, e);
        failed++;
      }
    }

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ?`
    ).bind(graceCutoff).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  // POST /classify-pending
  // One-time, opt-in backfill: runs classifyEntry over entries that predate the
  // status (#119) and kind (#12) features and writes status:/kind: tags. Bounded
  // batch per call, idempotent (skips entries that already carry either tag), and
  // resumable (safe to stop/restart). No schema migration — only writes tags.
  if (url.pathname === "/classify-pending" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const UNCLASSIFIED_WHERE = `tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%'`;

    const { results: toProcess } = await env.DB.prepare(
      `SELECT id, content, tags FROM entries
       WHERE ${UNCLASSIFIED_WHERE}
       ORDER BY created_at ASC LIMIT 25`
    ).all();

    let processed = 0;
    let failed = 0;

    for (const row of toProcess as Record<string, any>[]) {
      try {
        const { canonical, kind } = await classifyEntry(row.content as string, env);
        let tags: string[] = JSON.parse(row.tags as string);
        if (kind) tags = withKind(tags, kind);
        if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
        await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), row.id).run();
        processed++;
      } catch (e) {
        console.error("Classification backfill failed for entry", row.id, e);
        failed++;
      }
    }

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE ${UNCLASSIFIED_WHERE}`
    ).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  return null;
}
