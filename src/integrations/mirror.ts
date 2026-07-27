import type { Env } from "../env";
import {
  INTEGRATION_PROVIDERS,
  getProvider,
  loadIntegration,
  deleteIntegration,
} from "../integrations";
import type { MirrorStore } from "./framework";
import { initializeDatabase } from "../db/init";
import { forgetEntry } from "../capture/lifecycle";
import { deleteStaleVectors, storeEntry } from "../capture/store";
import { classifyEntry } from "../capture/classify";
import { withKind } from "../memory/kind";
import { withStatus } from "../memory/status";

export function makeMirrorStore(env: Env): MirrorStore {
  return {
    async createEntry(content, tags, source) {
      const id = crypto.randomUUID();
      const now = Date.now();
      // Classify like a normal capture so mirror entries (email, calendar,
      // Notion) get a kind/importance and don't sit in the "not classified"
      // bucket. Non-fatal — a failure just leaves it for the backfill to pick up.
      let finalTags = tags;
      let importance = 0;
      try {
        const c = await classifyEntry(content, env);
        importance = c.importance;
        if (c.kind) finalTags = withKind(finalTags, c.kind);
        if (c.canonical) finalTags = withStatus(finalTags, "canonical");
      } catch (e) {
        console.error("Mirror classify failed (non-fatal):", e);
      }
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, importance_score) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, content, JSON.stringify(finalTags), source, now, "[]", importance).run();
      try {
        await storeEntry(env, id, content, finalTags, source, now);
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

      await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`).bind(content, id).run();
      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, id, content, tags, row.source as string, Date.now());
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

const CRON_SYNC_MAX_BATCHES = 5;

export async function runScheduledIntegrationSync(env: Env): Promise<void> {
  let initialized = false;
  for (const provider of Object.values(INTEGRATION_PROVIDERS)) {
    if (!(await loadIntegration(env, provider.id))) continue;
    if (!initialized) {
      await initializeDatabase(env);
      initialized = true;
    }
    const store = makeMirrorStore(env);
    for (let i = 0; i < CRON_SYNC_MAX_BATCHES; i++) {
      const result = await provider.sync(env, store);
      if (!result.ok || result.remaining === 0) break;
    }
  }
}
