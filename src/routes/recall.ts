import type { Env } from "../env";
import { resolveConfig } from "../config";
import { LLM_MODEL, VECTORIZE_FIX_HINT } from "../constants";
import { buildEntryFilterQuery } from "../capture/entry";
import { compressTag } from "../compression/digest";
import { CORS_HEADERS, intParam, json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { scopeWhere } from "../lib/scope";
import { lookupActorLabels, resolveActorLabel } from "../lib/actors";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { recallEntries } from "../recall/search";
import { allowanceFor, snippetOf } from "../recall/snippet";

/**
 * buildEntryFilterQuery always ends `ORDER BY created_at DESC LIMIT ?`, so the
 * caller's readable-workspace clause goes in ahead of the ORDER BY and its two
 * bindings splice in ahead of LIMIT's. Without a filter there is no WHERE to
 * join onto, so the clause arrives as one instead.
 */
function scopeEntryFilterQuery(
  identity: Identity,
  q: { sql: string; bindings: unknown[] },
  only?: "personal" | "company",
): { sql: string; bindings: unknown[] } {
  const scope = scopeWhere(identity, only);
  const sql = q.sql.includes("WHERE")
    ? q.sql.replace(" ORDER BY", ` AND ${scope.clause} ORDER BY`)
    : q.sql.replace(" ORDER BY", ` WHERE ${scope.clause} ORDER BY`);
  return { sql, bindings: [...q.bindings.slice(0, -1), ...scope.bindings, ...q.bindings.slice(-1)] };
}

/**
 * The ?workspace= layer filter shared by /list and /recall. Only narrows the
 * caller's readable set — "personal" and "company" both resolve from the
 * identity, so a caller can never name a workspace it does not belong to.
 */
function readWorkspaceParam(url: URL): "personal" | "company" | undefined | Response {
  const raw = url.searchParams.get("workspace")?.trim();
  if (!raw) return undefined;
  if (raw !== "personal" && raw !== "company") {
    return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
  }
  return raw;
}

export async function handleRecallRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /list
  if (url.pathname === "/list" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;
    // Floor of 0 as well as the cap: SQLite reads a negative LIMIT as no limit
    // at all, so `?n=-1` used to return the whole entries table.
    const n = intParam(url, "n", { fallback: 20, min: 0, max: 100 });
    if (n instanceof Response) return n;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = intParam(url, "after");
    if (after instanceof Response) return after;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;

    const { sql, bindings } = scopeEntryFilterQuery(identity, buildEntryFilterQuery({ n, tag, after, before }), workspace);
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    const rows = results as Record<string, unknown>[];
    // Each row reports its layer so the dashboard can badge cards and offer
    // share/unshare without knowing the caller's workspace ids itself.
    const layerOf = (wid: unknown): string =>
      wid === identity.personalWorkspaceId ? "personal"
      : wid === identity.companyWorkspaceId ? "company"
      : "system";
    const companyRows = rows.filter((r) => layerOf(r.workspace_id) === "company");
    const labelMap = await lookupActorLabels(
      env,
      companyRows.map((r) => String(r.actor_id ?? "")),
    );
    return json(rows.map((r) => {
      const layer = layerOf(r.workspace_id);
      const out: Record<string, unknown> = { ...r, workspace: layer };
      if (layer === "company") {
        out.actor_name = resolveActorLabel(String(r.actor_id ?? ""), labelMap, {
          viewerId: identity.userId,
          source: String(r.source ?? ""),
        });
      }
      return out;
    }));
  }

  // GET /recall — semantic search, mirrors the MCP `recall` tool
  if (url.pathname === "/recall" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    const query = url.searchParams.get("query")?.trim();
    if (!query) return json({ ok: false, error: "query is required" }, 400);

    const topK = intParam(url, "topK", { fallback: 5, min: 1, max: 20 });
    if (topK instanceof Response) return topK;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = intParam(url, "after");
    if (after instanceof Response) return after;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;
    const kindParam = url.searchParams.get("kind")?.trim();
    const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;
    const hops = intParam(url, "hops", { fallback: 0, min: 0, max: 3 });
    if (hops instanceof Response) return hops;
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;
    // Long memories are shortened by default so API/CLI consumers get a bounded
    // payload. Renderers that show the whole memory (the dashboard) pass full=1.
    const full = ["1", "true", "yes"].includes((url.searchParams.get("full") ?? "").toLowerCase());

    const cfg = await resolveConfig(env);
    const { matches, insight, semanticUnavailable, queryUsed, queryTokens, compoundStale } = await recallEntries({ query, topK, tag, after, before, kind, hops }, env, ctx, cfg, { identity, workspaceFilter: workspace });

    if (!matches.length) {
      return json({
        ok: true,
        results: [],
        query_used: queryUsed,
        semantic_unavailable: semanticUnavailable,
        message: semanticUnavailable
          ? `Semantic search unavailable (Vectorize index missing). Fix: ${VECTORIZE_FIX_HINT}.`
          : "Nothing found matching that query.",
      });
    }

    return json({
      ok: true,
      query_used: queryUsed,
      compound_stale: compoundStale ?? null,
      results: matches.map((m, i) => {
        const s = full
          ? { text: m.content, truncated: false, fullLength: (m.content ?? "").length }
          : snippetOf(m.content, allowanceFor(i, m.score, cfg), { queryTokens });
        return {
          id: m.id,
          content: s.text,
          truncated: s.truncated,
          full_length: s.fullLength,
          score: parseFloat((m.score * 100).toFixed(1)),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated_at: m.updatedAt,
          stale_as_of: m.staleAsOf,
          updated: m.isUpdate,
          hop: m.hop,
          workspace: m.workspace ?? null,
          actor_name: m.workspace === "company" ? (m.actorName ?? null) : null,
          via_provenance: m.viaProvenance ?? null,
          via_type: m.viaType ?? null,
          linked_at: m.viaLinkedAt ?? null,
          related_to: m.viaFrom ?? null,
        };
      }),
      insight: insight || null,
      semantic_unavailable: semanticUnavailable,
    });
  }

  // POST /chat
  if (url.pathname === "/chat" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { query?: string; memories?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.query?.trim()) return json({ ok: false, error: "query is required" }, 400);

    // The memories arrive numbered, dated and attributed (see the client's
    // serializer in public/js/recall.js and the MCP tool's mirror of it), so
    // the model has everything it needs to be specific — it just has to be
    // asked. The previous prompt ended "Be concise", and on a brain holding
    // three days of dense decisions "What did I decide recently?" came back as
    // one sentence about an unrelated email: the top match, summarised, with
    // the other four sources ignored.
    const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided.

Draw on every memory that bears on the question, not only the closest match — a question about decisions or plans usually has several answers, and reporting one of them is a wrong answer.

Anchor claims in time. The memories are dated; say "On 12 March you decided…" rather than "you decided…". If two memories disagree, say so and lead with the more recent one.

When the answer has several parts, give them as short bullets rather than one crowded sentence.

Cite as you go with the memory's number in square brackets, like [2], matching the numbered list you were given. Cite every claim.

Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories.

Be specific and complete. Concision means leaving out filler, never leaving out facts.`;

    const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;
    const cfg = await resolveConfig(env);

    // Workers AI requires `as any` here — the SDK types don't cover all models
    const stream = await env.AI.run(cfg.LLM_MODEL as any, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      stream: true,
    });

    return new Response(stream as ReadableStream, {
      headers: { "Content-Type": "text/event-stream", ...CORS_HEADERS },
    });
  }

  // GET /digest
  if (url.pathname === "/digest" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const tag = url.searchParams.get("tag")?.trim();
    if (!tag) return json({ ok: false, error: "tag parameter is required" }, 400);

    const result = await compressTag(tag, env, ctx);

    if (!result.synthesizedId) {
      return json({ tag, error: "Could not create digest — tag may have fewer than 20 entries or was recently compressed", source_count: result.entriesUsed });
    }

    return json({ tag, synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
  }

  return null;
}
