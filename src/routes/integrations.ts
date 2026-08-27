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
import { json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { forgetEntry } from "../capture/lifecycle";
import { getReadableEntry, assertCanMutateEntry } from "../lib/entry-access";
import { makeMirrorStore, mirrorWriteContext } from "../integrations/mirror";

export async function handleIntegrationsRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /integrations — provider list + connection status (never the token)
  if (url.pathname === "/integrations" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const integrations = [];
    for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
      integrations.push(integrationStatus(provider, await loadIntegration(env, provider.id)));
    }
    // Read is open to every member; the write actions below are not. The flag
    // lets the dashboard render a member the connection state without also
    // rendering Connect and Disconnect buttons that can only answer 403.
    return json({ ok: true, integrations, admin: auth.role === "admin" });
  }

  // POST /integrations/:provider/(connect|sync|disconnect)
  //
  // Admin-only, because an integration is one connection for the whole
  // deployment: `integrations:<provider>` is a single KV blob, so "connect" is
  // not a member adding their own Notion but a member REPLACING the org's, token
  // and all, with nothing in the response to either party saying so. Disconnect
  // removed it for everyone. Read stays open below — a member can see what is
  // connected and when it last synced, just not change it.
  //
  // If per-member connections land later, this gate is what comes off, together
  // with the storage key. test/integration/integrations-tenancy.test.ts pins the
  // current contract either way.
  const integrationRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/(connect|sync|disconnect)$/);
  if (integrationRoute && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const provider = getProvider(integrationRoute[1]);
    if (!provider) return json({ ok: false, error: `Unknown integration: ${integrationRoute[1]}` }, 404);
    const action = integrationRoute[2];

    // connect — validate the pasted token against the provider's API
    // (server-side; the browser can't for CORS reasons) and store it only if
    // it works.
    if (action === "connect") {
      let body: { token?: string; workspace?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const token = body.token?.trim();
      if (!token) return json({ ok: false, error: "token is required" }, 400);
      const mirrorWorkspace = body.workspace === "company" ? "company" : "personal";

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
        config: { ...(existing?.config ?? {}), mirrorWorkspace },
        status: "connected",
        workspaceName,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      return json({ ok: true, provider: provider.id, workspaceName, mirrorWorkspace });
    }

    // sync — one bounded batch; callers loop while `remaining` > 0 (same
    // pattern as POST /vectorize-pending).
    if (action === "sync") {
      const record = await loadIntegration(env, provider.id);
      if (!record) {
        return json({ ok: false, error: `${provider.name} is not connected` }, 404);
      }
      // The same context the nightly cron uses. Built from the caller before,
      // which meant one connection mirrored into different workspaces depending
      // on who pressed "Sync now" — so a page synced by hand and the same page
      // synced overnight landed in two different people's private space.
      const result = await provider.sync(
        env,
        makeMirrorStore(env, await mirrorWriteContext(env, record)),
      );
      return json(result, result.ok ? 200 : 502);
    }

    // disconnect — remove the connection. Mirrored memories are kept
    // (they're the user's data) unless purge=true.
    let body: { purge?: boolean } = {};
    try { body = await request.json(); } catch { /* empty body — keep memories */ }
    const record = await loadIntegration(env, provider.id);
    if (!record) return json({ ok: false, error: `${provider.name} is not connected` }, 404);

    let purged = 0;
    let skipped = 0;
    if (body.purge) {
      for (const mapped of Object.values(record.itemMap)) {
        try {
          // Same guard /forget applies, for the same reason. `forgetEntry` deletes
          // by id with no workspace clause, and the integration record is one
          // deployment-wide blob every member can reach, so an unguarded purge let
          // any member delete mirrored rows out of a colleague's private workspace —
          // rows they could not read through /entry, edit through /update, or delete
          // through /forget. A purge now removes only what this caller could have
          // deleted one at a time; anything else is left standing and counted.
          const row = await getReadableEntry(env, auth, mapped.entryId);
          if (!row || assertCanMutateEntry(auth, row)) { skipped++; continue; }
          const r = await forgetEntry(mapped.entryId, env);
          if (r.status === "deleted") purged++;
        } catch (e) {
          console.error("Mirror purge failed (non-fatal):", e);
        }
      }
    }
    await deleteIntegration(env, provider.id);
    // `kept` counts what is deliberately left behind: everything, when no purge was
    // asked for, plus anything a purge was not allowed to touch.
    return json({
      ok: true,
      purged,
      kept: body.purge ? skipped : Object.keys(record.itemMap).length,
    });
  }

  return null;
}
