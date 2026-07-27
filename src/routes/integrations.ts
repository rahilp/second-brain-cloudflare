import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  saveIntegration,
  deleteIntegration,
  integrationStatus,
} from "../integrations";
import type { IntegrationRecord } from "../integrations";
import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import { forgetEntry } from "../capture/lifecycle";
import { makeMirrorStore } from "../integrations/mirror";

export async function handleIntegrationsRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /integrations — provider list + connection status (never the token)
  if (url.pathname === "/integrations" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const integrations = [];
    for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
      integrations.push(integrationStatus(provider, await loadIntegration(env, provider.id)));
    }
    return json({ ok: true, integrations });
  }

  // POST /integrations/:provider/(connect|sync|disconnect)
  const integrationRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/(connect|sync|disconnect)$/);
  if (integrationRoute && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const provider = getProvider(integrationRoute[1]);
    if (!provider) return json({ ok: false, error: `Unknown integration: ${integrationRoute[1]}` }, 404);
    const action = integrationRoute[2];

    // connect — validate the pasted token against the provider's API
    // (server-side; the browser can't for CORS reasons) and store it only if
    // it works.
    if (action === "connect") {
      let body: { token?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const token = body.token?.trim();
      if (!token) return json({ ok: false, error: "token is required" }, 400);

      let workspaceName: string;
      try {
        workspaceName = await provider.validateToken(token);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }

      // Preserve the item map across reconnects so already-mirrored items
      // update in place instead of duplicating.
      const existing = await loadIntegration(env, provider.id);
      const now = Date.now();
      const record: IntegrationRecord = {
        provider: provider.id,
        authKind: "token",
        credentials: { token },
        config: existing?.config ?? {},
        status: "connected",
        workspaceName,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      return json({ ok: true, provider: provider.id, workspaceName });
    }

    // sync — one bounded batch; callers loop while `remaining` > 0 (same
    // pattern as POST /vectorize-pending).
    if (action === "sync") {
      if (!(await loadIntegration(env, provider.id))) {
        return json({ ok: false, error: `${provider.name} is not connected` }, 404);
      }
      const result = await provider.sync(env, makeMirrorStore(env));
      return json(result, result.ok ? 200 : 502);
    }

    // disconnect — remove the connection. Mirrored memories are kept
    // (they're the user's data) unless purge=true.
    let body: { purge?: boolean } = {};
    try { body = await request.json(); } catch { /* empty body — keep memories */ }
    const record = await loadIntegration(env, provider.id);
    if (!record) return json({ ok: false, error: `${provider.name} is not connected` }, 404);

    let purged = 0;
    if (body.purge) {
      for (const mapped of Object.values(record.itemMap)) {
        try {
          const r = await forgetEntry(mapped.entryId, env);
          if (r.status === "deleted") purged++;
        } catch (e) {
          console.error("Mirror purge failed (non-fatal):", e);
        }
      }
    }
    await deleteIntegration(env, provider.id);
    return json({ ok: true, purged, kept: body.purge ? 0 : Object.keys(record.itemMap).length });
  }

  return null;
}
