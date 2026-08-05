import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  deleteIntegration,
} from "../integrations";
import type { IntegrationProvider, MirrorStore } from "./framework";
import { initializeDatabase } from "../db/init";
import { forgetEntry } from "../capture/lifecycle";
import { deleteStaleVectors, storeEntry } from "../capture/store";
import { classifyEntry } from "../capture/classify";
import { withKind } from "../memory/kind";
import { withStatus } from "../memory/status";
import { tagsAfterWrite } from "../memory/stale";

export function makeMirrorStore(env: Env): MirrorStore {
  // One config read per store, not one per mirrored item. A store is built once
  // per sync batch, so this is still the per-request scope every other caller
  // resolves at (src/config.ts) — but the batch writes up to SYNC_EVENT_BATCH
  // items, and resolving inside the write paths made each of those cost its own
  // KV read on top of its D1, Workers AI and Vectorize calls (#290).
  //
  // Lazy rather than eager so makeMirrorStore stays synchronous for its callers
  // and a sync with nothing to write still costs nothing. Memoising the promise
  // rather than the value is what makes concurrent writes share one read;
  // resolveConfig degrades to the defaults instead of rejecting, so there is no
  // failure to latch.
  let pending: Promise<Readonly<Config>> | null = null;
  const config = () => (pending ??= resolveConfig(env));

  return {
    async createEntry(content, tags, source) {
      const id = crypto.randomUUID();
      const now = Date.now();
      // Classify like a normal capture so mirror entries (email, calendar,
      // Notion) get a kind/importance and don't sit in the "not classified"
      // bucket. Non-fatal — a failure just leaves it for the backfill to pick up.
      let finalTags = tags;
      let importance = 0;
      // Used for both the classify and the embed below: they must agree on the
      // model, and this function once resolved config for the embed while
      // classifying with the shipped default.
      const cfg = await config();
      try {
        const c = await classifyEntry(content, env, cfg);
        importance = c.importance;
        if (c.kind) finalTags = withKind(finalTags, c.kind);
        if (c.canonical) finalTags = withStatus(finalTags, "canonical");
      } catch (e) {
        console.error("Mirror classify failed (non-fatal):", e);
      }
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, importance_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, content, JSON.stringify(finalTags), source, now, now, "[]", importance).run();
      try {
        await storeEntry(env, id, content, finalTags, source, now, cfg);
      } catch (e) {
        console.error("Vectorize insert failed (non-fatal):", e);
      }
      return id;
    },
    async updateEntry(id, content) {
      const row = await env.DB.prepare(
        `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;
      if (!row) return false;

      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

      const refreshedTags = tagsAfterWrite(tags);
      const now = Date.now();

      await env.DB.prepare(`UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?`)
        .bind(content, JSON.stringify(refreshedTags), now, id).run();
      const cfg = await config();
      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, id, content, refreshedTags, row.source as string, now, cfg);
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }
      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }
      return true;
    },
    async deleteEntry(id) {
      await forgetEntry(id, env);
    },
  };
}

export async function isManagedMirror(source: string, env: Env): Promise<boolean> {
  return getProvider(source) !== null && (await loadIntegration(env, source)) !== null;
}

export function mirrorEditError(source: string): string {
  const name = getProvider(source)?.name ?? source;
  return `This memory is synced from ${name}. Edit it in ${name} (the change syncs automatically), or disconnect the ${name} integration to make it editable.`;
}

/**
 * The schedule this job owns, and the reason it has one.
 *
 * A Worker invocation gets 50 D1 queries and 10 ms of CPU on the free plan. The
 * nightly maintenance pass already spends 30 of those queries, which left a
 * mirror sync sharing that invocation with room for nothing useful: five batches
 * cost 100 D1 queries on their own, and even one batch put the shared invocation
 * exactly at the cap — over it as soon as the batch was updates rather than
 * creates, or a second provider was connected (#290).
 *
 * So the sync runs on its own trigger with its own allowance. Must match the
 * second entry in wrangler.jsonc's `triggers.crons` exactly — scheduled() in
 * src/index.ts routes on it, and a mismatch would silently send this job's work
 * to the nightly invocation, which is the problem it exists to avoid.
 * test/unit/cron-triggers.test.ts fails if the two drift apart.
 */
export const INTEGRATION_SYNC_CRON = "30 * * * *";

/**
 * Batches per run.
 *
 * One. The caller has always been the thing that loops: every sync returns
 * `remaining`, and the dashboard's "Sync now" drains a backlog on demand. The
 * cron only has to make progress, and one batch an hour does, on a cursor the
 * next run resumes from. Raising this spends a budget that is now sized for one
 * batch — and it would spend the CPU cap too, since each batch re-fetches and
 * re-expands the whole feed.
 */
const CRON_SYNC_MAX_BATCHES = 1;

/**
 * Sync ONE provider per run, least-recently-attempted first.
 *
 * Syncing every connected provider in a single invocation multiplies the cost by
 * however many the user has connected — two calendars measured 70 D1 queries
 * against a cap of 50 — and no per-provider batch size can fix that, because the
 * multiplier is the provider count. Rotating keeps the cost of a run flat in the
 * number of connections; the hourly schedule is what keeps each one fresh.
 *
 * The rotation key is `updatedAt`, not `lastSyncedAt`. Every provider writes
 * `updatedAt` on every sync ATTEMPT but `lastSyncedAt` only on success, so
 * ordering by the latter would park the rotation on a provider whose token has
 * expired — it would be picked every hour, forever, and starve the ones that
 * still work. `updatedAt` always advances, so a failing provider takes its turn
 * and yields.
 */
export async function runScheduledIntegrationSync(env: Env): Promise<void> {
  let due: IntegrationProvider | null = null;
  let dueSince = Infinity;
  for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
    const record = await loadIntegration(env, provider.id);
    if (!record) continue;
    // Strict <, so registry order breaks ties deterministically — which is what
    // orders the first run after two providers are connected together.
    const touchedAt = record.updatedAt ?? 0;
    if (touchedAt < dueSince) {
      due = provider;
      dueSince = touchedAt;
    }
  }
  if (!due) return;

  await initializeDatabase(env);
  const store = makeMirrorStore(env);
  for (let i = 0; i < CRON_SYNC_MAX_BATCHES; i++) {
    const result = await due.sync(env, store);
    if (!result.ok || result.remaining === 0) break;
  }
}
