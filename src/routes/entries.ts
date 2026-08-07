import type { Env } from "../env";
import { importExportPayload, parseImportBody, parseImportLimit, parseImportOffset } from "../entries/import";
import { initializeDatabase } from "../db/init";
import { json, requireAuth } from "../lib/http";
import { forgetEntry } from "../capture/lifecycle";
import { applyStatus } from "../capture/lifecycle";
import { STATUS_VALUES, type MemoryStatus } from "../memory/status";
import { getTagVocabulary } from "../tags/vocabulary";

export async function handleEntriesRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /count
  if (url.pathname === "/count" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const row = await env.DB.prepare(`SELECT COUNT(*) as count FROM entries`).first() as Record<string, any> | null;
    return json({ count: (row?.count as number) ?? 0 });
  }

  // GET /tags — the dashboard's filter dropdown, refetched on every page load.
  // Reads the same cache recall does (#288): the scan behind it costs 180,000 rows
  // on a 20,000-entry brain, and nothing here is worth that per navigation. Unlike
  // recall this route has no useful degraded answer, so a cold cache is scanned
  // inline rather than answered empty — see getTagVocabulary.
  if (url.pathname === "/tags" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    return json(await getTagVocabulary(env, ctx));
  }

  // GET /export — complete backup: every entry plus the edges table. Single
  // unbounded SELECTs are acceptable here: D1 handles tens of thousands of rows in
  // one read and this route runs on explicit user action only. If response size
  // ever becomes a problem, add ?after= cursor support then, not now.
  if (url.pathname === "/export" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const { results: entryRows } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries ORDER BY created_at DESC`
    ).all() as { results: Record<string, any>[] };
    const { results: edgeRows } = await env.DB.prepare(
      `SELECT source_id, target_id, type, weight, provenance, created_at FROM edges`
    ).all() as { results: Record<string, any>[] };

    // vector_ids are deliberately excluded — they're deployment-specific and an
    // import tool re-embeds anyway. Tags are parsed so the file holds real arrays.
    const entries = entryRows.map(r => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tags ?? "[]"),
      source: r.source,
      created_at: r.created_at,
      recall_count: r.recall_count ?? 0,
      importance_score: r.importance_score ?? 0,
      contradiction_wins: r.contradiction_wins ?? 0,
      contradiction_losses: r.contradiction_losses ?? 0,
    }));
    const edges = edgeRows.map(r => ({
      source_id: r.source_id,
      target_id: r.target_id,
      type: r.type,
      weight: r.weight,
      provenance: r.provenance,
      created_at: r.created_at,
    }));
    return json({ ok: true, exported_at: Date.now(), version: 2, entries, edges });
  }

  // POST /import — round-trip counterpart to GET /export (issue #217). Inserts by
  // export id (skip if exists), preserves created_at/updated_at/tags/source, defers
  // embedding via vector_ids=[] so POST /vectorize-pending can backfill without
  // burning the Workers AI quota in one request. Does NOT go through /capture.
  //
  // Paged positionally: one call examines entries[offset .. offset+limit), then —
  // once entries are exhausted — edges[edge_offset .. edge_offset+limit). Clients
  // resend the same file with the next_offset/next_edge_offset from the previous
  // response until both remaining counts are 0. See importExportPayload for why
  // this is what keeps a large restore inside the D1 free-plan query budget.
  if (url.pathname === "/import" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    // Awaited, not left to ensureDbReady's waitUntil: an import is often a freshly
    // deployed brain's first request, which is exactly when the schema ALTERs have
    // not run yet and every insert would fail on a missing column. Latched after
    // the first call, so this costs nothing in the steady state.
    await initializeDatabase(env);

    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const parsed = parseImportBody(body);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

    const limit = parseImportLimit(url.searchParams.get("limit"));
    const offset = parseImportOffset(url.searchParams.get("offset"));
    const edgeOffset = parseImportOffset(url.searchParams.get("edge_offset"));
    const summary = await importExportPayload(env, parsed.payload, { limit, offset, edgeOffset });
    return json(summary);
  }

  // POST /forget — delete-by-id, mirrors the MCP `forget` tool
  if (url.pathname === "/forget" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

    const id = body.id.trim();
    const result = await forgetEntry(id, env);

    if (result.status === "not_found") {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    return json({ ok: true, id, deletedVectors: result.vectorCount });
  }

  // GET /entry — one full row by id, for the dashboard graph view's tap-to-open
  // (/graph ships 80-char labels only; fattening it with full content would bloat
  // every graph load to serve a per-tap need). Dashboard-only, no MCP twin.
  if (url.pathname === "/entry" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const id = url.searchParams.get("id")?.trim();
    if (!id) return json({ ok: false, error: "id is required" }, 400);

    const row = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;
    if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

    return json({
      ok: true,
      entry: {
        id: row.id,
        content: row.content,
        tags: JSON.parse(row.tags ?? "[]"),
        source: row.source,
        created_at: row.created_at,
      },
    });
  }

  // POST /status — set lifecycle status, mirrors the MCP `set_status` tool
  if (url.pathname === "/status" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { id?: string; status?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (!(STATUS_VALUES as readonly string[]).includes(body.status ?? "")) {
      return json({ ok: false, error: `status must be one of: ${STATUS_VALUES.join(", ")}` }, 400);
    }

    const id = body.id.trim();
    const status = body.status as MemoryStatus;
    const ok = await applyStatus(id, status, env);

    if (!ok) {
      return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
    }

    return json({ ok: true, id, status });
  }

  return null;
}
