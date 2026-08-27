import type { Env } from "../env";
import { resolveConfig } from "../config";
import { VECTORIZE_FIX_HINT } from "../constants";
import { json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { assertCanEditContent, getReadableEntry } from "../lib/entry-access";
import { scopeWrite, effectiveWriteTarget, type WriteContext } from "../lib/scope";
import { captureEntry } from "../capture/entry";
import { appendToEntry, updateEntryContent } from "../capture/store";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import { auditEvent } from "../lib/audit";
import { VOLATILITY_VALUES, withVolatility, type Volatility } from "../memory/volatility";

/**
 * Zod guards the MCP tools; these routes have no schema layer, so an unrecognised value
 * has to be rejected here rather than dropped. Silently ignoring it would hand a caller
 * that sent "Volatile" or "temporary" a 200 and no verdict, with nothing to tell them
 * the field did not take.
 */
/** Where this caller's writes land and who gets stamped on them. */
async function writeContextFor(env: Env, identity: Identity, target?: unknown): Promise<WriteContext> {
  // Precedence lives in effectiveWriteTarget: explicit request value, then the
  // member's own default_share override, then the org's TEAM_DEFAULT_WORKSPACE,
  // then personal. scopeWrite resolves the id from the identity, so no request
  // value can name an arbitrary workspace.
  const orgDefault = (await resolveConfig(env)).TEAM_DEFAULT_WORKSPACE;
  return {
    workspaceId: scopeWrite(identity, effectiveWriteTarget(identity, target, orgDefault)),
    actorId: identity.userId,
  };
}

function readVolatility(raw: unknown): { value?: Volatility; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string" || !(VOLATILITY_VALUES as readonly string[]).includes(raw)) {
    return { error: `volatility must be one of: ${VOLATILITY_VALUES.join(", ")}` };
  }
  return { value: raw as Volatility };
}

export async function handleCaptureRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /capture
  if (url.pathname === "/capture" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { content?: string; tags?: string[]; source?: string; volatility?: unknown; workspace?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }

    const captureVol = readVolatility(body.volatility);
    if (captureVol.error) return json({ ok: false, error: captureVol.error }, 400);

    const captureTags = captureVol.value
      ? withVolatility(body.tags ?? [], captureVol.value)
      : body.tags ?? [];

    const result = await captureEntry(body.content, captureTags, body.source ?? "api", env, ctx, undefined, await writeContextFor(env, identity, body.workspace));

    if (result.status !== "blocked") {
      // Audit at the edge where identity and ctx both live; the domain layer
      // stays free of request state. "stored"/"flagged" are creations, the
      // rest are rewrites of an existing row.
      auditEvent(env, ctx, {
        entryId: result.id,
        actorId: identity.userId,
        event: result.status === "stored" || result.status === "flagged" ? "created" : "updated",
        payload: { captureStatus: result.status },
      });
    }

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
    // Additive: older clients ignore the extra field, and the dashboard uses it
    // to show what was filed under what.
    return json({ ok: true, id: result.id, tags: result.tags ?? [] });
  }

  // POST /append
  if (url.pathname === "/append" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { id?: string; addition?: string; volatility?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!body.addition?.trim()) return json({ ok: false, error: "addition is required" }, 400);

    const appendVol = readVolatility(body.volatility);
    if (appendVol.error) return json({ ok: false, error: appendVol.error }, 400);

    const id = body.id.trim();
    const addition = body.addition.trim();

    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, content, tags, source");
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanEditContent(identity, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    const existingContent = row.content as string;
    const tags: string[] = JSON.parse(row.tags ?? "[]");
    const source = row.source as string;

    if (await isManagedMirror(source, env)) {
      return json({ ok: false, error: mirrorEditError(source) }, 409);
    }

    let indexed: boolean;
    try {
      indexed = await appendToEntry(env, id, existingContent, addition, tags, source, await resolveConfig(env), appendVol.value, await writeContextFor(env, identity));
    } catch (e) {
      return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
    }

    auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "appended" });

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
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: { id?: string; content?: string; volatility?: unknown; tags?: unknown };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

    const updateVol = readVolatility(body.volatility);
    if (updateVol.error) return json({ ok: false, error: updateVol.error }, 400);

    // Absent means "leave the tags alone" — every client but the editor omits the
    // key, and reading a missing key as an empty list would have them all wiping
    // tags on save. An explicit [] does mean the user removed the last one.
    let replaceTags: string[] | undefined;
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some(t => typeof t !== "string")) {
        return json({ ok: false, error: "tags must be an array of strings" }, 400);
      }
      replaceTags = body.tags as string[];
    }

    const id = body.id.trim();
    const newContent = body.content.trim();

    // Refuse before anything is written. Only `source` is needed: updateEntryContent reads
    // the rest for itself, and keeping the mirror guard out here is what stops
    // capture/store.ts having to depend on the integrations registry (see #289).
    const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, source");
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    const denied = assertCanEditContent(identity, row);
    if (denied) return json({ ok: false, error: denied.message }, 403);

    if (await isManagedMirror(row.source as string, env)) {
      return json({ ok: false, error: mirrorEditError(row.source as string) }, 409);
    }

    const result = await updateEntryContent(env, id, newContent, await resolveConfig(env), updateVol.value, replaceTags, await writeContextFor(env, identity));

    // Only reachable if the entry was deleted between the guard read and the write.
    if (result.status === "not_found") {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "updated" });

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
