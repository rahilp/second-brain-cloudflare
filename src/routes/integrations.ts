import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  saveIntegration,
  deleteIntegration,
  integrationStatus,
  narrowMirrorLayer,
} from "../integrations";
import type { IntegrationRecord } from "../integrations";
import type { Env } from "../env";
import { json } from "../lib/http";
import { adminAuditEvent, writeAdminEvent } from "../lib/admin-audit";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { listRoster } from "../lib/team-admin";
import { forgetEntry } from "../capture/lifecycle";
import { getReadableEntry, assertCanMutateEntry } from "../lib/entry-access";
import { makeMirrorStore, mirrorWriteContext } from "../integrations/mirror";
import { moveEntry, restampVectorWorkspace } from "../capture/share";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { VECTORIZE_GET_BY_IDS_BATCH } from "../constants";

// Batch size for POST /integrations/:provider/move. No external fetch on this
// path (unlike a sync batch), so the item-count ceiling is sized for D1 cost
// (2 executions per moved entry) — but per-entry Vectorize cost varies with
// how many chunks an entry has, so the item count alone cannot bound the
// call's total subrequests (see move-subrequest-budget.test.ts, which proved
// a batch of 10 long multi-chunk entries can blow past the free plan's
// ceiling on Vectorize alone). The re-stamp step below additionally bounds
// itself by projected cost, so D1 moves for the whole item-count batch always
// commit, but a re-stamp is only attempted while it still fits the budget —
// skipped entries count toward vectorFailures and repair themselves on a
// later call via moveEntry's no_change branch.
const MOVE_BATCH_SIZE = 10;
// Same ceiling move-subrequest-budget.test.ts and cron-subrequest-budget.test.ts
// both size against — the Workers free plan's per-invocation subrequest limit.
const FREE_PLAN_SUBREQUESTS = 50;

