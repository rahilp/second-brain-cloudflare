import type { Env } from "../env";
import { LLM_MODEL, VECTORIZE_FIX_HINT } from "../constants";
import { CORS_HEADERS, json, requireAuth } from "../lib/http";
import { buildEntryFilterQuery } from "../capture/entry";
import { compressTag } from "../compression/digest";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { recallEntries } from "../recall/search";

export async function handleRecallRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /list
  if (url.pathname === "/list" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const n = Math.min(parseInt(url.searchParams.get("n") ?? "20", 10), 100);
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
    const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;

    const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before });
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    return json(results);
  }

  // GET /recall — semantic search, mirrors the MCP `recall` tool
  if (url.pathname === "/recall" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const query = url.searchParams.get("query")?.trim();
    if (!query) return json({ ok: false, error: "query is required" }, 400);

    const topK = Math.min(Math.max(parseInt(url.searchParams.get("topK") ?? "5", 10), 1), 20);
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
    const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;
    const kindParam = url.searchParams.get("kind")?.trim();
    const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;
    const hops = Math.min(Math.max(parseInt(url.searchParams.get("hops") ?? "0", 10), 0), 3);

    const { matches, insight, semanticUnavailable, queryUsed } = await recallEntries({ query, topK, tag, after, before, kind, hops }, env, ctx);

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
      results: matches.map(m => ({
        id: m.id,
        content: m.content,
        score: parseFloat((m.score * 100).toFixed(1)),
        tags: m.tags,
        source: m.source,
        created_at: m.createdAt,
        updated: m.isUpdate,
        hop: m.hop,
      })),
      insight: insight || null,
      semantic_unavailable: semanticUnavailable,
    });
  }

  // POST /chat
  if (url.pathname === "/chat" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { query?: string; memories?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.query?.trim()) return json({ ok: false, error: "query is required" }, 400);

    const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided. Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories. Be concise.`;

    const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;

    // Workers AI requires `as any` here — the SDK types don't cover all models
    const stream = await env.AI.run(LLM_MODEL as any, {
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
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
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
