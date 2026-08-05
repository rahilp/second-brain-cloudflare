import type { Env } from "../env";
import { resolveConfig } from "../config";
import { VECTORIZE_FIX_HINT } from "../constants";
import { json, requireAuth } from "../lib/http";
import { captureEntry } from "../capture/entry";
import { appendToEntry, updateEntryContent } from "../capture/store";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";

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

    let indexed: boolean;
    try {
      indexed = await appendToEntry(env, id, existingContent, addition, tags, source, await resolveConfig(env));
    } catch (e) {
      return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
    }

    return json({
      ok: true,
      id,
      semantic_unavailable: !indexed,
      message: indexed
        ? "Update appended successfully with timestamp"
        : `Update appended, but not indexed for semantic search (Vectorize unavailable) — it is still findable by keyword. Fix: ${VECTORIZE_FIX_HINT}.`,
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

    // Refuse before anything is written. Only `source` is needed: updateEntryContent reads
    // the rest for itself, and keeping the mirror guard out here is what stops
    // capture/store.ts having to depend on the integrations registry (see #289).
    const row = await env.DB.prepare(
      `SELECT source FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;

    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

    if (await isManagedMirror(row.source as string, env)) {
      return json({ ok: false, error: mirrorEditError(row.source as string) }, 409);
    }

    const result = await updateEntryContent(env, id, newContent, await resolveConfig(env));

    // Only reachable if the entry was deleted between the guard read and the write.
    if (result.status === "not_found") {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    if (result.status === "reembed_failed") {
      return json({ ok: false, error: "Couldn't update: search re-index failed. Your memory is unchanged — please try again." }, 500);
    }

    if (!result.vectorIds) {
      return json({
        ok: true,
        id,
        vectors: 0,
        semantic_unavailable: true,
        message: `Updated, but not re-indexed for semantic search (Vectorize unavailable) — the previous index is kept and it is still findable by keyword. Fix: ${VECTORIZE_FIX_HINT}.`,
      });
    }

    return json({ ok: true, id, vectors: result.vectorIds.length });
  }

  return null;
}
