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
  contradiction_losses INTEGER DEFAULT 0,
  workspace_id     TEXT NOT NULL DEFAULT '',     -- owning workspace ('' = legacy owner-private rows pending backfill)
  actor_id         TEXT NOT NULL DEFAULT ''      -- user who wrote it ('' = the owner, pre-team writes)
  -- Runtime ALTER columns (see src/db/init.ts): updated_at, staleness_checked_at
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
-- Every scoped read filters on the workspace first, then orders by recency. This
-- index is what keeps that shape a range search rather than a sort.
CREATE INDEX IF NOT EXISTS idx_entries_workspace_created
  ON entries(workspace_id, created_at DESC);

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
  workspace_id TEXT NOT NULL DEFAULT '',           -- denormalized from the source entry so graph walks scope without a join
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

-- Candidate pairs for the weekly insight pass. Must stay in step with
-- src/db/init.ts, which creates the same objects at runtime for brains that
-- were migrated before this existed.
CREATE TABLE IF NOT EXISTS insight_candidates (
  id          TEXT PRIMARY KEY,
  a_id        TEXT NOT NULL,
  b_id        TEXT NOT NULL,                       -- normalised so a_id < b_id
  similarity  REAL NOT NULL,                       -- cosine at accrual time
  gap_ms      INTEGER NOT NULL,                    -- |created_at difference|
  score       REAL NOT NULL,                       -- see src/insight/score.ts
  signal      TEXT NOT NULL DEFAULT 'vector',      -- vector | supersedes
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | used | rejected
  created_at  INTEGER NOT NULL,
  UNIQUE(a_id, b_id)
);

CREATE INDEX IF NOT EXISTS idx_insight_candidates_queue
  ON insight_candidates(status, score DESC);

-- Team edition tenancy (v3). Additive like edges/insight_candidates: a single-user
-- brain never reads these tables and rollback is a no-op. See docs/superpowers/
-- specs/2026-08-24-team-edition-design.md.
--
-- The bootstrap seeds one company workspace, one owner user, one personal workspace
-- per user, and membership rows for both. Legacy entries keep workspace_id '' until
-- the one-time backfill assigns them to the owner's personal workspace.
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'personal',  -- personal | company (validated in app code)
  name        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- The bootstrap looks up the company workspace by kind on every identity path.
CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  email         TEXT,
  role          TEXT NOT NULL DEFAULT 'member',    -- admin | member (validated in app code)
  token_hash    TEXT NOT NULL,                     -- SHA-256 hex of the bearer token (the token itself is never stored)
  suspended     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  default_share TEXT NOT NULL DEFAULT '',          -- capture-visibility override ('' = inherit org TEAM_DEFAULT_WORKSPACE)
  removed_at    INTEGER                             -- soft offboarding; NULL/0 = active member
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash);

CREATE TABLE IF NOT EXISTS memberships (
  user_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',   -- reserved for future per-workspace roles
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- Immutable audit trail. Application code only ever INSERTs here — no UPDATE or
-- DELETE exists anywhere in src/, by design. Tamper evidence is absence of a way
-- to rewrite it, not cryptography.
CREATE TABLE IF NOT EXISTS entry_events (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL,
  actor_id   TEXT NOT NULL DEFAULT '',
  event      TEXT NOT NULL,                      -- created | updated | appended | deleted | status_changed | shared | unshared
  payload    TEXT NOT NULL DEFAULT '{}',         -- JSON escape hatch for per-event detail
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entry_events_entry ON entry_events(entry_id, created_at DESC);

-- Single-row table driving the nightly round-robin over workspaces so free-plan
-- invocations stay inside their subrequest budget. P6 wires the readers.
CREATE TABLE IF NOT EXISTS maintenance_cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id TEXT NOT NULL DEFAULT '',
  advanced_at  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO maintenance_cursor (id, workspace_id, advanced_at) VALUES (1, '', 0)
  ON CONFLICT DO NOTHING;
