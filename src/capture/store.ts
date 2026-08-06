import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { CHUNK_MAX_CHARS } from "../constants";
import { embed } from "../lib/ai";
import { inferEdgesOnWrite } from "../graph/edges";
import { neighborsFromVectorQuery } from "../graph/traverse";
import { chunkText } from "../text/chunk";
import { rememberTags } from "../tags/vocabulary";
import { extractHashtags } from "../text/hashtags";
import { isVectorizeUnavailable } from "../vectorize/health";
import { tagsAfterWrite, tagsAfterAppend } from "../memory/stale";
import { withVolatility, type Volatility } from "../memory/volatility";

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  config: Readonly<Config> = DEFAULTS
): Promise<string[]> {
  const chunks = chunkText(content);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
      };

      tags.forEach(t => {
        metadata[`tag_${t.replace(/[."]/g, "_")}`] = true;
      });

      return {
        id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
        values: await embed(chunk, env, config),
        metadata,
      };
    })
  );

  await env.VECTORIZE.upsert(vectors);

  const vectorIds = vectors.map(v => v.id);

  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  return vectorIds;
}

export async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  if (!newIds.length) return;
  const stale = oldIds.filter(v => !newIds.includes(v));
  if (stale.length) await env.VECTORIZE.deleteByIds(stale);
}

export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS): Promise<string[]> {
  const ids = await storeEntry(env, id, content, tags, source, Date.now(), config);
  if (!ids.length) throw new Error("re-embed produced no vectors");
  return ids;
}

/**
 * Re-embed for a content mutation. Returns the new vector ids, or null when
 * Vectorize is unreachable and the caller should commit the content keyword-only
 * (#270). Rethrows every other failure so #212's fail-loud contract survives:
 * a transient embed failure must not commit content against stale vectors.
 *
 * Callers that get null MUST NOT retire the old vectors — they are the entry's
 * only remaining semantic index until Vectorize returns.
 */
export async function reembedOrDegrade(env: Env, id: string, content: string, tags: string[], source: string, config: Readonly<Config> = DEFAULTS): Promise<string[] | null> {
  try {
    return await reembedOrThrow(env, id, content, tags, source, config);
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — committing content without re-embedding:", e);
    return null;
  }
}

/**
 * What `updateEntryContent` did, in the terms its callers have to answer in.
 *
 * `vectorIds: null` is the keyword-only degrade (#270) — the content committed but
 * Vectorize was unreachable, so the entry still carries its previous embedding.
 */
export type UpdateEntryResult =
  | { status: "not_found" }
  | { status: "reembed_failed" }
  | { status: "updated"; vectorIds: string[] | null };

/**
 * Replace an entry's content outright, keeping D1, the tags and the vector index in step.
 *
 * `POST /update` and the MCP `update` tool both land here. They used to be two
 * implementations of the same thing, and the copy behind MCP — the one every assistant
 * client actually calls — silently missed every hardening the route gained (#289): it
 * committed content against stale vectors when an embed failed, never moved the entry's
 * updated_at, never reset the staleness tags, and never extracted hashtags. Anything that
 * decides what gets written lives in here now; the callers only shape the reply.
 * (updated_at is named bare above on purpose — test/unit/updated-at-coalesced.test.ts reads
 * every backtick-delimited span in src/ as SQL, comments included.)
 *
 * The one thing they still do for themselves is the managed-mirror guard, because
 * `integrations/mirror.ts` imports this module and the dependency must not run both ways.
 * That guard refuses before anything is written, so a drift there cannot corrupt a row —
 * unlike everything below, which is why everything below moved.
 */
