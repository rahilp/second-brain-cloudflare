import type { Env } from "../env";
import { intParam, json, readWorkspaceParam } from "../lib/http";
import { getReadableEntry } from "../lib/entry-access";
import { requireIdentity } from "../lib/identity";
import { createEdge, deleteEdge, isValidEdgeType, CROSS_WORKSPACE_LINK_MESSAGE } from "../graph/edges";
import { EDGE_TYPES } from "../graph/types";
import { buildGraph, getConnections } from "../graph/traverse";
import { resolveConfig } from "../config";

export async function handleGraphRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // POST /link — create an explicit edge between two memories, mirrors the MCP `link` tool
  if (url.pathname === "/link" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { source_id?: string; target_id?: string; type?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const sourceId = body.source_id?.trim();
    const targetId = body.target_id?.trim();
    if (!sourceId || !targetId) return json({ ok: false, error: "source_id and target_id are required" }, 400);
    const type = body.type?.trim() || "relates_to";
    if (!isValidEdgeType(type)) {
      return json({ ok: false, error: `type must be one of: ${Object.keys(EDGE_TYPES).join(", ")}` }, 400);
    }
    if (sourceId === targetId) return json({ ok: false, error: "Cannot link an entry to itself" }, 400);

    const source = await getReadableEntry(env, auth, sourceId);
    if (!source) return json({ ok: false, error: `No entry found with ID: ${sourceId}` }, 404);
    const target = await getReadableEntry(env, auth, targetId);
    if (!target) return json({ ok: false, error: `No entry found with ID: ${targetId}` }, 404);
    // Same-workspace only. edges.workspace_id is one denormalized column copied
    // from the source entry, and a share re-stamps it to follow the entry that
    // moved — so an edge whose endpoints started in different workspaces has no
    // correct value at all, and is guaranteed to go inconsistent rather than
    // merely unusual. Refusing here
    // gives an instruction the user can act on instead of a link that silently
    // vanishes from their graph. Costs nothing on a solo brain: one workspace.
    if (source.workspace_id !== target.workspace_id) {
      return json({ ok: false, error: CROSS_WORKSPACE_LINK_MESSAGE, code: "cross_workspace_link" }, 400);
    }

    const edge = await createEdge(sourceId, targetId, type, { provenance: "explicit", weight: 1.0, workspaceId: source.workspace_id }, env);
    if (!edge) return json({ ok: false, error: "Cannot link an entry to itself" }, 400);
    return json({ ok: true, source_id: edge.source_id, target_id: edge.target_id, type: edge.type });
  }

  // POST /unlink — remove a relationship link, mirrors the MCP `unlink` tool.
  // POST rather than DELETE /link: CORS_HEADERS allow only GET/POST/OPTIONS and
  // every sibling mutation route is POST.
  if (url.pathname === "/unlink" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { source_id?: string; target_id?: string; type?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const sourceId = body.source_id?.trim();
    const targetId = body.target_id?.trim();
    if (!sourceId || !targetId) return json({ ok: false, error: "source_id and target_id are required" }, 400);
    const type = body.type?.trim() || undefined;
    if (type && !isValidEdgeType(type)) {
      return json({ ok: false, error: `type must be one of: ${Object.keys(EDGE_TYPES).join(", ")}` }, 400);
    }

    const source = await getReadableEntry(env, auth, sourceId);
    if (!source) return json({ ok: false, error: `No entry found with ID: ${sourceId}` }, 404);
    const target = await getReadableEntry(env, auth, targetId);
    if (!target) return json({ ok: false, error: `No entry found with ID: ${targetId}` }, 404);

    const deleted = await deleteEdge(sourceId, targetId, type, env);
    return json({ ok: true, deleted });
  }

  // GET /connections — 1-hop neighbors of an entry, mirrors the MCP `connections` tool
  if (url.pathname === "/connections" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const id = url.searchParams.get("id")?.trim();
    if (!id) return json({ ok: false, error: "id is required" }, 400);
    const type = url.searchParams.get("type")?.trim() || undefined;

    const connections = await getConnections(id, type, env, await resolveConfig(env), auth);
    return json({ ok: true, id, connections });
  }

  // GET /graph — node+edge subgraph for the dashboard graph view (dashboard-only;
  // no MCP twin — this is visualization data, not an agent capability)
  if (url.pathname === "/graph" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const seed = url.searchParams.get("seed")?.trim() || undefined;
    // Omitted still means the whole graph, up to buildGraph's own ceiling. The
    // floor of 1 is what stops `?limit=0` and `?limit=-1` from meaning that too.
    const limit = intParam(url, "limit", { min: 1 });
    if (limit instanceof Response) return limit;
    // Same layer filter, same 400, as /list and /recall — it can only ever
    // narrow the caller's readable set, never name a workspace outside it.
    const workspace = readWorkspaceParam(url);
    if (workspace instanceof Response) return workspace;

    const { nodes, edges } = await buildGraph({ seed, limit, only: workspace }, env, await resolveConfig(env), auth);
    return json({ ok: true, nodes, edges });
  }

  return null;
}
