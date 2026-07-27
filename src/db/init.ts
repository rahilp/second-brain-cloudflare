import type { Env } from "../env";

export async function initializeDatabase(env: Env): Promise<void> {
  try {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`);
    // Relationship graph (issue #16). One additive table — never touches existing
    // rows/queries, so old code ignores it and rollback is a no-op. Designed to never
    // need an ALTER: type/provenance are free TEXT validated in code, and metadata is
    // a JSON escape-hatch for any future per-edge attribute.
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'relates_to', weight REAL NOT NULL DEFAULT 0.5, provenance TEXT NOT NULL DEFAULT 'inferred', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_id, target_id, type))`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`);
  } catch (e) {
    console.error("Database initialization error (non-fatal):", e);
  }
  for (const alter of [
    `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`,
  ]) {
    try { await env.DB.exec(alter); } catch { /* column already exists — no-op */ }
  }
}
