import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { createEdge, inferEdgesOnWrite } from "../graph/edges";
import { getStatus, withStatus, type MemoryStatus } from "../memory/status";
import { extractHashtags } from "../text/hashtags";
import { classifyThenInfer, scheduleClassifyAndTag } from "./classify";
import { checkDuplicateAndContradiction } from "./duplicate";
import { deprecateEntry } from "./lifecycle";
import { deleteStaleVectors, reembedOrThrow, storeEntry } from "./store";
import { tagsAfterWrite } from "../memory/stale";
import { getVolatility, withVolatility } from "../memory/volatility";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { rememberTags } from "../tags/vocabulary";
import { isCapsuleTag } from "../tags/system";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";
import { TRANSCRIPT_SOURCES } from "../constants";

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
  /**
   * A single resolved actor_id, already checked against the caller's roster by
   * resolveActorFilter (src/lib/actors.ts). One id, never a list: the filter has
   * to stay ONE predicate with ONE binding, because binding one parameter per
   * author is what put the author-label lookup over D1's 100-parameter ceiling
   * on a large team and 500'd the request.
   */
  actor?: string;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  // Escaped for the same reason as the recall path: `_` and `%` in a tag are LIKE
  // wildcards, so `#q3_planning` would also list `q3-planning` entries and `?tag=%` would
  // list everything. A read, so over-broad rather than destructive — but a filter that
  // silently stops filtering is worse than one that returns nothing.
  if (params.tag) { conds.push(`tags LIKE ? ${TAG_LIKE_ESCAPE}`); bindings.push(tagLikePattern(params.tag)); }
  // An equality on one id, ANDed with everything else including the caller's
  // scope clause — so it can only ever narrow what the scope already allowed.
  // Tested against undefined rather than truthiness for the reason the tag
  // comment above gives: `actor: ""` is the legacy authorless rows, a real and
  // narrow answer, and a filter that silently stops filtering and returns the
  // whole listing instead is the worst of the three outcomes.
  if (params.actor !== undefined) { conds.push(`actor_id = ?`); bindings.push(params.actor); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }

  // scope-exempt: builder only: callers splice the caller's scope in before ORDER BY — routes/recall.ts always, but mcp/server.ts only `if (identity)`, so an identity-less MCP caller gets this SQL unscoped
  let sql = `SELECT id, content, tags, source, created_at, vector_ids, workspace_id, actor_id FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string; tags: string[] }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string }
  | { status: "contradiction_protected"; id: string; canonicalId: string; entryStatus: MemoryStatus | null; reason?: string }
  | { status: "merged"; id: string }
  | { status: "replaced"; id: string };

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  config?: Readonly<Config>,
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT
): Promise<CaptureResult> {
  // Resolved once per capture and threaded through duplicate detection and
  // every embed below. Recall and capture must agree on EMBEDDING_MODEL or the
  // vectors they produce are not comparable.
  const cfg = config ?? await resolveConfig(env);
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  const t = [...new Set([...tags.map(tag => tag.toLowerCase()), ...hashtags])];

  const { duplicate: dup, contradiction, mergeAction, neighbors } = await checkDuplicateAndContradiction(c, env, cfg, writeCtx.workspaceId, ctx);

  if (dup.status === "blocked") {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  // A capsule definition must land as its own row: a merge discards the
  // incoming tags, and the slot tags are the whole point of the write.
  const definesCapsule = t.some(isCapsuleTag);

  if (dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both" && !definesCapsule) {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      // scope-exempt: by-id: the merge target is one of the ids checkDuplicateAndContradiction hydrated under `AND workspace_id = ?` against this same writeCtx.workspaceId, and it only returns ids it hydrated — so this row is already known to be in the workspace being written to
      `SELECT tags, source, vector_ids, importance_score FROM entries WHERE id = ?`
    ).bind(targetId).first() as Record<string, any> | null;

    if (targetRow) {
      const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
      const existingSource = targetRow.source as string;
      const oldVectorIds: string[] = JSON.parse(targetRow.vector_ids ?? "[]");

      const targetStatus = getStatus(existingTags);
      // A protected target is left alone and the newcomer is STORED below as a
      // duplicate-candidate. This branch used to `return` a random id here
      // without inserting anything, so the route reported success for a row
      // that did not exist (#327 review). The third clause is the transcript
      // rule from TRANSCRIPT_SOURCES.
      const protectedTarget =
        (targetRow.importance_score as number) >= 4
        || targetStatus === "canonical"
        || (TRANSCRIPT_SOURCES.has(source) && existingSource !== source);

      if (!protectedTarget) {
        let newVectorIds: string[] | null = null;
        try {
          newVectorIds = (await reembedOrThrow(env, targetId, newContent, existingTags, existingSource, cfg, writeCtx)).vectorIds;
        } catch (e) {
          console.error("Merge re-embed failed — keeping both, target untouched:", e);
        }

        if (newVectorIds) {
          // The rest of the incoming tag list is deliberately discarded on a merge, which
          // predates this and is left alone — but the volatility verdict cannot be, because
          // it is the one value the tool schema tells the caller wins permanently. Dropping
          // it here reported "merged" on a write that silently threw the judgment away, and
          // the merge bumps updated_at, so the nightly pass would not revisit the entry for
          // 90 days to re-derive anything. The caller judged the content being merged in, so
          // its verdict describes the combined body more recently than the target's does.
          const incomingVerdict = getVolatility(t);
          const stripped = tagsAfterWrite(existingTags);
          const refreshedTags = incomingVerdict ? withVolatility(stripped, incomingVerdict) : stripped;
          const now = Date.now();
          await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
            .bind(newContent, JSON.stringify(refreshedTags), now, targetId).run();
          try {
            await deleteStaleVectors(env, oldVectorIds, newVectorIds);
          } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

          // The survivor's content just changed, so its graph position should
          // too. `neighbors` is the answer duplicate detection already got from
          // Vectorize for this same text, reused rather than asked again — the
          // merge therefore adds no query and no embed of its own.
          // inferEdgesOnWrite drops the written id from its own candidates, so
          // the target needs no filtering. dup.matchId does: the model picks the
          // merge target and is free to choose the SECOND-best match, leaving
          // the closest near-duplicate in `neighbors` — and linking the survivor
          // to that is the junk edge suppression exists to prevent, arriving by
          // a different door.
          classifyThenInfer(targetId, newContent, env, ctx, cfg, kind =>
            inferEdgesOnWrite(targetId, neighbors, env, { suppressId: dup.matchId, newKind: kind }));

          return mergeAction.action === "merge"
            ? { status: "merged", id: targetId }
            : { status: "replaced", id: targetId };
        }
      }
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const baseTags = contradiction.detected ? [...t, "contradiction-resolved"] : t;
  const finalTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;

  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, c, JSON.stringify(finalTags), source, now, now, "[]", writeCtx.workspaceId, writeCtx.actorId).run();

  ctx.waitUntil(
    storeEntry(env, id, c, finalTags, source, now, cfg, writeCtx)
      .catch(e => console.error("Vectorize insert failed (non-fatal):", e))
  );

  // Capture is where a tag string nobody wrote into the source first exists, so it is
  // one of the two places the cached vocabulary has to learn one (#288). Deferred, so
  // the capture does not wait on KV — which means the tag is admitted once this
  // settles rather than by the time the response lands, and a `GET /tags` fired
  // straight off the back of the save can miss it by one refresh.
  ctx.waitUntil(rememberTags(env, finalTags, writeCtx.workspaceId));

  // A flagged capture is a near-duplicate the writer chose to keep, so the
  // entry it duplicates is its top neighbour by construction. Linking them
  // spends an inference slot restating the duplicate-candidate tag.
  const suppressId = dup.status === "flagged" ? dup.matchId : undefined;

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    const conflictRow = await env.DB.prepare(
      // scope-exempt: by-id: the conflict id is one of the ids checkDuplicateAndContradiction hydrated under `AND workspace_id = ?` against this same writeCtx.workspaceId, and it only returns ids it hydrated — so this row is already known to be in the workspace being written to
      `SELECT tags, source FROM entries WHERE id = ?`
    ).bind(conflictId).first() as Record<string, any> | null;
    const conflictStatus = conflictRow ? getStatus(JSON.parse(conflictRow.tags ?? "[]")) : null;
    const conflictSource = conflictRow ? String(conflictRow.source ?? "") : "";
    // Canonical memories were always protected here. A transcript gets the same
    // treatment against any memory of another source: the newcomer becomes a
    // draft and nothing is deprecated, because "we decided X… actually Y" in a
    // session log is not evidence that the memory of X is wrong.
    const protectConflict =
      conflictStatus === "canonical"
      || (TRANSCRIPT_SOURCES.has(source) && conflictSource !== source);

    if (protectConflict) {
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      // A capsule definition keeps the status its caller chose: demoting it to
      // draft would silently drop it from the capsule.
      const protectedTags = definesCapsule ? draftTags : withStatus(draftTags, "draft");
      await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
        .bind(JSON.stringify(protectedTags), id).run();
      try {
        await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(conflictId).run();
        await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(id).run();
      } catch (e) {
        console.error("Contradiction count update failed (non-fatal):", e);
      }
      // This path draws no edges, so there is nothing to chain onto.
      scheduleClassifyAndTag(id, c, env, ctx, cfg);
      return {
        status: "contradiction_protected",
        id,
        canonicalId: conflictId,
        entryStatus: getStatus(protectedTags),
        reason: contradiction.reason,
      };
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
      // Stamped with the workspace this capture was written to, for the same
      // reason POST /link and the MCP link tool stamp theirs: edges.workspace_id
      // has no default worth having — it falls back to "", the legacy/system
      // space, which readableWorkspaces grants to ADMINS ONLY. An edge left
      // there is one the member whose capture drew it can never see in their own
      // graph. writeCtx is already the resolved answer to "which workspace did
      // this entry land in", so no second lookup is needed.
      await createEdge(id, conflictId, "supersedes", { provenance: "system", weight: 1.0, workspaceId: writeCtx.workspaceId }, env);
    } catch (e) {
      console.error("Supersedes edge creation failed (non-fatal):", e);
    }
    classifyThenInfer(id, c, env, ctx, cfg, kind =>
      inferEdgesOnWrite(id, neighbors.filter(n => n.id !== conflictId), env, { suppressId, newKind: kind }));
    return { status: "contradiction", id, resolvedConflict: conflictId, reason: contradiction.reason };
  }

  classifyThenInfer(id, c, env, ctx, cfg, kind =>
    inferEdgesOnWrite(id, neighbors, env, { suppressId, newKind: kind }));

  if (dup.status === "flagged") {
    return { status: "flagged", id, matchId: dup.matchId, score: dup.score };
  }

  // finalTags is what actually landed on the row — hashtags pulled out of the
  // content, plus anything the caller passed. The dashboard shows it back as a
  // capture receipt, so a person can see what the brain did with what they
  // wrote rather than trusting it silently.
  return { status: "stored", id, tags: finalTags };
}