export async function updateEntryContent(
  env: Env,
  id: string,
  newContent: string,
  config: Readonly<Config> = DEFAULTS,
  volatility?: Volatility
): Promise<UpdateEntryResult> {
  // vector_ids has to be read before any mutation: storeEntry overwrites it, and the
  // cleanup below needs to know which vectors the entry had on the way in.
  const row = await env.DB.prepare(
    `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) return { status: "not_found" };

  const source = row.source as string;
  const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  const existingTags: string[] = JSON.parse(row.tags ?? "[]");

  // Same treatment captureEntry gives every stored memory, which is the point — but note it
  // flattens all whitespace, so a replacement does not preserve line breaks or code fences.
  // `appendToEntry` deliberately does not flatten; prefer append when the shape matters.
  const { cleanContent, hashtags } = extractHashtags(newContent);
  // Content that is nothing but hashtags cleans down to "", which would blank the entry —
  // keep it as written in that case and let the tags be extracted anyway.
  const finalContent = cleanContent || newContent;
  // A caller-supplied verdict is applied after the strip, not before: tagsAfterWrite
  // removes every volatility tag, so applying it first would throw the value away.
  const strippedTags = tagsAfterWrite([...new Set([...existingTags, ...hashtags])]);
  const mergedTags = (volatility ? withVolatility(strippedTags, volatility) : strippedTags)
    // `rolled-up` is a claim about content that no longer exists: the nightly digest wrote
    // it in the same statement that appended a `[Digest: <id>]` marker to the body, and a
    // full replacement destroys that marker. Left in place it costs the corrected memory a
    // 0.4x recall penalty (recall/math.ts) and bars it from every future digest, burying
    // the only copy of the new fact. The same reasoning tagsAfterWrite applies to the
    // volatility/staleness verdicts, and the reason `append` must NOT strip it — an append
    // keeps the digested original inside the entry, so the digest still covers it.
    .filter(t => t !== "rolled-up");

  // Re-embed FIRST (#212): if it fails, leave the entry's content and vectors untouched and
  // surface an error, instead of committing new content and then deleting every vector —
  // which would leave the entry silently unsearchable. null means Vectorize is unreachable
  // (#270), not that this embed failed.
  let newVectorIds: string[] | null;
  try {
    newVectorIds = await reembedOrDegrade(env, id, finalContent, mergedTags, source, config);
  } catch (e) {
    console.error("Re-embed failed — entry left unchanged:", e);
    return { status: "reembed_failed" };
  }

  // Safe to commit: either the embed succeeded, or Vectorize is unavailable and the old
  // vectors are kept below rather than retired.
  await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
    .bind(finalContent, JSON.stringify(mergedTags), Date.now(), id).run();

  // Rewritten content can carry hashtags the brain has never seen, so this is one of the
  // two places an unknown tag enters the corpus (#288). It sits here rather than in the
  // route because #289 made this the single update path — putting it in the caller would
  // have left the MCP tool introducing tags the cache never learned about.
  await rememberTags(env, mergedTags);

  if (newVectorIds) {
    try {
      await deleteStaleVectors(env, oldVectorIds, newVectorIds);
    } catch (e) {
      console.error("Old vector cleanup failed (non-fatal):", e);
    }
  }

  return { status: "updated", vectorIds: newVectorIds };
}

export async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string,
  config: Readonly<Config> = DEFAULTS,
  volatility?: Volatility
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  const existingVectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  // Computed once and used by both branches below so they cannot drift. Unlike a
  // replacement this keeps any existing volatility verdict (see tagsAfterAppend); a
  // caller-supplied one still overrides it.
  const appendedTags = tagsAfterAppend(tags);
  const refreshedTags = volatility ? withVolatility(appendedTags, volatility) : appendedTags;

  if (newContent.length > CHUNK_MAX_CHARS) {
    const newVectorIds = await reembedOrDegrade(env, id, newContent, tags, source, config);
    const now = Date.now();

    await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
      .bind(newContent, JSON.stringify(refreshedTags), now, id).run();

    // Skipped when Vectorize is unavailable: the old vectors are the entry's only
    // remaining semantic index, and retiring them would leave it unsearchable.
    if (newVectorIds) {
      try {
        await deleteStaleVectors(env, existingVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }
    }

    try {
      await inferEdgesOnWrite(id, await neighborsFromVectorQuery(await embed(addition, env, config), env), env);
    } catch (e) {
      console.error("Append auto-link failed (non-fatal):", e);
    }

    return newVectorIds !== null;
  }

  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env, config);

  const metadata: Record<string, any> = {
    content: addition,
    parentId: id,
    isUpdate: true,
    tags,
    source,
    created_at: Date.now(),
  };

  tags.forEach(t => {
    metadata[`tag_${t.replace(/[."]/g, "_")}`] = true;
  });

  // Committed either way: keyword search reads entries.content, so an unindexed
  // addition is still recallable, whereas rejecting the append loses it outright.
  // A transient failure still throws — nothing is written yet, so the retry is safe.
  let indexed = true;
  try {
    await env.VECTORIZE.insert([{
      id: newChunkId,
      values,
      metadata,
    }]);
  } catch (e) {
    if (!(await isVectorizeUnavailable(env))) throw e;
    console.error("Vectorize unavailable — appending without indexing the addition:", e);
    indexed = false;
  }

  const now = Date.now();

  await env.DB.prepare(
    `UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ? WHERE id = ?`
  ).bind(newContent, JSON.stringify(indexed ? [...existingVectorIds, newChunkId] : existingVectorIds), JSON.stringify(refreshedTags), now, id).run();

  try {
    await inferEdgesOnWrite(id, await neighborsFromVectorQuery(values, env), env);
  } catch (e) {
    console.error("Append auto-link failed (non-fatal):", e);
  }

  return indexed;
}
