import type { Env } from "../env";
import { resolveConfig } from "../config";
import { json, requireAuth } from "../lib/http";
import { captureEntry } from "../capture/entry";
import { appendToEntry, deleteStaleVectors, reembedOrThrow } from "../capture/store";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import { extractHashtags } from "../text/hashtags";

export async function handleCaptureRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /capture
  if (url.pathname === "/capture" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { content?: string; tags?: string[]; source?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

    const result = await captureEntry(body.content, body.tags ?? [], body.source ?? "api", env, ctx);

    if (result.status === "blocked") {
      return json({
        ok: false,
        duplicate: true,
        matchId: result.matchId,
        score: parseFloat((result.score * 100).toFixed(1)),
        message: "Near-exact duplicate detected — not stored",
      });
    }
    if (result.status === "contradiction") {
      return json({ ok: true, id: result.id, resolved_conflict: result.resolvedConflict, reason: result.reason });
    }
    if (result.status === "contradiction_protected") {
      return json({ ok: true, id: result.id, status: "draft", kept_canonical: result.canonicalId, reason: result.reason });
    }
    if (result.status === "replaced") {
      return json({ ok: true, id: result.id, action: "replaced", message: "New memory replaced an outdated existing entry" });
    }
    if (result.status === "merged") {
      return json({ ok: true, id: result.id, action: "merged", message: "Memories merged into a single combined entry" });
    }
    if (result.status === "flagged") {
      return json({
        ok: true,
        id: result.id,
        warning: "similar",
        matchId: result.matchId,
        score: parseFloat((result.score * 100).toFixed(1)),
        message: "Stored but similar entry exists — tagged as duplicate-candidate",
      });
    }
    return json({ ok: true, id: result.id });
  }

  // POST /append
  if (url.pathname === "/append" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { id?: string; addition?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!body.addition?.trim()) return json({ ok: false, error: "addition is required" }, 400);

    const id = body.id.trim();
    const addition = body.addition.trim();

    const row = await env.DB.prepare(
      `SELECT id, content, tags, source FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;

    if (!row) {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    const existingContent = row.content as string;
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    const source = row.source as string;

    if (await isManagedMirror(source, env)) {
      return json({ ok: false, error: mirrorEditError(source) }, 409);
    }

    try {
      await appendToEntry(env, id, existingContent, addition, tags, source, await resolveConfig(env));
    } catch (e) {
      return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
    }

    return json({
      ok: true,
      id,
      message: "Update appended successfully with timestamp",
    });
  }

  // POST /update
  if (url.pathname === "/update" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { id?: string; content?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

    const id = body.id.trim();
    const newContent = body.content.trim();

    const row = await env.DB.prepare(
      `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;

    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

    if (await isManagedMirror(row.source as string, env)) {
      return json({ ok: false, error: mirrorEditError(row.source as string) }, 409);
    }

    const tags: string[] = JSON.parse(row.tags ?? "[]");
    const { cleanContent, hashtags: newHashtags } = extractHashtags(newContent);
    const mergedTags = [...new Set([...tags, ...newHashtags])];
    const source = row.source as string;
    const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
    const finalContent = cleanContent || newContent;

    // Re-embed FIRST (#212): if it fails, leave the entry's content and vectors
    // untouched and surface an error, instead of committing new content and then
    // deleting every vector — which would leave the entry silently unsearchable.
    let newVectorIds: string[];
    try {
      newVectorIds = await reembedOrThrow(env, id, finalContent, mergedTags, source, await resolveConfig(env));
    } catch (e) {
      console.error("Re-embed failed — entry left unchanged:", e);
      return json({ ok: false, error: "Couldn't update: search re-index failed. Your memory is unchanged — please try again." }, 500);
    }

    // Embed succeeded → safe to commit the new content and retire stale vectors.
    await env.DB.prepare(`UPDATE entries SET content = ?, tags = ? WHERE id = ?`)
      .bind(finalContent, JSON.stringify(mergedTags), id).run();

    try {
      await deleteStaleVectors(env, oldVectorIds, newVectorIds);
    } catch (e) {
      console.error("Old vector cleanup failed (non-fatal):", e);
    }

    return json({ ok: true, id, vectors: newVectorIds.length });
  }

  return null;
}
