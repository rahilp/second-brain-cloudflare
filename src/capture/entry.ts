import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { createEdge, inferEdgesOnWrite } from "../graph/edges";
import { getStatus, withStatus } from "../memory/status";
import { extractHashtags } from "../text/hashtags";
import { scheduleClassifyAndTag } from "./classify";
import { checkDuplicateAndContradiction } from "./duplicate";
import { deprecateEntry } from "./lifecycle";
import { deleteStaleVectors, reembedOrThrow, storeEntry } from "./store";
import { tagsAfterWrite } from "../memory/stale";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { rememberTags } from "../tags/vocabulary";

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  // Escaped for the same reason as the recall path: `_` and `%` in a tag are LIKE
  // wildcards, so `#q3_planning` would also list `q3-planning` entries and `?tag=%` would
  // list everything. A read, so over-broad rather than destructive — but a filter that
  // silently stops filtering is worse than one that returns nothing.
  if (params.tag) { conds.push(`tags LIKE ? ${TAG_LIKE_ESCAPE}`); bindings.push(tagLikePattern(params.tag)); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }

  let sql = `SELECT id, content, tags, source, created_at, vector_ids FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string }
  | { status: "contradiction_protected"; id: string; canonicalId: string; reason?: string }
  | { status: "merged"; id: string }
  | { status: "replaced"; id: string };

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  config?: Readonly<Config>
): Promise<CaptureResult> {
  // Resolved once per capture and threaded through duplicate detection and
  // every embed below. Recall and capture must agree on EMBEDDING_MODEL or the
  // vectors they produce are not comparable.
  const cfg = config ?? await resolveConfig(env);
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  const t = [...new Set([...tags.map(tag => tag.toLowerCase()), ...hashtags])];

  const { duplicate: dup, contradiction, mergeAction, neighbors } = await checkDuplicateAndContradiction(c, env, cfg);

  if (dup.status === "blocked") {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  if (dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both") {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      `SELECT tags, source, vector_ids, importance_score FROM entries WHERE id = ?`
    ).bind(targetId).first() as Record<string, any> | null;

    if (targetRow) {
      const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
      const existingSource = targetRow.source as string;
      const oldVectorIds: string[] = JSON.parse(targetRow.vector_ids ?? "[]");

      const targetStatus = getStatus(existingTags);
      if ((targetRow.importance_score as number) >= 4 || targetStatus === "canonical") {
        return { status: "flagged", id: crypto.randomUUID(), matchId: targetId, score: dup.score };
      }

      let newVectorIds: string[] | null = null;
      try {
        newVectorIds = await reembedOrThrow(env, targetId, newContent, existingTags, existingSource, cfg);
      } catch (e) {
        console.error("Merge re-embed failed — keeping both, target untouched:", e);
      }

      if (newVectorIds) {
        const refreshedTags = tagsAfterWrite(existingTags);
        const now = Date.now();
        await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
          .bind(newContent, JSON.stringify(refreshedTags), now, targetId).run();
        try {
          await deleteStaleVectors(env, oldVectorIds, newVectorIds);
        } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

        scheduleClassifyAndTag(targetId, newContent, env, ctx, cfg);

        return mergeAction.action === "merge"
          ? { status: "merged", id: targetId }
          : { status: "replaced", id: targetId };
      }
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const baseTags = contradiction.detected ? [...t, "contradiction-resolved"] : t;
  const finalTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;

  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, c, JSON.stringify(finalTags), source, now, now, "[]").run();

  ctx.waitUntil(
    storeEntry(env, id, c, finalTags, source, now, cfg)
      .catch(e => console.error("Vectorize insert failed (non-fatal):", e))
  );

  // Capture is where a tag string nobody wrote into the source first exists, so it is
  // one of the two places the cached vocabulary has to learn one (#288). Deferred, so
  // the capture does not wait on KV — which means the tag is admitted once this
  // settles rather than by the time the response lands, and a `GET /tags` fired
  // straight off the back of the save can miss it by one refresh.
  ctx.waitUntil(rememberTags(env, finalTags));

  scheduleClassifyAndTag(id, c, env, ctx, cfg);

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    const conflictRow = await env.DB.prepare(
      `SELECT tags FROM entries WHERE id = ?`
    ).bind(conflictId).first() as Record<string, any> | null;
    const conflictStatus = conflictRow ? getStatus(JSON.parse(conflictRow.tags ?? "[]")) : null;

    if (conflictStatus === "canonical") {
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
        .bind(JSON.stringify(withStatus(draftTags, "draft")), id).run();
      try {
        await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(conflictId).run();
        await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(id).run();
      } catch (e) {
        console.error("Contradiction count update failed (non-fatal):", e);
      }
      return { status: "contradiction_protected", id, canonicalId: conflictId, reason: contradiction.reason };
    }

    try {
      await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(id).run();
      await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(conflictId).run();
    } catch (e) {
      console.error("Contradiction count update failed (non-fatal):", e);
    }
    try {
      await deprecateEntry(conflictId, env);
    } catch (e) {
      console.error("Contradiction deprecation failed (non-fatal):", e);
    }
    try {
      await createEdge(id, conflictId, "supersedes", { provenance: "system", weight: 1.0 }, env);
    } catch (e) {
      console.error("Supersedes edge creation failed (non-fatal):", e);
    }
    ctx.waitUntil(inferEdgesOnWrite(id, neighbors.filter(n => n.id !== conflictId), env).catch(e => console.error("Edge inference failed (non-fatal):", e)));
    return { status: "contradiction", id, resolvedConflict: conflictId, reason: contradiction.reason };
  }

  ctx.waitUntil(inferEdgesOnWrite(id, neighbors, env).catch(e => console.error("Edge inference failed (non-fatal):", e)));

  if (dup.status === "flagged") {
    return { status: "flagged", id, matchId: dup.matchId, score: dup.score };
  }

  return { status: "stored", id };
}
