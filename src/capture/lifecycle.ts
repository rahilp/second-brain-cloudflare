import type { Env } from "../env";
import { withStatus, type MemoryStatus } from "../memory/status";

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number };

export async function forgetEntry(id: string, env: Env): Promise<ForgetResult> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) return { status: "not_found" };

  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

  try {
    await env.DB.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).bind(id, id).run();
  } catch (e) {
    console.error("Edge cascade-delete failed (non-fatal):", e);
  }

  try {
    if (vectorIds.length) {
      await env.VECTORIZE.deleteByIds(vectorIds);
    }
  } catch (e) {
    console.error("Vectorize delete failed (non-fatal):", e);
  }

  return { status: "deleted", vectorCount: vectorIds.length };
}

export async function deprecateEntry(id: string, env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT tags, vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  await env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
    .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", id).run();

  try {
    if (vectorIds.length) await env.VECTORIZE.deleteByIds(vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

export async function applyStatus(id: string, status: MemoryStatus, env: Env): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env);
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(withStatus(tags, status)), id).run();
  return true;
}
