import type { Env } from "../env";
import { resolveConfig } from "../config";
import { SB_VERSION } from "../env";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql, isTopicTagSql } from "../compression/eligibility";
import { intParam, json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { graceMs } from "../lib/ai";
import { classifyEntry } from "../capture/classify";
import { storeEntry } from "../capture/store";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { STALE_REVIEW_SQL } from "../memory/stale";
import { getStatus, withStatus } from "../memory/status";
import { withKind } from "../memory/kind";
import { checkVectorizeHealth } from "../vectorize/health";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { reasonOverPair, restatesRecent } from "../insight/reason";
import { MAX_INSIGHTS_PER_RUN, RECENT_INSIGHT_WINDOW, rawInsightText } from "../insight/weekly";
import { runInsightAccrual, isEligiblePair, parseTags } from "../insight/candidates";
import { createMember, listMembers, removeMember, rotateMemberToken, setMemberDefaultShare, setMemberProfile, setMemberSuspended, TeamAdminError } from "../lib/team-admin";

/**
 * Ids accepted by one bulk resolve. D1 allows 100 bound parameters per
 * statement and the id list is the whole of the SELECT's binding, so this is
 * the hard limit rather than a policy. The client pages against it.
 */
const MAX_PATTERN_BULK = 100;

/**
 * The admin surface's twin of requireIdentity: everything here is deployment-wide
 * (cross-workspace stats, bulk backfills, insight review), so a signed-in member
 * gets 403 rather than the data. The spec carves these queries out of the
 * scope-helper rule exactly because this gate is what stands in front of them.
 */
async function requireAdmin(request: Request, env: Env): Promise<Identity | Response> {
  const auth = await requireIdentity(request, env);
  if (auth instanceof Response) return auth;
  if (auth.role !== "admin") return json({ ok: false, error: "Forbidden" }, 403);
  return auth;
}

export async function handleAdminRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const cfg = await resolveConfig(env);
  // ── Team administration (v3). All routes behind requireAdmin. ──────────
  if (url.pathname === "/team/members" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, members: await listMembers(env), you: auth.userId });
  }

  if (url.pathname === "/team/members" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { name?: string; email?: string; role?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") {
      return json({ ok: false, error: 'role must be "admin" or "member"' }, 400);
    }
    try {
      const { member, token } = await createMember(env, {
        name: body.name,
        email: body.email,
        role: body.role as "admin" | "member" | undefined,
      });
      // The token is returned exactly once — only its hash is stored.
      return json({ ok: true, member, token }, 201);
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/team/members/token" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const token = await rotateMemberToken(env, body.id.trim());
      return json({ ok: true, id: body.id.trim(), token });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/team/members/suspend" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; suspended?: boolean };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      await setMemberSuspended(env, auth.userId, body.id.trim(), body.suspended !== false);
      return json({ ok: true, id: body.id.trim(), suspended: body.suspended !== false });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/members/default-share — per-member capture-visibility override.
  // "inherit" clears it; the org-level default lives in config
  // (TEAM_DEFAULT_WORKSPACE) and is what "inherit" falls back to.
  if (url.pathname === "/team/members/default-share" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; default?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.default !== "personal" && body.default !== "company" && body.default !== "inherit") {
      return json({ ok: false, error: 'default must be "personal", "company", or "inherit"' }, 400);
    }
    try {
      await setMemberDefaultShare(env, body.id.trim(), body.default as "personal" | "company" | "inherit");
      return json({ ok: true, id: body.id.trim(), default: body.default });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/members/remove — soft offboarding. Marks the member removed,
  // deletes the personal workspace and everything in it; company-layer entries
  // the member authored stay (they are shared memory now). Guardrails inside
  // removeMember: not self, not the last active admin. The confirmation UX is
  // the dashboard's.
  if (url.pathname === "/team/members/remove" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const result = await removeMember(env, auth.userId, body.id.trim());
      if (result.vectorIds.length) {
        await env.VECTORIZE.deleteByIds(result.vectorIds);
      }
      return json({ ok: true, id: body.id.trim(), removedEntries: result.removedEntries, removedVectors: result.vectorIds.length });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // GET /team/me — caller's own profile row (any signed-in identity).
  if (url.pathname === "/team/me" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const row = await env.DB.prepare(
      `SELECT id AS userId, name, email, role FROM users WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
    ).bind(auth.userId).first<{ userId: string; name: string; email: string | null; role: string }>();
    if (!row) return json({ ok: false, error: "Not found" }, 404);
    return json({ ok: true, profile: row });
  }

  // POST /team/profile — rename self, or any member when caller is admin.
  if (url.pathname === "/team/profile" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; name?: string; email?: string | null };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const targetId = body.id?.trim() || auth.userId;
    if (targetId !== auth.userId && auth.role !== "admin") {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    try {
      await setMemberProfile(env, targetId, { name: body.name, email: body.email });
      return json({ ok: true, id: targetId });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // GET /stats
  if (url.pathname === "/stats" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const graceCutoff = Date.now() - graceMs(env);
    const [summary, tagRows, candidateRows] = await Promise.all([
      env.DB.prepare(
        // unvectorized skips deprecated entries: their vectors were deleted
        // deliberately, so counting them here offered the user a repair for
        // something that is not broken.
        `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
         SUM(CASE WHEN vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) as unvectorized,
         SUM(CASE WHEN tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%' THEN 1 ELSE 0 END) as unclassified
         FROM entries`
      ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
      // Reserved namespaces and pipeline markers are excluded here rather than
      // hidden in the client: this panel answers "what is my brain about?", and
      // kind:episodic outranked every real topic on a production brain. Numeric
      // tags are legacy issue references (see src/text/hashtags.ts). LIMIT is
      // raised because the filter now discards rows the ORDER BY ranked first.
      env.DB.prepare(
        `SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags)
         WHERE value NOT LIKE 'kind:%' AND value NOT LIKE 'status:%'
           AND value NOT LIKE 'volatility:%' AND value NOT LIKE 'stale:%'
           AND value NOT IN ('auto-pattern', 'auto-insight', 'synthesized', 'rolled-up', 'duplicate-candidate')
           AND value NOT GLOB '[0-9]*'
         GROUP BY value ORDER BY n DESC LIMIT 5`,
      ).all(),
      env.DB.prepare(`
        SELECT value as tag, COUNT(*) as count
        FROM entries, json_each(entries.tags)
        WHERE ${isTopicTagSql()}
          AND entries.tags NOT LIKE '%"rolled-up"%'
          AND entries.tags NOT LIKE '%"synthesized"%'
          AND entries.tags NOT LIKE '%"auto-pattern"%'
          AND entries.tags NOT LIKE '%"auto-insight"%'
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
        `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? ${TAG_LIKE_ESCAPE} AND created_at > ? LIMIT 1`
      ).bind(tagLikePattern(row.tag as string), cutoff).first();
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
  // README verify step, and external uptime checks. Authenticated like the
  // rest of the API but deliberately NOT admin-gated: it reports index state,
  // not cross-workspace data, and every signed-in member's dashboard banner
  // reads it.
  if (url.pathname === "/health" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const vectorize = await checkVectorizeHealth(env);
    // "team" is the dashboard's signal to show the layer controls (capture
    // target, share actions, layer filters). Layers exist on every v3 brain,
    // but until a second member is invited the toggle is noise for a solo
    // owner, so the flag reads actual membership, not provisioning.
    const members = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    return json({ ok: vectorize.ok, version: SB_VERSION, vectorize, team: (members?.n ?? 0) > 1 });
  }

  // GET /patterns — the whole review queue, paged.
  //
  // The dashboard used to build this list from `/list?n=20&tag=auto-pattern`
  // (the old producer) and drop the deprecated rows in the browser, which
  // cannot work on a brain that has been running a while: dismissed insight
  // proposals keep their tag forever, so once there are more than a page of
  // them the filter throws away every row and the panel renders empty while
  // real proposals wait behind them. Filtering belongs in the query.
  if (url.pathname === "/patterns" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, created_at FROM entries
         WHERE ${PENDING_INSIGHT_SQL}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(limit, offset).all(),
      // The total drives "N waiting" and the pager. It is a second query rather
      // than a window function so the shape survives D1's SQLite build.
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${PENDING_INSIGHT_SQL}`,
      ).first() as Promise<Record<string, any> | null>,
    ]);

    const pageIds = (rows.results as Record<string, any>[]).map(r => r.id as string);
    // One query for the whole page rather than one per insight. LEFT JOIN so a
    // source deleted after the edge was written still surfaces as a row — the
    // edges table has no foreign keys, so an edge can outlive its target, and
    // the reviewer needs to be told the source is gone rather than shown a gap.
    const sourcesByInsight = new Map<string, ({ id: string; content: string } | { id: string; missing: true })[]>();
    if (pageIds.length) {
      const sourceRows = (await env.DB.prepare(
        `SELECT e.source_id AS insight_id, e.target_id AS id, m.content AS content
         FROM edges e LEFT JOIN entries m ON m.id = e.target_id
         WHERE e.type = 'drawn_from' AND e.source_id IN (${pageIds.map(() => "?").join(",")})`,
      ).bind(...pageIds).all()).results as Record<string, any>[];
      for (const r of sourceRows) {
        const list = sourcesByInsight.get(r.insight_id as string) ?? [];
        list.push(
          r.content == null
            ? { id: r.id as string, missing: true }
            : { id: r.id as string, content: r.content as string },
        );
        sourcesByInsight.set(r.insight_id as string, list);
      }
    }

    return json({
      ok: true,
      patterns: (rows.results as Record<string, any>[]).map(r => ({
        id: r.id as string,
        content: r.content as string,
        created_at: r.created_at as number,
        sources: sourcesByInsight.get(r.id as string) ?? [],
      })),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // GET /stale — the out-of-date review queue.
  //
  // Home's chip reads "N may be out of date" off an exact tag predicate, so the
  // entries behind that number are knowable exactly. It used to be wired to a
  // free-text recall for the phrase "What might be out of date?" — a vector
  // search over the whole brain, which returns the flagged entries only by
  // coincidence, and on a real brain returned two memories that merely contained
  // the words while the one actually flagged never appeared.
  //
  // A client-side filter over /list is not the alternative: the dashboard holds
  // the 50 most recent entries, and a memory old enough to be flagged stale is
  // almost never among them. That is the same mistake the insight panel made
  // before /patterns existed, and it renders an empty list rather than a wrong
  // one. Filtering belongs in the query.
  if (url.pathname === "/stale" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated
         FROM entries
         WHERE ${STALE_REVIEW_SQL}
         ORDER BY COALESCE(updated_at, created_at) ASC LIMIT ? OFFSET ?`,
      ).bind(limit, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${STALE_REVIEW_SQL}`,
      ).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      // Oldest-touched first: the least recently confirmed claim is the one most
      // worth a human's attention, and it keeps paging stable while entries drop
      // out of the queue as they are edited.
      entries: (rows.results as Record<string, any>[]).map(r => ({
        id: r.id as string,
        content: r.content as string,
        tags: JSON.parse((r.tags as string) ?? "[]") as string[],
        source: r.source as string,
        created_at: r.created_at as number,
        last_updated: r.last_updated as number,
      })),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // POST /patterns/resolve — confirm or dismiss a proposed insight.
  // Dashboard-only, no MCP twin: insight review is a human curation act, not
  // an agent capability. Confirm promotes an insight into a real recallable
  // memory; dismiss deprecates it (audit row kept, vectors removed).
  //
  // Takes `id` for one or `ids` for many. Ruling on a backlog one at a time is
  // the actual complaint this answers, and doing it as N single requests would
  // be N round trips against a Worker that gets ~50 D1 queries per invocation.
  if (url.pathname === "/patterns/resolve" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; ids?: unknown; action?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const action = body.action;
    if (action !== "confirm" && action !== "dismiss") {
      return json({ ok: false, error: `action must be "confirm" or "dismiss"` }, 400);
    }

    const single = body.id?.trim();
    let ids: string[];
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some(i => typeof i !== "string")) {
        return json({ ok: false, error: "ids must be an array of strings" }, 400);
      }
      // De-duplicated because the same id twice would bind two parameters and
      // count the same row twice in the reply.
      ids = [...new Set((body.ids as string[]).map(i => i.trim()).filter(Boolean))];
      if (!ids.length) return json({ ok: false, error: "ids must not be empty" }, 400);
      // D1 allows 100 bound parameters per statement, and the id list is the
      // whole of the SELECT's binding. The client pages; this refuses rather
      // than silently truncating, because a silent truncation here reads as
      // "those patterns were resolved" when they were not.
      if (ids.length > MAX_PATTERN_BULK) {
        return json({ ok: false, error: `ids must not exceed ${MAX_PATTERN_BULK} per request` }, 400);
      }
    } else {
      if (!single) return json({ ok: false, error: "id is required" }, 400);
      ids = [single];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, tags, vector_ids FROM entries WHERE id IN (${placeholders})`,
    ).bind(...ids).all();
    const found = results as Record<string, any>[];

    // The single-id form keeps its precise errors, because a client asking about
    // one pattern can act on "not found" and the bulk form cannot.
    if (body.ids === undefined) {
      if (!found.length) return json({ ok: false, error: `No entry found with ID: ${ids[0]}` }, 404);
      if (!(JSON.parse(found[0].tags ?? "[]") as string[]).includes("auto-insight")) {
        return json({ ok: false, error: "Entry is not a derived insight" }, 400);
      }
    }

    const statements: D1PreparedStatement[] = [];
    const vectorsToDrop: string[] = [];
    const resolved: string[] = [];

    for (const row of found) {
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      // Anything that is not an unresolved pattern is skipped rather than
      // rejected: a bulk request built from a list the user was looking at can
      // legitimately race a nightly pass or a second tab.
      if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;

      if (action === "confirm") {
        // Losing the auto-insight tag is what exits the recall exclusion — it is
        // enforced at D1 hydration, not vector metadata, so this tag update alone
        // makes the entry recallable. No re-embed: content is unchanged and vectors
        // already exist (the stale auto-insight flag in vector metadata is harmless).
        const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
        statements.push(
          env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(promoted), row.id),
        );
      } else {
        // Inlined rather than calling deprecateEntry per id: that reads the row
        // again and issues its own UPDATE and its own Vectorize delete, so a
        // hundred dismissals would be three hundred subrequests. Same effect —
        // status:deprecated, vectors emptied, vectors deleted — in a fixed three.
        statements.push(
          env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
            .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", row.id),
        );
        vectorsToDrop.push(...(JSON.parse(row.vector_ids ?? "[]") as string[]));
      }
      resolved.push(row.id as string);
    }

    // One subrequest however many statements it holds, which is the whole reason
    // the loop above builds them instead of running them.
    if (statements.length) await env.DB.batch(statements);

    if (vectorsToDrop.length) {
      try {
        await env.VECTORIZE.deleteByIds(vectorsToDrop);
      } catch (e) {
        // D1 already says deprecated and recall filters on that, so the entries
        // are out of recall either way; the index just keeps some dead vectors.
        console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e);
      }
    }

    return json({
      ok: true,
      action,
      resolved: resolved.length,
      // Named, so a client that showed the user N rows can tell which survived a
      // race rather than assuming all of them were ruled on.
      ids: resolved,
      skipped: ids.length - resolved.length,
      ...(body.ids === undefined ? { id: ids[0] } : {}),
    });
  }

  // POST /vectorize-pending
  if (url.pathname === "/vectorize-pending" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const graceCutoff = Date.now() - graceMs(env);

    // Deprecated entries are skipped, matching the migration path
    // (src/migration/embedding.ts). Without this, dismissing a pattern deleted
    // its vectors and then this button put them straight back — spending the
    // daily embedding budget to reindex something the user had just told the
    // brain to drop, and crowding the vector query with candidates that recall
    // discards at hydration anyway.
    const { results: toProcess } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at FROM entries
       WHERE vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}
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
          row.created_at as number,
          // Without this the backfill embeds with DEFAULTS.EMBEDDING_MODEL while
          // capture and recall use the configured one, writing vectors from the
          // wrong model into the index — scores go quietly wrong, nothing throws.
          cfg
        );
        processed++;
      } catch (e) {
        console.error("Re-embed failed for entry", row.id, e);
        failed++;
      }
    }

    // Same filter as the select above, or the loop never reaches zero: the
    // dashboard presses this until `remaining` is 0, so counting rows the select
    // refuses to process would spin until the batch-made-no-progress guard.
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}`
    ).bind(graceCutoff).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  // POST /classify-pending
  // One-time, opt-in backfill: runs classifyEntry over entries that predate the
  // status (#119) and kind (#12) features and writes status:/kind: tags. Bounded
  // batch per call, idempotent (skips entries that already carry either tag), and
  // resumable (safe to stop/restart). No schema migration — only writes tags.
  if (url.pathname === "/classify-pending" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

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
        // cfg carries the user's LLM_MODEL choice; without it this backfill
        // classifies with the shipped default and ignores their setting.
        const { canonical, kind } = await classifyEntry(row.content as string, env, cfg);
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

  // POST /insights/accrue — run one accrual pass on demand, right now.
  //
  // The nightly cron (runInsightAccrual, src/insight/candidates.ts) examines
  // only ACCRUAL_SEED_LIMIT (25) entries per run, topped up from a backfill
  // cursor on quiet nights. That is fine for a brain that grows a little
  // every day, but a self-hoster installing this against an EXISTING brain
  // of a few thousand entries would otherwise wait months for the backfill
  // cursor to cross it once — the weekly pass would have almost nothing to
  // reason over, and the feature would look broken with no way to prime it.
  //
  // This calls the exact same function the cron does, once, synchronously,
  // and reports what it found — no separate accrual logic lives here. The
  // cursor it walks is the SAME cursor the nightly cron uses (KV key
  // ACCRUAL_CURSOR_KEY), so calling this repeatedly walks it forward exactly
  // like repeated nights would: that is the intended way to prime a large
  // brain, not a one-shot backfill. Call it until `seeds_examined` comes back
  // small — that means the cursor has caught up to the present.
  if (url.pathname === "/insights/accrue" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const pendingCount = () =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM insight_candidates WHERE status = 'pending'`)
        .first() as Promise<Record<string, any> | null>;

    // Before/after rather than threading a write-count out of
    // runInsightAccrual itself: every row it inserts starts 'pending' and
    // nothing else in this request can change that count concurrently, so
    // the delta is exactly how many candidates this pass newly recorded —
    // including the ON CONFLICT(a_id, b_id) DO NOTHING case, where an
    // attempted insert did not actually add a row.
    const before = await pendingCount();
    const { seedsExamined } = await runInsightAccrual(env, ctx);
    const after = await pendingCount();

    const pendingTotal = (after?.n as number) ?? 0;
    const pendingBefore = (before?.n as number) ?? 0;

    return json({
      ok: true,
      seeds_examined: seedsExamined,
      candidates_recorded: pendingTotal - pendingBefore,
      pending_total: pendingTotal,
    });
  }

  // GET /insights/dry-run — what the weekly pass would say, without saying it.
  //
  // Ships ahead of the weekly writer being enabled. The design was validated
  // against a brain that is not representative, so the first question is
  // whether the shortlist is any good on real data — and this answers it for
  // the price of a few model calls and no writes at all. A declined candidate
  // is reported with null shape/text rather than dropped, so a reader can see
  // a high-scoring pair was considered and rejected, not just what survived.
  if (url.pathname === "/insights/dry-run" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 10, min: 1, max: 25 });
    if (limit instanceof Response) return limit;

    // a.tags/b.tags added so this can apply the same D1 pair rule the weekly
    // pass applies (src/insight/weekly.ts) — without them, this endpoint
    // could not tell an assistant-authored pair from any other and would
    // report exactly what production refuses as if it would be written.
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, c.score, a.content AS a_content, b.content AS b_content,
              a.tags AS a_tags, b.tags AS b_tags
       FROM insight_candidates c
       JOIN entries a ON a.id = c.a_id
       JOIN entries b ON b.id = c.b_id
       WHERE c.status = 'pending'
         AND a.tags NOT LIKE '%"status:deprecated"%'
         AND b.tags NOT LIKE '%"status:deprecated"%'
       ORDER BY c.score DESC
       LIMIT ?`,
    ).bind(limit).all() as { results: Record<string, any>[] };

    // D2's comparison list, built exactly as src/insight/weekly.ts builds it:
    // insights still unreviewed from earlier runs, seeded before the loop and
    // grown as this preview accepts candidates. Without this, the dry run
    // could not reproduce the spec's own motivating case — a candidate
    // restating an insight a PRIOR run already wrote is invisible to a
    // same-run-only check.
    const { results: recentInsightRows } = await env.DB.prepare(
      `SELECT content FROM entries WHERE ${PENDING_INSIGHT_SQL}
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(RECENT_INSIGHT_WINDOW).all() as { results: { content: string }[] };
    const writtenThisRun: string[] = recentInsightRows.map(r => rawInsightText(r.content));

    const candidates = [];
    // Reasons over every row the query returned, deliberately past the three
    // production would ever write (src/insight/weekly.ts's own
    // MAX_INSIGHTS_PER_RUN cap) — seeing candidates four and beyond is how the
    // ranking itself gets judged. `would_write` marks the first three
    // candidates, in score order, that clear D1 (pair-eligible), the model
    // (an "insight" outcome), AND D2 (not restatesRecent against
    // writtenThisRun) — the same three gates runWeeklyInsights applies before
    // it ever calls captureEntry. This is close to but not exactly what
    // production's `written` counter tracks: that increments only when
    // captureEntry returns `status: "stored"`, so an accepted, non-restating
    // insight that turns out to duplicate an earlier ENTRY (not a recent
    // insight — captureEntry's own separate duplicate check) consumes no slot
    // there but is still counted here. A dry run cannot resolve that without
    // calling captureEntry, which would make it a write rather than a preview
    // — this is the one place that gap between preview and production is
    // recorded.
    let written = 0;
    for (const row of results) {
      // D1 at the draw (src/insight/weekly.ts): a pair this disqualified is
      // never sent to the model in production, so the preview must not spend
      // a model call on it either — otherwise the dry run reports as
      // writable exactly what production refuses, which is the bug the
      // Rollout section's comparison exists to catch.
      const aTags = parseTags(row.a_tags as string);
      const bTags = parseTags(row.b_tags as string);
      if (!isEligiblePair({ tags: aTags }, { tags: bTags })) {
        candidates.push({
          a_id: row.a_id as string,
          b_id: row.b_id as string,
          score: row.score as number,
          outcome: "pair_rejected",
          shape: null,
          text: null,
          would_write: false,
          reason: "both memories are assistant-authored (D1)",
        });
        continue;
      }

      // cfg carries the user's LLM_MODEL choice, same as the real weekly pass
      // (src/insight/weekly.ts) — without it this would preview reasoning from
      // the shipped default model rather than the one that will actually run.
      const result = await reasonOverPair(
        { content: row.a_content as string },
        { content: row.b_content as string },
        env,
        cfg,
      );

      // would_write and `reason` are worked out in the same order
      // runWeeklyInsights actually applies its checks: the cap (a candidate
      // reached only after production's loop would already have broken),
      // then D2's novelty floor, then acceptance. A decline or a failed call
      // is definitive regardless of where it falls in that order.
      let would_write = false;
      let reason: string | null = null;
      if (result.outcome === "declined") {
        reason = "the model declined this pair";
      } else if (result.outcome === "failed") {
        reason = "the model call itself failed";
      } else if (written >= MAX_INSIGHTS_PER_RUN) {
        reason = `the weekly cap of ${MAX_INSIGHTS_PER_RUN} insights would already be reached`;
      } else if (restatesRecent(result.text, writtenThisRun)) {
        // Same rule src/insight/weekly.ts applies (D2): reasoned to a real
        // insight, but the text lands where a reader has already been.
        reason = "restates a recently written insight";
      } else {
        would_write = true;
        written++;
        writtenThisRun.push(result.text);
      }

      candidates.push({
        a_id: row.a_id as string,
        b_id: row.b_id as string,
        score: row.score as number,
        // "declined" and "failed" are both reported, distinctly, rather than
        // collapsed to null: a human reading the shortlist can tell "the model
        // looked and said no" apart from "the call itself never answered",
        // which matters for judging whether the ranking or the model call is
        // the thing worth investigating.
        outcome: result.outcome,
        shape: result.outcome === "insight" ? result.shape : null,
        text: result.outcome === "insight" ? result.text : null,
        would_write,
        reason,
      });
    }

    return json({ ok: true, candidates });
  }

  return null;
}
