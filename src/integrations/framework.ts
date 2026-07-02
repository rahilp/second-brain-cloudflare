/**
 * Second Brain — integration framework.
 *
 * Provider-agnostic machinery for mirroring external sources into memory.
 * Each provider (src/integrations/<provider>.ts) supplies an
 * IntegrationProvider; the registry in src/integrations/index.ts wires them
 * together so the Worker's routes, cron, and settings UI never hardcode a
 * provider.
 *
 * Design notes:
 * - All integration state (token, account info, item↔entry map) lives in
 *   OAUTH_KV under `integrations:<provider>` — one JSON blob per provider. KV
 *   is deliberate: the namespace is already provisioned in every deployment,
 *   so shipping a provider is a pure code deploy with no schema migration, and
 *   the access pattern (read once at sync start, write once at the end) is
 *   exactly what KV wants.
 * - Synced items are MIRRORS: the external tool is the source of truth. Every
 *   sync replaces a mirrored entry's content wholesale, dedupe is by external
 *   item id (the itemMap), and an item that disappears upstream deletes its
 *   mirror. Mirrors therefore bypass captureEntry's duplicate/contradiction
 *   pipeline — MirrorStore below is the narrow write surface a sync needs,
 *   implemented by index.ts.
 * - Sync work per call is bounded (Workers subrequest limits, especially on
 *   the free plan). Outcomes report `remaining` so callers loop until it hits
 *   0 — same pattern as POST /vectorize-pending.
 */

export interface IntegrationEnv {
  OAUTH_KV: KVNamespace;
}

// ─── Provider interface ───────────────────────────────────────────────────────
// The whole contract a new provider must implement. Deliberately thin: how a
// provider lists changes, fetches content, and detects deletions is private to
// it — sync semantics differ too much between APIs (Notion: full listing +
// completeness-gated deletion sweep; cursor-native APIs: incremental exports)
// to abstract further from one data point.

export interface IntegrationProvider {
  id: string;   // registry key, entry `source` value, and URL segment (/integrations/<id>/…)
  name: string; // display name for the settings UI
  // Validate a pasted token against the provider's API; returns an account /
  // workspace label for the UI's "Connected to …" confirmation. Throws with a
  // user-presentable message when the token is rejected.
  validateToken(token: string): Promise<string>;
  // Run one bounded sync batch against the stored record.
  sync(env: IntegrationEnv, store: MirrorStore): Promise<SyncOutcome>;
}

export type SyncOutcome =
  | { ok: true; created: number; updated: number; deleted: number; failed: number; remaining: number; total: number }
  | { ok: false; error: string };

// ─── Integration record (the KV blob) ─────────────────────────────────────────

export interface ItemMapEntry {
  entryId: string; // the mirrored entry's id in D1
  version: string; // the item's change marker (e.g. Notion's last_edited_time) when mirrored
}

export interface IntegrationRecord {
  provider: string;
  authKind: "token"; // "oauth2" reserved for future providers that require it
  credentials: { token: string };
  config: Record<string, unknown>; // escape hatch for future per-provider options
  status: "connected" | "error";
  workspaceName: string | null;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
  itemMap: Record<string, ItemMapEntry>;
  createdAt: number;
  updatedAt: number;
}

// Prefixed so integration keys coexist with workers-oauth-provider's own
// token:/grant:/client: keys in the same namespace.
const INTEGRATIONS_KEY_PREFIX = "integrations:";

export async function loadIntegration(env: IntegrationEnv, provider: string): Promise<IntegrationRecord | null> {
  const raw = await env.OAUTH_KV.get(`${INTEGRATIONS_KEY_PREFIX}${provider}`);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as any;
    // Migrate pre-registry blobs (first Notion release): pageMap/lastEdited →
    // itemMap/version. Persisted back on the next save; losing the map would
    // duplicate every mirror on the following sync.
    if (record.pageMap && !record.itemMap) {
      record.itemMap = Object.fromEntries(
        Object.entries(record.pageMap as Record<string, any>).map(([id, v]) => [
          id,
          { entryId: v.entryId, version: v.version ?? v.lastEdited ?? "" },
        ])
      );
      delete record.pageMap;
    }
    record.itemMap ??= {};
    return record as IntegrationRecord;
  } catch {
    return null;
  }
}

export async function saveIntegration(env: IntegrationEnv, record: IntegrationRecord): Promise<void> {
  await env.OAUTH_KV.put(`${INTEGRATIONS_KEY_PREFIX}${record.provider}`, JSON.stringify(record));
}

export async function deleteIntegration(env: IntegrationEnv, provider: string): Promise<void> {
  await env.OAUTH_KV.delete(`${INTEGRATIONS_KEY_PREFIX}${provider}`);
}

// Connection status for the settings UI. Never exposes credentials — the token
// is write-only from the dashboard's perspective.
export function integrationStatus(provider: Pick<IntegrationProvider, "id" | "name">, record: IntegrationRecord | null) {
  return {
    provider: provider.id,
    name: provider.name,
    connected: record !== null,
    status: record?.status ?? null,
    workspaceName: record?.workspaceName ?? null,
    lastSyncedAt: record?.lastSyncedAt ?? null,
    lastSyncError: record?.lastSyncError ?? null,
    itemCount: record ? Object.keys(record.itemMap).length : 0,
  };
}

// ─── Mirror store ─────────────────────────────────────────────────────────────
// The write primitives a sync needs against the memory store. Implemented by
// index.ts (which owns storeEntry/forgetEntry); injected so this module never
// imports from index.ts (no circular dependency).

export interface MirrorStore {
  // Insert a new entry and return its id.
  createEntry(content: string, tags: string[], source: string): Promise<string>;
  // Replace an entry's content wholesale (re-embed). False if the entry no
  // longer exists — the caller re-creates the mirror.
  updateEntry(entryId: string, content: string): Promise<boolean>;
  // Permanently delete an entry and its vectors.
  deleteEntry(entryId: string): Promise<void>;
}