export async function handleIntegrationsRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /integrations — provider list + connection status (never the token)
  if (url.pathname === "/integrations" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const integrations = [];
    for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
      integrations.push(integrationStatus(provider, await loadIntegration(env, provider.id)));
    }
    // Who connected it, as a NAME. Resolved through listRoster, not
    // lookupActorLabels: the id comes out of a KV blob rather than from an
    // already-scoped read, and the roster is the only people-list in this
    // codebase that is scoped to the caller's own teams. A connector who is not
    // the caller's teammate resolves to null and the client omits the line,
    // which is also what a solo brain gets, and what a brain whose connecting
    // admin has since been removed gets.
    //
    // Resolved at read time rather than snapshotted at connect time so a rename
    // propagates and a departure degrades to null instead of to a stale name —
    // the same rule lookupActorLabels's soft-delete filter enforces elsewhere.
    const ids = integrations.map((i) => i.connectedByUserId).filter(Boolean) as string[];
    const roster = ids.length ? await listRoster(env, auth.companyWorkspaceIds) : [];
    const nameOf = new Map(roster.map((r) => [r.userId, r.name]));
    // Whether this caller is the tenant owner — the only identity #347's move
    // route will run for, since mirrored memories live in the owner's
    // workspace. Cheap: ensureTenantBootstrap memoises per DB binding.
    const roots = await ensureTenantBootstrap(env);
    // Read is open to every member; the write actions below are not. The flag
    // lets the dashboard render a member the connection state without also
    // rendering Connect and Disconnect buttons that can only answer 403.
    return json({
      ok: true,
      // connectedByUserId is destructured OUT: the response carries a name or
      // null and never an id, because a member has no use for a colleague's
      // user id and the roster's allowlist argument applies to every
      // people-shaped field this codebase publishes.
      integrations: integrations.map(({ connectedByUserId, ...rest }) => ({
        ...rest,
        connectedBy: connectedByUserId ? nameOf.get(connectedByUserId) ?? null : null,
      })),
      admin: auth.role === "admin",
      owner: auth.userId === roots.ownerUserId,
    });
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
  const integrationRoute = url.pathname.match(/^\/integrations\/([a-z0-9-]+)\/(connect|sync|disconnect|layer|move)$/);
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
      const mirrorWorkspace = narrowMirrorLayer(body.workspace);

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
        // connectedByUserId is written on EVERY connect, reconnects included:
        // the person who last handed the deployment a token is the person to
        // ask about it, so it names the current connector rather than the
        // original one. It lives in `config` beside mirrorWorkspace — the
        // documented escape hatch, carried across reconnects by the spread, and
        // one place to look for connection policy.
        config: { ...(existing?.config ?? {}), mirrorWorkspace, connectedByUserId: auth.userId },
        status: "connected",
        workspaceName,
        lastSyncedAt: existing?.lastSyncedAt ?? null,
        lastSyncError: null,
        itemMap: existing?.itemMap ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveIntegration(env, record);
      // The trail, not the blob. `connectedByUserId` above answers "who
      // connected the thing that is connected NOW" and is overwritten by the
      // next reconnect; it cannot answer "who connected it in March and who
      // disconnected it in April". `mirrorWorkspace` is in the payload because
      // where a connector's content lands is the visibility decision the
      // connect makes. The token is not, and nothing that is or contains a
      // credential ever will be — the rule member_token_rotated set.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        event: "integration_connected",
        // provider.id, not `provider`: the local is the registry OBJECT here,
        // and JSON.stringify of it would put the provider's display name and
        // category in the trail instead of the id an auditor filters on.
        payload: { provider: provider.id, mirrorWorkspace },
      });
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

    // layer — move where FUTURE syncs land, without touching the token or
    // anything already mirrored (moving those is #347). No token needed, so
    // this is the route that replaces the disconnect+reconnect dance.
    if (action === "layer") {
      // Body first, THEN the record — right before the save — so the
      // read-to-write window is one KV round-trip. A slow POST that read the
      // record before its body arrived would hold a pre-sync snapshot open;
      // a saveIntegration landing in that gap (Notion re-mirroring pages
      // under new ids, or email's checkpoint/ingestedIds) would get written
      // back over here. Same discipline advanceRotationCursor already
      // follows in src/integrations/mirror.ts. The 404 below doesn't depend
      // on the body, so parsing it first costs nothing.
      let body: { workspace?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const record = await loadIntegration(env, provider.id);
      if (!record) {
        return json({ ok: false, error: `${provider.name} is not connected` }, 404);
      }
      // Same narrowing on the way in as connect uses, and the same narrowing
      // applied to the STORED value before comparing — a malformed config
      // blob must not look like a change (or a non-change) that it isn't.
      const next = narrowMirrorLayer(body.workspace);
      const current = narrowMirrorLayer(record.config?.mirrorWorkspace);
      if (next === current) {
        return json({ ok: true, provider: provider.id, mirrorWorkspace: current, changed: false });
      }
      await saveIntegration(env, {
        ...record,
        config: { ...record.config, mirrorWorkspace: next },
        updatedAt: Date.now(),
      });
      // Own event name, not integration_connected with a boolean — the
      // member_suspended/member_unsuspended precedent (see disconnect below).
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        event: "integration_layer_changed",
        payload: { provider: provider.id, from: current, to: next },
      });
      return json({ ok: true, provider: provider.id, mirrorWorkspace: next, changed: true });
    }

    // move — walk a connection's itemMap, moving already-mirrored memories
    // into the connection's CURRENT layer (never a request parameter — the
    // same narrowMirrorLayer read the layer route itself uses, so this can
    // never disagree with what a future sync will write).
    //
    // Owner only, no impersonation (#347 locked decision 1). Mirrored rows
    // live in the tenant owner's workspace, so moveEntry's own scoped SELECT —
    // run against a non-owner admin's identity — would silently match nothing
    // and report "moved 0" as if it had succeeded. Refusing here, before any
    // work, is what tells the caller the truth instead. This is why the
    // refusal response below carries none of the count fields: a completed
    // zero-item move and a refused attempt must not look alike.
    if (action === "move") {
      let body: { cursor?: string; expectedTarget?: string } = {};
      try { body = await request.json(); } catch { /* empty body — start from the beginning */ }

      const roots = await ensureTenantBootstrap(env);
      if (auth.userId !== roots.ownerUserId) {
        return json(
          { ok: false, error: "Only the brain's owner can move memories this connection already synced — they live in the owner's own workspace." },
          403,
        );
      }

      const record = await loadIntegration(env, provider.id);
      if (!record) return json({ ok: false, error: `${provider.name} is not connected` }, 404);

      const target = narrowMirrorLayer(record.config?.mirrorWorkspace);

      // The client captures the layer it showed the user at confirmation time
      // and sends it on every page of the drain (#347 review item 5) — if it
      // disagrees with the connection's CURRENT layer, the layer changed
      // mid-drain and this page must not silently move into the new target.
      // Nothing moves for this page; the caller must re-confirm.
      if (body.expectedTarget && body.expectedTarget !== target) {
        return json(
          { ok: false, error: "The layer changed since this move was confirmed — reconfirm to continue." },
          409,
        );
      }

      // Stateless cursor: no progress is ever written back to the integration
      // record (#348 is about that record's own writers; this feature adds no
      // new one). The cursor is resolved by POSITION in the itemMap's own
      // sorted keys, not Array.indexOf — a key deleted by a concurrent sync
      // must resume after where it WAS, not restart the whole drain at 0.
      const keys = Object.keys(record.itemMap).sort();
      let startIndex = 0;
      if (body.cursor) {
        const idx = keys.findIndex((k) => k > body.cursor!);
        startIndex = idx === -1 ? keys.length : idx;
      }
      const batchKeys = keys.slice(startIndex, startIndex + MOVE_BATCH_SIZE);

      // moveEntry (src/capture/share.ts) is reused as-is — no new SQL. It runs
      // with the CALLER's identity, which by this point is confirmed to be the
      // owner, so its scoped SELECT sees exactly the workspaces mirrored
      // memories actually live in.
      let moved = 0;
      let alreadyThere = 0;
      let missing = 0;
      let refused = 0;
      let errored = 0;
      // D1 executions already spent this call: the roots lookup above, plus
      // one per moveEntry SELECT and one more for each that actually wrote.
      let d1Spent = 1;
      const toRestamp: { vectorIds: string[]; workspaceId: string }[] = [];
      for (const key of batchKeys) {
        const mapped = record.itemMap[key];
        try {
          const result = await moveEntry(mapped.entryId, target, env, auth);
          d1Spent += 1;
          switch (result.status) {
            case "shared":
            case "unshared":
              moved++;
              d1Spent += 1;
              toRestamp.push({ vectorIds: result.vectorIds, workspaceId: result.workspaceId });
              break;
            case "no_change":
              // Carries vectorIds/workspaceId too (share.ts) so a re-run over
              // an already-moved entry can still repair a stale Vectorize
              // stamp left by a previous failed/skipped re-stamp.
              alreadyThere++;
              toRestamp.push({ vectorIds: result.vectorIds, workspaceId: result.workspaceId });
              break;
            case "not_found":
              // A stale itemMap pointer (deleted elsewhere) or an entry outside
              // the owner's own readable set — either way, not a move, and not
              // a reason to abort the rest of the batch.
              missing++;
              break;
            case "forbidden":
              refused++;
              break;
          }
        } catch (e) {
          // Same per-item catch precedent as the purge loop below: one row's
          // D1 hiccup must not lose the rest of the batch or 500 the request.
          console.error("moveEntry threw for", mapped.entryId, e);
          errored++;
          d1Spent += 1;
        }
      }

      // Awaited, not deferred into ctx.waitUntil the way /share does it — the
      // response must not claim a move that scoped recall cannot see yet.
      // Bounded by projected cost, not just item count: per-entry Vectorize
      // cost varies with how many chunks an entry has, so a fixed batch size
      // alone cannot guarantee the free-plan subrequest ceiling. Once
      // attempting the next entry's re-stamp would exceed it, that entry (and
      // any not yet attempted) is left un-restamped, counted as a vector
      // failure rather than attempted — self-healing on the next call, since
      // no_change now also carries vectorIds/workspaceId.
      // Reserve one execution for the audit write below, which always runs
      // regardless of restamp outcome.
      const d1Reserved = d1Spent + 1;
      let vectorizeSpent = 0;
      let vectorFailures = 0;
      for (const entry of toRestamp) {
        if (!entry.vectorIds.length) continue;
        const chunks = Math.ceil(entry.vectorIds.length / VECTORIZE_GET_BY_IDS_BATCH);
        const projectedCost = chunks * 2; // one getByIds + one upsert per chunk
        if (d1Reserved + vectorizeSpent + projectedCost > FREE_PLAN_SUBREQUESTS) {
          vectorFailures++;
          continue;
        }
        vectorizeSpent += projectedCost;
        const restamp = await restampVectorWorkspace(env, entry.vectorIds, entry.workspaceId);
        if (!restamp.ok) vectorFailures++;
      }

      const processedThrough = startIndex + batchKeys.length;
      const remaining = keys.length - processedThrough;
      const cursor = remaining > 0 && batchKeys.length > 0 ? batchKeys[batchKeys.length - 1] : null;

      // Its own try/catch: an audit-write failure must never turn an
      // already-committed move into a 500. Awaited (not adminAuditEvent's
      // fire-and-forget ctx.waitUntil) so the row is committed before the
      // response returns when it succeeds — the same "don't claim what
      // hasn't landed yet" reasoning as the vector re-stamp above — but a
      // failure here is non-fatal to the response.
      try {
        await writeAdminEvent(env, {
          actorId: auth.userId,
          event: "integration_memories_moved",
          payload: { provider: provider.id, target, moved, alreadyThere, missing, refused },
        });
      } catch (e) {
        console.error("admin_events insert failed for integration_memories_moved (non-fatal):", e);
      }

      return json({
        ok: true,
        provider: provider.id,
        target,
        moved,
        alreadyThere,
        missing,
        refused,
        errored,
        vectorFailures,
        remaining,
        cursor,
      });
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
    // A separate name rather than integration_connected with a boolean, for the
    // reason member_suspended/member_unsuspended already gives: an auditor
    // scanning for "when did this stop mirroring" should not have to read a
    // payload to find out.
    adminAuditEvent(env, ctx, {
      actorId: auth.userId,
      event: "integration_disconnected",
      payload: { provider: provider.id },
    });
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
