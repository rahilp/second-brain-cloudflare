/**
 * Second Brain — external source integrations (Notion).
 *
 * Design notes:
 * - All integration state (token, workspace info, page↔entry map) lives in
 *   OAUTH_KV under `integrations:*` keys — one JSON blob per provider. KV is
 *   deliberate: the namespace is already provisioned in every deployment, so
 *   shipping this feature is a pure code deploy with no schema migration, and
 *   the access pattern (read once at sync start, write once at the end) is
 *   exactly what KV wants.
 * - Synced pages are MIRRORS: the external tool is the source of truth for its
 *   own pages. Every sync replaces a mirrored entry's content wholesale, dedupe
 *   is by page id (not similarity), and an unshared/archived page deletes its
 *   mirror. Mirrors therefore bypass captureEntry's duplicate/contradiction
 *   pipeline — the MirrorStore interface below is the narrow write surface the
 *   sync needs, wired up by index.ts.
 * - Sync work per call is bounded (Workers subrequest limits, especially on the
 *   free plan). The result reports `remaining` so callers loop until it hits 0 —
 *   same pattern as POST /vectorize-pending.
 */

export interface IntegrationEnv {
  OAUTH_KV: KVNamespace;
}

// ─── Integration record (the KV blob) ─────────────────────────────────────────

export interface PageMapEntry {
  entryId: string;    // the mirrored entry's id in D1
  lastEdited: string; // the page's last_edited_time at the time it was mirrored
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
  pageMap: Record<string, PageMapEntry>;
  createdAt: number;
  updatedAt: number;
}

// Prefixed so integration keys coexist with workers-oauth-provider's own
// token:/grant:/client: keys in the same namespace.
const INTEGRATIONS_KEY_PREFIX = "integrations:";

