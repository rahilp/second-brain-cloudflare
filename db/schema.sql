-- Run with: wrangler d1 execute second-brain-db --file=schema.sql

CREATE TABLE IF NOT EXISTS entries (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '[]',   -- JSON array
  source           TEXT NOT NULL DEFAULT 'api',  -- 'phone', 'browser', 'voice', 'claude', 'api'
  created_at       INTEGER NOT NULL,             -- Unix ms timestamp
  vector_ids       TEXT NOT NULL DEFAULT '[]',   -- JSON array of Vectorize vector IDs
  recall_count         INTEGER DEFAULT 0,
  importance_score     INTEGER DEFAULT 0,
  contradiction_wins   INTEGER DEFAULT 0,
  contradiction_losses INTEGER DEFAULT 0
  -- Runtime ALTER columns (see src/db/init.ts): updated_at, staleness_checked_at
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);

-- Relationship graph (issue #16). One additive table — old code ignores it and
-- rollback is a no-op. Designed to never need an ALTER: type/provenance are free
-- TEXT validated in app code (not SQL CHECK), and metadata is a JSON escape-hatch
-- for any future per-edge attribute (the edges analogue of entries.tags).
CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'relates_to',  -- relates_to | supersedes | caused_by | decided | about_person | part_of_project | follows
  weight      REAL NOT NULL DEFAULT 0.5,           -- 0..1 strength/confidence
  provenance  TEXT NOT NULL DEFAULT 'inferred',    -- explicit | inferred | system
  metadata    TEXT NOT NULL DEFAULT '{}',          -- JSON escape-hatch for future per-edge fields
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
-- The graph view reads the strongest edges (ORDER BY weight DESC LIMIT n). Without an
-- ordered path to weight, SQLite scans every edge into a temp b-tree before the LIMIT
-- applies — measured rows_read is 2 x the edge count whether or not a LIMIT is present,
-- which at 500k edges is 1M rows read per request against D1's 5M/day free cap. Costs one
-- extra index write per edge (5 -> 6 rows written per insert), which the far larger read
-- saving pays for many times over. Must stay in step with src/db/init.ts, which creates
-- the same index at runtime for brains that were migrated before it existed.
CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC);
