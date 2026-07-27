import type { Env } from "../env";
import { CHUNK_MAX_CHARS } from "../constants";
import { embed } from "../lib/ai";
import { inferEdgesOnWrite } from "../graph/edges";
import { neighborsFromVectorQuery } from "../graph/traverse";
import { chunkText } from "../text/chunk";

export async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number
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
        values: await embed(chunk, env),
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

export async function reembedOrThrow(env: Env, id: string, content: string, tags: string[], source: string): Promise<string[]> {
  const ids = await storeEntry(env, id, content, tags, source, Date.now());
  if (!ids.length) throw new Error("re-embed produced no vectors");
  return ids;
}

export async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  const existingVectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  if (newContent.length > CHUNK_MAX_CHARS) {
    const newVectorIds = await reembedOrThrow(env, id, newContent, tags, source);

    await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
      .bind(newContent, id).run();

    try {
      await deleteStaleVectors(env, existingVectorIds, newVectorIds);
    } catch (e) {
      console.error("Old vector cleanup failed (non-fatal):", e);
    }

    try {
      await inferEdgesOnWrite(id, await neighborsFromVectorQuery(await embed(addition, env), env), env);
    } catch (e) {
      console.error("Append auto-link failed (non-fatal):", e);
    }

    return;
  }

  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env);

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

  await env.VECTORIZE.insert([{
    id: newChunkId,
    values,
    metadata,
  }]);

  await env.DB.prepare(
    `UPDATE entries SET content = ?, vector_ids = ? WHERE id = ?`
  ).bind(newContent, JSON.stringify([...existingVectorIds, newChunkId]), id).run();

  try {
    await inferEdgesOnWrite(id, await neighborsFromVectorQuery(values, env), env);
  } catch (e) {
    console.error("Append auto-link failed (non-fatal):", e);
  }
}