export async function loadIntegration(env: IntegrationEnv, provider: string): Promise<IntegrationRecord | null> {
  const raw = await env.OAUTH_KV.get(`${INTEGRATIONS_KEY_PREFIX}${provider}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as IntegrationRecord; } catch { return null; }
}

export async function saveIntegration(env: IntegrationEnv, record: IntegrationRecord): Promise<void> {
  await env.OAUTH_KV.put(`${INTEGRATIONS_KEY_PREFIX}${record.provider}`, JSON.stringify(record));
}

export async function deleteIntegration(env: IntegrationEnv, provider: string): Promise<void> {
  await env.OAUTH_KV.delete(`${INTEGRATIONS_KEY_PREFIX}${provider}`);
}

// Connection status for the settings UI. Never exposes credentials — the token
// is write-only from the dashboard's perspective.
export function integrationStatus(record: IntegrationRecord | null) {
  return {
    provider: "notion",
    name: "Notion",
    connected: record !== null,
    status: record?.status ?? null,
    workspaceName: record?.workspaceName ?? null,
    lastSyncedAt: record?.lastSyncedAt ?? null,
    lastSyncError: record?.lastSyncError ?? null,
    pageCount: record ? Object.keys(record.pageMap).length : 0,
  };
}

// ─── Mirror store ─────────────────────────────────────────────────────────────
// The write primitives the sync needs against the memory store. Implemented by
// index.ts (which owns storeEntry/forgetEntry); injected here so this module
// never imports from index.ts (no circular dependency).

export interface MirrorStore {
  // Insert a new entry (already-embedded content path) and return its id.
  createEntry(content: string, tags: string[], source: string): Promise<string>;
  // Replace an entry's content wholesale (re-embed). False if the entry no
  // longer exists — the caller re-creates the mirror.
  updateEntry(entryId: string, content: string): Promise<boolean>;
  // Permanently delete an entry and its vectors.
  deleteEntry(entryId: string): Promise<void>;
}

// ─── Notion API client ────────────────────────────────────────────────────────

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export const NOTION_SOURCE = "notion";
export const NOTION_TAG = "notion";

// Bounds tuned for the Workers free-plan budget of 50 external fetches per
// invocation: a full sync batch costs ≤ MAX_LISTING_REQUESTS +
// SYNC_PAGE_BATCH × (ROOT_BLOCK_REQUESTS + NESTED_BLOCK_REQUESTS) ≈ 35.
const SEARCH_PAGE_SIZE = 100;
const MAX_LISTING_REQUESTS = 5;    // ≤ 500 accessible pages listed per sync
export const SYNC_PAGE_BATCH = 5;  // pages ingested per sync call; callers loop on `remaining`
const BLOCK_PAGE_SIZE = 100;
const ROOT_BLOCK_REQUESTS = 2;     // ≤ 200 top-level blocks per page
const NESTED_BLOCK_REQUESTS = 4;   // one level of children for the first 4 nested blocks
const MAX_PAGE_CONTENT_CHARS = 8000;

async function notionFetch(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    let message = `Notion API error (${res.status})`;
    try {
      const body = await res.json() as any;
      if (body?.message) message = `Notion: ${body.message}`;
    } catch { /* non-JSON error body — keep the status message */ }
    throw new Error(message);
  }
  return res.json();
}

// Validate an internal-integration token and return the workspace name for the
// settings UI's "Connected to …" confirmation.
export async function notionValidateToken(token: string): Promise<string> {
  const me = await notionFetch(token, "/users/me");
  return me?.bot?.workspace_name ?? me?.name ?? "Notion workspace";
}

export interface NotionPageMeta {
  id: string;
  lastEdited: string;
  title: string;
  url: string;
  archived: boolean;
}

// List every page the integration can access. Notion's sharing model IS the
// selection mechanism: users share pages (and their subtrees) with the
// integration in Notion, and this listing returns exactly that set.
export async function notionListPages(token: string): Promise<{ pages: NotionPageMeta[]; complete: boolean }> {
  const pages: NotionPageMeta[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let i = 0; i < MAX_LISTING_REQUESTS; i++) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "page" },
      page_size: SEARCH_PAGE_SIZE,
    };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(token, "/search", { method: "POST", body: JSON.stringify(body) });
    for (const p of (data.results ?? []) as any[]) {
      if (p?.object !== "page") continue;
      pages.push({
        id: p.id as string,
        lastEdited: (p.last_edited_time as string) ?? "",
        title: extractPageTitle(p),
        url: (p.url as string) ?? "",
        archived: p.archived === true || p.in_trash === true,
      });
    }
    if (!data.has_more) { complete = true; break; }
    cursor = data.next_cursor as string;
  }
  return { pages, complete };
}

// A page's title lives in whichever property has type "title" (name varies by
// parent database; standalone pages use "title").
export function extractPageTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title.map((t: any) => t?.plain_text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "Untitled";
}

function blockText(block: any): string {
  const data = block?.[block?.type];
  const rich = data?.rich_text;
  if (!Array.isArray(rich)) return "";
  return rich.map((t: any) => t?.plain_text ?? "").join("");
}

// Flatten Notion blocks to plain text for embedding. Nested children (attached
// as `_children` by notionFetchPageText) indent one level per depth.
export function flattenBlocks(blocks: any[], depth = 0): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const block of blocks ?? []) {
    const text = blockText(block);
    let line = "";
    switch (block?.type) {
      case "heading_1": line = `# ${text}`; break;
      case "heading_2": line = `## ${text}`; break;
      case "heading_3": line = `### ${text}`; break;
      case "bulleted_list_item":
      case "numbered_list_item": line = `- ${text}`; break;
      case "to_do": line = `[${block.to_do?.checked ? "x" : " "}] ${text}`; break;
      case "quote":
      case "callout": line = `> ${text}`; break;
      case "code": line = "```" + (block.code?.language ?? "") + "\n" + text + "\n```"; break;
      case "divider": line = "---"; break;
      // Child pages sync as their own entries when shared — reference, don't inline.
      case "child_page": line = `[Sub-page: ${block.child_page?.title ?? "Untitled"}]`; break;
      case "child_database": line = `[Database: ${block.child_database?.title ?? "Untitled"}]`; break;
      case "bookmark": line = block.bookmark?.url ?? ""; break;
      default: line = text; // paragraph, toggle, and anything else with rich_text
    }
    if (line.trim()) lines.push(indent + line);
    if (Array.isArray(block?._children) && block._children.length) {
      const childText = flattenBlocks(block._children, depth + 1);
      if (childText) lines.push(childText);
    }
  }
  return lines.join("\n");
}

async function notionListChildren(token: string, blockId: string, maxRequests: number): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxRequests; i++) {
    const qs = new URLSearchParams({ page_size: String(BLOCK_PAGE_SIZE) });
    if (cursor) qs.set("start_cursor", cursor);
    const data = await notionFetch(token, `/blocks/${blockId}/children?${qs}`);
    blocks.push(...((data.results ?? []) as any[]));
    if (!data.has_more) break;
    cursor = data.next_cursor as string;
  }
  return blocks;
}

// Fetch a page's content as flattened text. One level of nesting only
// (indented bullets, toggle bodies) under a bounded request budget — deep
// trees truncate rather than risk the Worker's subrequest limit.
export async function notionFetchPageText(token: string, pageId: string): Promise<string> {
  const blocks = await notionListChildren(token, pageId, ROOT_BLOCK_REQUESTS);
  let nestedBudget = NESTED_BLOCK_REQUESTS;
  for (const block of blocks) {
    if (nestedBudget <= 0) break;
    if (block?.has_children && block.type !== "child_page" && block.type !== "child_database") {
      nestedBudget--;
      try {
        block._children = await notionListChildren(token, block.id, 1);
      } catch (e) {
        console.error(`Notion nested block fetch failed for ${block.id} (non-fatal):`, e);
      }
    }
  }
  return flattenBlocks(blocks);
}

// Title + source URL lead the content: the title sharpens embedding quality,
// and the URL lets recall results link back to the live page.
export function buildPageContent(title: string, url: string, text: string): string {
  const body = text.length > MAX_PAGE_CONTENT_CHARS ? `${text.slice(0, MAX_PAGE_CONTENT_CHARS)}\n…` : text;
  return [`# ${title}`, url, "", body].join("\n").trim();
}

// ─── Sync planning ────────────────────────────────────────────────────────────
// Per-page lastEdited comparison against the pageMap (not a global cursor):
// robust to Notion's minute-granularity timestamps, and a partially-processed
// batch simply leaves the unprocessed pages "changed" for the next run.

export interface SyncPlan {
  changed: NotionPageMeta[]; // new or edited, oldest first so partial batches converge
  deleted: string[];         // page ids whose mirrors should be removed
}

export function computeSyncPlan(
  pages: NotionPageMeta[],
  pageMap: Record<string, PageMapEntry>,
  listingComplete: boolean,
): SyncPlan {
  const changed = pages
    .filter(p => !p.archived && pageMap[p.id]?.lastEdited !== p.lastEdited)
    .sort((a, b) => (a.lastEdited < b.lastEdited ? -1 : 1));

  const deleted: string[] = [];
  // Archived/trashed pages are an explicit delete signal even on a truncated listing.
  for (const p of pages) {
    if (p.archived && pageMap[p.id]) deleted.push(p.id);
  }
  // Silent disappearance (page unshared or integration access revoked) is only
  // trustworthy when the listing was complete — a truncated listing must never
  // trigger deletions.
  if (listingComplete) {
    const listed = new Set(pages.map(p => p.id));
    for (const id of Object.keys(pageMap)) {
      if (!listed.has(id)) deleted.push(id);
    }
  }
  return { changed, deleted };
}

// ─── Sync loop ────────────────────────────────────────────────────────────────

export type NotionSyncOutcome =
  | { ok: true; created: number; updated: number; deleted: number; failed: number; remaining: number; total: number }
  | { ok: false; error: string };

export async function runNotionSync(env: IntegrationEnv, store: MirrorStore): Promise<NotionSyncOutcome> {
  const record = await loadIntegration(env, "notion");
  if (!record) return { ok: false, error: "Notion is not connected" };

  let pages: NotionPageMeta[];
  let complete: boolean;
  try {
    ({ pages, complete } = await notionListPages(record.credentials.token));
  } catch (e) {
    record.status = "error";
    record.lastSyncError = e instanceof Error ? e.message : String(e);
    record.updatedAt = Date.now();
    await saveIntegration(env, record);
    return { ok: false, error: record.lastSyncError };
  }

  const plan = computeSyncPlan(pages, record.pageMap, complete);
  const batch = plan.changed.slice(0, SYNC_PAGE_BATCH);

  let created = 0, updated = 0, failed = 0;
  for (const page of batch) {
    try {
      const text = await notionFetchPageText(record.credentials.token, page.id);
      const content = buildPageContent(page.title, page.url, text);
      const existing = record.pageMap[page.id];
      if (existing && await store.updateEntry(existing.entryId, content)) {
        record.pageMap[page.id] = { entryId: existing.entryId, lastEdited: page.lastEdited };
        updated++;
      } else {
        // New page — or its mirror was deleted out-of-band; (re-)create it.
        const entryId = await store.createEntry(content, [NOTION_TAG], NOTION_SOURCE);
        record.pageMap[page.id] = { entryId, lastEdited: page.lastEdited };
        created++;
      }
    } catch (e) {
      // Per-page failure is non-fatal: the pageMap doesn't advance for this
      // page, so the next sync retries it.
      console.error(`Notion sync failed for page ${page.id} (non-fatal):`, e);
      failed++;
    }
  }

  let deleted = 0;
  for (const pageId of plan.deleted) {
    const mapped = record.pageMap[pageId];
    if (!mapped) continue;
    try {
      await store.deleteEntry(mapped.entryId);
      delete record.pageMap[pageId];
      deleted++;
    } catch (e) {
      console.error(`Notion mirror delete failed for page ${pageId} (non-fatal):`, e);
    }
  }

  record.status = "connected";
  record.lastSyncedAt = Date.now();
  record.lastSyncError = null;
  record.updatedAt = Date.now();
  await saveIntegration(env, record);

  return {
    ok: true,
    created,
    updated,
    deleted,
    failed,
    remaining: plan.changed.length - batch.length,
    total: pages.filter(p => !p.archived).length,
  };
}
