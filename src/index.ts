/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  AUTH_TOKEN: string;
  OAUTH_KV: KVNamespace;
  VECTORIZE_GRACE_MS?: string;
}

const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DUPLICATE_BLOCK_THRESHOLD = 0.95;
const DUPLICATE_FLAG_THRESHOLD = 0.85;
const CANDIDATE_SCORE_THRESHOLD = 0.45;
const TAG_BOOST_STEP = 0.15;
const TAG_BOOST_MAX = 1.5;
// Each net contradiction (win or loss) shifts a memory's effective importance by
// log1p(|net|) * this step, clamped to the [1,5] importance band. Tunable.
const CONTRADICTION_IMPORTANCE_STEP = 1.0;

// ─── Compression eligibility ──────────────────────────────────────────────────
// An entry is eligible for nightly digest compression only if it's low-importance,
// not proven-useful by recall, and not a contradiction survivor. Strictly more
// protective than the old `importance_score < 4` filter — it can only exempt MORE.
export const COMPRESSION_IMPORTANCE_THRESHOLD = 4;   // importance >= this → protected
export const COMPRESSION_MIN_RECALL = 2;             // recalled >= this many times → protected
export const COMPRESSION_MIN_AGE_MS = 60 * 86400000; // entries with fewer than COMPRESSION_MIN_RECALL recalls protected until this old (60 days)

// Returns a SQL boolean fragment for "this entry is eligible for compression".
// Contains exactly one `?` placeholder — bind `Date.now() - COMPRESSION_MIN_AGE_MS`.
// columnPrefix: "" for bare columns (compressTag), "entries." for json_each-joined queries.
export function compressionEligibilitySql(columnPrefix = ""): string {
  const p = columnPrefix;
  return `(${p}importance_score IS NULL OR ${p}importance_score < ${COMPRESSION_IMPORTANCE_THRESHOLD})
      AND (${p}recall_count = 0 OR (${p}recall_count < ${COMPRESSION_MIN_RECALL} AND ${p}created_at < ?))
      AND (${p}contradiction_wins IS NULL OR ${p}contradiction_wins = 0)`;
}

// ─── Model constants ──────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

// ─── Chunking constants ───────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 200;

// ─── Token limits ─────────────────────────────────────────────────────────────

const CLASSIFY_MAX_TOKENS = 80;
const CONTRADICTION_MAX_TOKENS = 80;
const SMART_MERGE_MAX_TOKENS = 250;
const INSIGHT_MAX_TOKENS = 300;
const PATTERN_MAX_TOKENS = 100;
const DIGEST_MAX_TOKENS = 400;

// ─── Vectorize constants ──────────────────────────────────────────────────────

const VECTORIZE_TOP_K_MULTIPLIER = 3;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
const D1_MAX_BOUND_PARAMS = 100;

// ─── Memory status layer (issue #119) ──────────────────────────────────────────
// Status lives as a reserved tag (e.g. "status:canonical") on entries.tags — no
// schema change. Absent status = unspecified = default behavior.

export const STATUS_VALUES = ["canonical", "draft", "deprecated"] as const;
export type MemoryStatus = (typeof STATUS_VALUES)[number];
const STATUS_PREFIX = "status:";

export function getStatus(tags: string[]): MemoryStatus | null {
  const tag = tags.find(t => t.startsWith(STATUS_PREFIX));
  if (!tag) return null;
  const value = tag.slice(STATUS_PREFIX.length) as MemoryStatus;
  return (STATUS_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withStatus(tags: string[], status: MemoryStatus): string[] {
  const cleaned = tags.filter(t => !t.startsWith(STATUS_PREFIX));
  return [...cleaned, `${STATUS_PREFIX}${status}`];
}

// ─── Memory kind layer (issue #12) ──────────────────────────────────────────────
// Kind lives as a reserved tag (e.g. "kind:episodic") on entries.tags — no schema
// change. Absent kind = unknown (unclassified). Orthogonal to status (#119).

export const KIND_VALUES = ["episodic", "semantic"] as const;
export type MemoryKind = (typeof KIND_VALUES)[number];
const KIND_PREFIX = "kind:";

export function getKind(tags: string[]): MemoryKind | null {
  const tag = tags.find(t => t.startsWith(KIND_PREFIX));
  if (!tag) return null;
  const value = tag.slice(KIND_PREFIX.length) as MemoryKind;
  return (KIND_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withKind(tags: string[], kind: MemoryKind): string[] {
  const cleaned = tags.filter(t => !t.startsWith(KIND_PREFIX));
  return [...cleaned, `${KIND_PREFIX}${kind}`];
}

// ─── Runtime state ────────────────────────────────────────────────────────────

let dbReady = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readStreamText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    decoder.decode(value).split("\n").forEach(line => {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try { const d = JSON.parse(line.slice(6)); if (d.response) text += d.response; } catch { }
      }
    });
  }
  reader.releaseLock();
  return text;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`) return true;
  return new URL(request.url).searchParams.get("token") === env.AUTH_TOKEN;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Returns a 401 Response if the request lacks a valid token, otherwise null —
// lets routes early-return with `const authErr = requireAuth(...); if (authErr) return authErr;`
function requireAuth(request: Request, env: Env): Response | null {
  if (isAuthorized(request, env)) return null;
  return json({ ok: false, error: "Unauthorized" }, 401);
}

// Hosted OAuth login page. Styled to match the dashboard's token-entry card
// (#auth-overlay in public/index.html) — same fonts, palette, and layout.
function loginHtml(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#F4F1EA" />
  <title>Second Brain</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.44.0/tabler-icons.min.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f4f1ea; --bg-card: #fcfbf7;
      --accent: #b26641; --accent-press: #9c522f; --accent-soft: rgba(178, 102, 65, 0.1); --on-accent: #fcfbf7;
      --text-primary: #26241f; --text-secondary: #6e6b62; --text-tertiary: #a8a498;
      --border-input: rgba(38, 36, 31, 0.11); --danger: #b3261e;
      --font-serif: 'Lora', Georgia, serif; --font-sans: 'DM Sans', system-ui, sans-serif;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    body { background: var(--bg); font-family: var(--font-sans); color: var(--text-primary); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .auth-card { width: 100%; max-width: 400px; padding: 40px 32px; display: flex; flex-direction: column; align-items: center; animation: fade-in 0.5s var(--ease); }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    .brain-logo { width: 70px; height: 70px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; margin-bottom: 24px; position: relative; }
    .brain-logo i { font-size: 33px; }
    .brain-logo::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; border: 1px solid var(--accent-soft); }
    h1 { font-family: var(--font-serif); font-size: 29px; font-weight: 500; margin-bottom: 9px; letter-spacing: -0.015em; }
    p { font-size: 14px; color: var(--text-secondary); margin-bottom: 34px; text-align: center; line-height: 1.6; max-width: 300px; }
    form { width: 100%; display: flex; flex-direction: column; gap: 11px; margin-bottom: 14px; }
    input { width: 100%; padding: 14px 16px; background: var(--bg-card); border: 0.5px solid var(--border-input); border-radius: 13px; font-family: var(--font-sans); font-size: 15px; color: var(--text-primary); outline: none; transition: border-color 0.18s, box-shadow 0.18s; }
    input::placeholder { color: var(--text-tertiary); }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { width: 100%; padding: 15px; background: var(--accent); color: var(--on-accent); border: none; border-radius: 13px; font-family: var(--font-sans); font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.18s, transform 0.12s var(--ease); }
    button:hover { background: var(--accent-press); }
    button:active { transform: scale(0.985); }
    .auth-error { font-size: 13px; color: var(--danger); text-align: center; margin-top: 10px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="brain-logo"><i class="ti ti-brain"></i></div>
    <h1>Second Brain</h1>
    <p>Enter your Bearer token to connect to your personal memory layer.</p>
    <form method="POST">
      <input type="password" name="password" placeholder="Bearer token" autofocus autocomplete="current-password" />
      <button type="submit">Connect</button>
    </form>
    <div class="auth-error">${error ? error : ""}</div>
  </div>
</body>
</html>`;
}

async function embed(text: string, env: Env): Promise<number[]> {
  // Workers AI requires `as any` here — the SDK types don't cover all models
  const result = (await env.AI.run(EMBEDDING_MODEL as any, { text: [text] })) as any;
  return result.data[0] as number[];
}

// ─── Database initialization ──────────────────────────────────────────────────

async function initializeDatabase(env: Env): Promise<void> {
  try {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`);
    await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`);
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

// ─── Duplicate detection ──────────────────────────────────────────────────────

type DuplicateResult =
  | { status: "unique" }
  | { status: "blocked"; matchId: string; score: number }
  | { status: "flagged"; matchId: string; score: number };

export function getDuplicateCheckSample(content: string): string {
  if (content.length <= 1500) return content;

  const start = content.slice(0, 500);
  const midIndex = Math.floor(content.length / 2);
  const middle = content.slice(midIndex - 250, midIndex + 250);
  const end = content.slice(-500);

  return `${start}\n...\n${middle}\n...\n${end}`;
}

// ─── Contradiction Detection ──────────────────────────────────────────────────

interface ContradictionResult {
  detected: boolean;
  conflicting_id?: string;
  reason?: string;
}

// ─── Smart Merge ──────────────────────────────────────────────────────────────
// Only applies to the flagged band (0.85–0.95). The combined prompt handles
// both contradiction detection and merge/replace decisions in a single LLM call,
// keeping total LLM calls the same as before.

export type MergeAction =
  | { action: "keep_both" }
  | { action: "replace"; target_id: string }
  | { action: "merge"; target_id: string; merged_content: string };

// Merges duplicate detection, contradiction detection, and smart merge into a
// single embed + Vectorize query. For flagged entries (0.85–0.95) the combined
// prompt replaces the contradiction-only prompt — same number of LLM calls.
export async function checkDuplicateAndContradiction(content: string, env: Env): Promise<{
  duplicate: DuplicateResult;
  contradiction: ContradictionResult;
  mergeAction: MergeAction | null;
}> {
  const sample = getDuplicateCheckSample(content);
  const values = await embed(sample, env);
  const { matches } = await env.VECTORIZE.query(values, { topK: 5, returnMetadata: "all" });

  // ── Duplicate: derived from top match ───────────────────────────────────────
  let duplicate: DuplicateResult = { status: "unique" };
  if (matches.length) {
    const top = matches[0];
    const matchId = (top.metadata as any)?.parentId ?? top.id;
    if (top.score >= DUPLICATE_BLOCK_THRESHOLD) duplicate = { status: "blocked", matchId, score: top.score };
    else if (top.score >= DUPLICATE_FLAG_THRESHOLD) duplicate = { status: "flagged", matchId, score: top.score };
  }

  // ── Skip all LLM work if blocked ─────────────────────────────────────────────
  let contradiction: ContradictionResult = { detected: false };
  let mergeAction: MergeAction | null = null;

  if (duplicate.status !== "blocked") {
    const candidates = matches.filter(m => m.score >= CANDIDATE_SCORE_THRESHOLD);
    if (candidates.length) {
      const parentIds = [...new Set(
        candidates.map(m => (m.metadata as any)?.parentId ?? m.id)
      )] as string[];

      const placeholders = parentIds.map(() => "?").join(", ");
      const { results: rows } = await env.DB.prepare(
        `SELECT id, content FROM entries WHERE id IN (${placeholders})`
      ).bind(...parentIds).all() as { results: { id: string; content: string }[] };

      if (rows.length) {
        const existingList = rows
          .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
          .join("\n\n");

        if (duplicate.status === "flagged") {
          // ── Combined prompt: contradiction + merge decision (flagged band only) ──
          // Replaces the contradiction-only prompt — same 1 LLM call, richer result.
          const prompt = `You are deciding what to do with a new memory that is very similar to existing memories.

New memory: "${content}"

Similar existing memories:
${existingList}

Choose exactly one action. Prioritise in this order:
1. "contradiction" — new memory DIRECTLY CONFLICTS with an existing one (opposite location, reversed decision, changed fact). Include conflicting_id and reason.
2. "replace" — new memory clearly supersedes an existing one (updated version of the same fact, original is now stale). Include target_id.
3. "merge" — both memories are complementary and better as one combined entry. Include target_id and merged_content (max 400 chars).
4. "keep_both" — memories are different enough to coexist, or you are uncertain. This is the safe default.

Respond with JSON only. No text outside the JSON.
{"action":"keep_both"} OR {"action":"contradiction","conflicting_id":"<id>","reason":"<10 words max>"} OR {"action":"replace","target_id":"<id>"} OR {"action":"merge","target_id":"<id>","merged_content":"<text>"}`;

          try {
            const stream = await (env.AI as any).run(LLM_MODEL as any, {
              messages: [{ role: "user", content: prompt }],
              max_tokens: SMART_MERGE_MAX_TOKENS,
              stream: true,
            });
            const text = await readStreamText(stream as ReadableStream);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const action = parsed.action as string;

              if (action === "contradiction" && parsed.conflicting_id) {
                const validId = parentIds.find(id => id === parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
                // mergeAction stays null — contradiction path handles cleanup
              } else if (action === "replace" && parsed.target_id) {
                const validId = parentIds.find(id => id === parsed.target_id);
                mergeAction = validId ? { action: "replace", target_id: validId } : { action: "keep_both" };
              } else if (action === "merge" && parsed.target_id && parsed.merged_content?.trim()) {
                const validId = parentIds.find(id => id === parsed.target_id);
                mergeAction = validId
                  ? { action: "merge", target_id: validId, merged_content: parsed.merged_content.trim() }
                  : { action: "keep_both" };
              } else {
                mergeAction = { action: "keep_both" };
              }
            } else {
              mergeAction = { action: "keep_both" };
            }
          } catch {
            // non-fatal — default to keep_both (current behaviour)
            mergeAction = { action: "keep_both" };
          }
        } else {
          // ── Contradiction only (0.45–0.85 range — unchanged) ─────────────────
          const prompt = `You are checking if a new memory contradicts existing memories.

New memory: "${content}"

Existing memories:
${existingList}

A contradiction means the new memory states something that DIRECTLY CONFLICTS with an existing memory — a different current location, reversed preference, changed decision, or updated fact. Partial overlaps, additions, or elaborations are NOT contradictions.

Respond with JSON only. No text outside the JSON object.
{"contradicts": false} OR {"contradicts": true, "conflicting_id": "<exact_id>", "reason": "<10 words max>"}`;

          try {
            const stream = await (env.AI as any).run(LLM_MODEL as any, {
              messages: [{ role: "user", content: prompt }],
              max_tokens: CONTRADICTION_MAX_TOKENS,
              stream: true,
            });
            const text = await readStreamText(stream as ReadableStream);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.contradicts && parsed.conflicting_id) {
                const validId = parentIds.find(id => id === parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
              }
            }
          } catch {
            // non-fatal — contradiction stays { detected: false }
          }
        }
      }
    }
  }

  return { duplicate, contradiction, mergeAction };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

export function chunkText(text: string, maxChars = CHUNK_MAX_CHARS, overlapChars = CHUNK_OVERLAP_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChars / 2) end = breakPoint + 1;
    }
    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlapChars;
  }

  return chunks.filter((c) => c.length > 0);
}

// ─── Time-decay reranking ─────────────────────────────────────────────────────

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export function getHalfLifeMs(tags: string[]): number {
  if (tags.includes("task")) return 7 * 24 * 60 * 60 * 1000;  // 7 days
  if (tags.includes("context")) return 180 * 24 * 60 * 60 * 1000; // 6 months
  if (tags.includes("work")) return 90 * 24 * 60 * 60 * 1000; // 3 months
  return 30 * 24 * 60 * 60 * 1000; // 30 days default
}

// Cosine similarity between two vectors. BGE embeddings are not normalized,
// so the denominator matters — this keeps tag-path scores on the same scale
// as Vectorize's cosine query scores.
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // Guard on the raw norms, not the sqrt product — the product can underflow to 0
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export function rerankWithTimeDecay(
  matches: VectorizeMatch[],
  recallCounts: Map<string, number> = new Map(),
  importanceScores: Map<string, number> = new Map(),
  queryTags: string[] = [],
  contradictionWins: Map<string, number> = new Map(),
  contradictionLosses: Map<string, number> = new Map()
): VectorizeMatch[] {
  const now = Date.now();

  return matches
    .map(match => {
      const meta = match.metadata as any;
      const createdAt = meta?.created_at ?? now;
      const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
      const ageMs = now - createdAt;
      const parentId = (meta?.parentId ?? match.id) as string;
      const rc = recallCounts.get(parentId) ?? 0;

      const halfLifeMs = getHalfLifeMs(tags);
      const recencyMultiplier = Math.exp(-ageMs / halfLifeMs);
      // Frequency can compensate for recency loss but never push above a fresh entry (cap at 1.0).
      // Without the cap, high recall counts overwhelm recency and bury newly-stored memories.
      const frequencyMultiplier = 1 + Math.log1p(rc);
      const combinedMultiplier = Math.min(1.0, recencyMultiplier * frequencyMultiplier);
      const isShortAppend = match.id.includes("-update-") &&
        typeof meta?.content === "string" && meta.content.length < CHUNK_OVERLAP_CHARS;
      const appendPenalty = isShortAppend ? 0.2 : 1.0;
      const rolledUpPenalty = tags.includes("rolled-up") ? 0.4 : 1.0;

      // Effective importance = classifier score adjusted by net contradiction history.
      // Survivors (net wins) rise toward 5; repeatedly-contradicted memories (net losses)
      // fall toward 1. log1p gives diminishing returns; clamp keeps the effect inside the
      // existing 0.88–1.20 importance band. The stored importance_score is never mutated.
      const imp = importanceScores.get(parentId) ?? 0;
      const wins = contradictionWins.get(parentId) ?? 0;
      const losses = contradictionLosses.get(parentId) ?? 0;
      const net = wins - losses;
      let importanceMultiplier: number;
      if (imp === 0 && net === 0) {
        importanceMultiplier = 1.0; // unscored and never contested — unchanged baseline
      } else {
        const base = imp === 0 ? 3 : imp; // unscored-but-contested → neutral midpoint
        const adj = Math.sign(net) * Math.log1p(Math.abs(net)) * CONTRADICTION_IMPORTANCE_STEP;
        const effectiveImp = Math.max(1, Math.min(5, base + adj));
        importanceMultiplier = 0.8 + (effectiveImp / 5) * 0.4;
      }

      // Tag boost: applied outside the recency ≤1.0 cap so a tag-relevant memory can
      // surface above a marginally-closer but irrelevant one.
      const overlap = queryTags.length ? tags.filter(t => queryTags.includes(t)).length : 0;
      const tagBoost = overlap ? Math.min(TAG_BOOST_MAX, 1 + overlap * TAG_BOOST_STEP) : 1.0;

      return { ...match, score: match.score * combinedMultiplier * appendPenalty * rolledUpPenalty * importanceMultiplier * tagBoost };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Temporal phrase parsing ──────────────────────────────────────────────────
export function parseTimePhrase(query: string, now: number): { after?: number; before?: number; cleanQuery: string } {
  const MS_DAY = 86400000;
  const MS_WEEK = 7 * MS_DAY;
  const d = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const startOfWeek = (date: Date) => {
    const dow = date.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    return startOfDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff));
  };

  type TimeResult = { after?: number; before?: number };
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => TimeResult]> = [
    [/\blast\s+(\d+)\s+days?\b/i, m => ({ after: now - parseInt(m[1]) * MS_DAY })],
    [/\blast\s+(\d+)\s+weeks?\b/i, m => ({ after: now - parseInt(m[1]) * MS_WEEK })],
    [/\blast\s+week\b/i, () => ({ after: now - MS_WEEK })],
    [/\bthis\s+week\b/i, () => ({ after: startOfWeek(d) })],
    [/\blast\s+month\b/i, () => ({
      after: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      before: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    })],
    [/\bthis\s+month\b/i, () => ({ after: new Date(d.getFullYear(), d.getMonth(), 1).getTime() })],
    [/\byesterday\b/i, () => {
      const s = startOfDay(d) - MS_DAY;
      return { after: s, before: s + MS_DAY };
    }],
    [/\btoday\b/i, () => ({ after: startOfDay(d) })],
    [/\baround\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i, m => {
      const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
      const center = new Date(d.getFullYear(), month, parseInt(m[2])).getTime();
      return { after: center - 3 * MS_DAY, before: center + 3 * MS_DAY };
    }],
  ];

  for (const [pattern, handler] of patterns) {
    const match = query.match(pattern);
    if (match) {
      const { after, before } = handler(match);
      const cleanQuery = query.replace(pattern, '').replace(/\s+/g, ' ').trim() || query;
      return { after, before, cleanQuery };
    }
  }

  return { cleanQuery: query };
}

// ─── AI classification (importance + canonical) ───────────────────────────────

// Map the model's free-text kind to our enum — tolerant of case, whitespace, and
// common synonyms a small model emits (e.g. "event" → episodic, "fact" → semantic).
function normalizeKind(raw: unknown): MemoryKind | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (/episod|event|decision|milestone|occurrence/.test(v)) return "episodic";
  if (/semantic|fact|preference|knowledge|belief/.test(v)) return "semantic";
  return null;
}

// Parse the classifier's response. Tries strict JSON first, then falls back to
// tolerant per-field extraction so one malformed field (small models intermittently
// emit e.g. {"canonical":,}) doesn't discard the other valid fields.
function parseClassification(text: string): { importance: number; canonical: boolean; kind: MemoryKind | null } {
  const obj = text.match(/\{[^{}]*\}/);
  if (obj) {
    try {
      const p = JSON.parse(obj[0]);
      return {
        importance: p.importance >= 1 && p.importance <= 5 ? p.importance : 3,
        canonical: p.canonical === true,
        kind: normalizeKind(p.kind),
      };
    } catch { /* fall through to tolerant extraction */ }
  }
  const imp = text.match(/"importance"\s*:\s*([1-5])/);
  const can = text.match(/"canonical"\s*:\s*(true|false)/i);
  const knd = text.match(/"kind"\s*:\s*"?([a-zA-Z]+)/);
  return {
    importance: imp ? parseInt(imp[1], 10) : 3,
    canonical: can ? can[1].toLowerCase() === "true" : false,
    kind: knd ? normalizeKind(knd[1]) : null,
  };
}

export async function classifyEntry(content: string, env: Env): Promise<{ importance: number; canonical: boolean; kind: MemoryKind | null }> {
  let text: string;
  try {
    const stream = await env.AI.run(LLM_MODEL as any, {
      messages: [{ role: "user", content:
        `Classify this memory. Respond with ONLY one JSON object and nothing else — no prose, no markdown, no code fences.\n` +
        `{"importance": <1-5>, "canonical": <true|false>, "kind": "episodic"|"semantic"}\n` +
        `importance: 1=trivial, 3=useful context, 5=critical decision or goal.\n` +
        `canonical: true ONLY for a confirmed decision, durable fact, or stated permanent preference that should be authoritative (be conservative; false for anything tentative, one-off, or event-like).\n` +
        `kind: "episodic" for a specific event/decision/milestone that happened at a point in time; "semantic" for a general fact, preference, or piece of knowledge.\n\n` +
        `Memory: ${content.slice(0, 500)}`,
      }],
      max_tokens: CLASSIFY_MAX_TOKENS,
      stream: true,
    });
    text = await readStreamText(stream as ReadableStream);
  } catch {
    return { importance: 0, canonical: false, kind: null };
  }
  return parseClassification(text);
}

// ─── Hashtag extraction ───────────────────────────────────────────────────────

export function extractHashtags(content: string): { cleanContent: string; hashtags: string[] } {
  const hashtags = (content.match(/#\w+/g) ?? []).map(t => t.slice(1).toLowerCase());
  const cleanContent = content.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
  return { cleanContent, hashtags };
}

// ─── Query tag inference ──────────────────────────────────────────────────────

export async function inferQueryTags(query: string, env: Env): Promise<string[]> {
  const { hashtags } = extractHashtags(query);
  if (hashtags.length) return hashtags;

  const { results: tagRows } = await env.DB.prepare(
    `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
  ).all();
  const knownTags = (tagRows as { value: string }[]).map(r => r.value);

  const lowerQuery = query.toLowerCase();
  const keywordMatches = knownTags.filter(t =>
    new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(lowerQuery)
  );

  if (keywordMatches.length) return keywordMatches;

  if (!knownTags.length) return [];

  try {
    const stream = await env.AI.run(LLM_MODEL as any, {
      messages: [{
        role: "user",
        content: `From this list of tags: ${knownTags.slice(0, 50).join(", ")}\n\nWhich tags best match this query? Reply with only a comma-separated list of matching tag names from the list, or nothing if none apply.\n\nQuery: ${query.slice(0, 300)}`,
      }],
      max_tokens: 100,
      stream: true,
    });
    const text = await readStreamText(stream as ReadableStream);
    const knownSet = new Set(knownTags);
    return text.split(",").map(t => t.trim().toLowerCase()).filter(t => t && knownSet.has(t));
  } catch {
    return [];
  }
}

// ─── Shared entry-listing filter builder ─────────────────────────────────────
// Builds the WHERE/ORDER/LIMIT clause shared by list_recent and GET /list so
// both stay in sync on which filters (tag, after, before) are supported.

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  if (params.tag) { conds.push(`tags LIKE ?`); bindings.push(`%"${params.tag}"%`); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }

  let sql = `SELECT id, content, tags, source, created_at, vector_ids FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

// ─── Store entry (full embed + chunk) ────────────────────────────────────────
// Returns the list of vector IDs inserted so forget() can clean up exactly.

async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number
): Promise<string[]> {
  const chunks = chunkText(content);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
      };

      tags.forEach(t => {
        metadata[`tag_${t}`] = true;
      });

      return {
        id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
        values: await embed(chunk, env),
        metadata,
      };
    })
  );

  await env.VECTORIZE.insert(vectors);

  const vectorIds = vectors.map(v => v.id);

  // Persist exact vector IDs so forget() can clean up without guessing
  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  return vectorIds;
}

// Delete vectors that are no longer referenced after a re-embed. Ids reused by
// the new embedding must survive: single-chunk entries are keyed by the entry
// id, so the re-embedded vector reuses the old id. Deleting the full old set
// would remove the vector we just inserted, leaving the entry unsearchable.
async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  const stale = oldIds.filter(v => !newIds.includes(v));
  if (stale.length) await env.VECTORIZE.deleteByIds(stale);
}

// ─── Append to existing entry ─────────────────────────────────────────────────
// For short appends (combined content ≤ CHUNK_MAX_CHARS): adds only the new
// addition as a single new Vectorize vector pointing to the parent ID.
// For large appends (combined content > CHUNK_MAX_CHARS): falls back to a full
// re-embed of the combined content using the same safe 3-step pattern as update
// (insert new → delete old), so Vectorize always holds properly chunked vectors.

async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string
): Promise<void> {
  // Read existing vector_ids upfront — needed by both paths
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  const existingVectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  if (newContent.length > CHUNK_MAX_CHARS) {
    // ── Full re-embed path ───────────────────────────────────────────────────
    // Combined content is too large for a single vector — re-chunk everything.
    // Same safe ordering as update/merge/replace: insert new → delete old.

    // Step 1: Persist full combined content to D1
    await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
      .bind(newContent, id).run();

    // Step 2: Re-chunk + re-embed full content (also updates vector_ids in D1)
    let newVectorIds: string[] = [];
    try {
      newVectorIds = await storeEntry(env, id, newContent, tags, source, Date.now());
    } catch (e) {
      console.error("Vectorize re-embed failed (non-fatal):", e);
    }

    // Step 3: Delete only stale vectors — ids reused by the re-embed must survive
    try {
      await deleteStaleVectors(env, existingVectorIds, newVectorIds);
    } catch (e) {
      console.error("Old vector cleanup failed (non-fatal):", e);
    }

    return;
  }

  // ── Normal append-only path (combined content ≤ CHUNK_MAX_CHARS) ────────────
  // Timestamp-based suffix guarantees uniqueness across concurrent appends
  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env);

  const metadata: Record<string, any> = {
    content: addition,
    parentId: id,
    isUpdate: true,
    tags,
    source,
    created_at: Date.now(),
  };

  tags.forEach(t => {
    metadata[`tag_${t}`] = true;
  });

  await env.VECTORIZE.insert([{
    id: newChunkId,
    values,
    metadata,
  }]);

  // Single UPDATE for both content and vector_ids — saves one D1 round trip
  await env.DB.prepare(
    `UPDATE entries SET content = ?, vector_ids = ? WHERE id = ?`
  ).bind(newContent, JSON.stringify([...existingVectorIds, newChunkId]), id).run();
}

// ─── Synthesize insight from retrieved memories ───────────────────────────────

export async function synthesizeInsight(
  query: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
    .join("\n\n");

  const prompt = `You are a second brain assistant. Given the user's query and their relevant stored memories, synthesize what they most need to know. Be specific and concise.

Query: "${query}"

Relevant memories:
${memoriesList}

Provide a brief insight (2-4 sentences) focused on what's most relevant to this query.`;

  let insight = "";
  try {
    const stream = await (env.AI as any).run(LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: INSIGHT_MAX_TOKENS,
      stream: true,
    });
    insight = await readStreamText(stream as ReadableStream);
  } catch (e) {
    console.error("synthesizeInsight LLM call failed (non-fatal):", e);
  }

  return insight.trim();
}

// ─── Async pattern derivation ─────────────────────────────────────────────────

export async function derivePattern(
  rows: { id: string; content: string }[],
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  if (rows.length < 10) return;

  // At most one auto-pattern per 48h to prevent spam across repeated recalls
  const recentPattern = await env.DB.prepare(
    `SELECT id FROM entries WHERE tags LIKE '%"auto-pattern"%' AND created_at > ? LIMIT 1`
  ).bind(Date.now() - 172800000).first();
  if (recentPattern) return;

  const sample = rows.slice(0, 20);
  const memoriesList = sample
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `You are analyzing stored memories to find genuine recurring themes.

Memories:
${memoriesList}

Find a pattern that appears across 3 or more of these memories — a real tendency, preference, or recurring theme about this person. Do NOT summarize individual memories. Do NOT describe any single event.

If you find a genuine cross-memory pattern, respond with exactly ONE sentence starting with exactly one of: "You tend to", "There's a recurring", or "Across your memories".

If no genuine pattern exists across 3+ memories, respond with exactly: NONE`;

  try {
    const response = await (env.AI as any).run(LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: PATTERN_MAX_TOKENS,
    }) as any;

    const trimmed = (
      response?.choices?.[0]?.message?.content ??
      response?.response ??
      ""
    ).trim();

    if (!trimmed || trimmed === "NONE") return;

    const validStarters = ["You tend to", "There's a recurring", "Across your memories"];
    if (!validStarters.some(s => trimmed.startsWith(s))) return;

    await captureEntry(trimmed, ["auto-pattern"], "system", env, ctx);
  } catch (e) {
    console.error("derivePattern failed (non-fatal):", String(e));
  }
}

// ─── Semantic compression ─────────────────────────────────────────────────────

export async function synthesizeDigest(
  tag: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `You are a second brain assistant. Based on these stored memories tagged "${tag}", write a single cohesive paragraph describing the current state of this area — what has been done, decided, and is being worked toward. Write as one flowing paragraph, not a list.

Memories:
${memoriesList}

State of "${tag}":`;

  let digest = "";
  try {
    const stream = await (env.AI as any).run(LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: DIGEST_MAX_TOKENS,
      stream: true,
    });
    digest = await readStreamText(stream as ReadableStream);
  } catch (e) {
    console.error("synthesizeDigest LLM call failed (non-fatal):", e);
  }

  return digest.trim();
}

export async function compressTag(
  tag: string,
  env: Env,
  ctx: ExecutionContext
): Promise<{ synthesizedId: string | null; entriesUsed: number; text: string }> {
  // Reserved/namespaced tags (kind:*, status:*) describe a memory's type/lifecycle,
  // not a topic — digesting them would blend unrelated memories (and could compress
  // protected/canonical ones). Never compress by them. This also guards /digest and
  // the web UI Compress button, not just the nightly cron.
  if (tag.startsWith(STATUS_PREFIX) || tag.startsWith(KIND_PREFIX)) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const recentSynth = await env.DB.prepare(`
    SELECT id FROM entries
    WHERE tags LIKE '%"synthesized"%'
      AND tags LIKE ?
      AND created_at > ?
    LIMIT 1
  `).bind(`%"${tag}"%`, Date.now() - 86400000).first();

  if (recentSynth) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  // Fetch compressible entries: tagged with this tag, not system-tagged, not high-importance
  const { results: rawEntries } = await env.DB.prepare(`
    SELECT id, content FROM entries
    WHERE tags LIKE ?
      AND tags NOT LIKE '%"synthesized"%'
      AND tags NOT LIKE '%"auto-pattern"%'
      AND tags NOT LIKE '%"rolled-up"%'
      AND ${compressionEligibilitySql()}
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(`%"${tag}"%`, Date.now() - COMPRESSION_MIN_AGE_MS).all();

  if (rawEntries.length < 10) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const rows = rawEntries.map(r => ({ id: r.id as string, content: r.content as string }));
  const text = await synthesizeDigest(tag, rows, env);
  if (!text) return { synthesizedId: null, entriesUsed: 0, text: "" };

  const content = `[Synthesized from ${rows.length} entries tagged "${tag}"]\n\n${text}`;
  const result = await captureEntry(content, ["synthesized", tag], "system", env, ctx);

  if (result.status !== "stored") {
    return { synthesizedId: null, entriesUsed: 0, text };
  }

  for (const id of rows.map(r => r.id)) {
    try {
      await env.DB.prepare(
        `UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content || ? WHERE id = ?`
      ).bind(`\n\n[Digest: ${result.id}]`, id).run();
    } catch (e) {
      console.error(`Failed to update source entry ${id} (non-fatal):`, e);
    }
  }

  return { synthesizedId: result.id, entriesUsed: rows.length, text };
}

async function runNightlyCompression(env: Env, ctx: ExecutionContext): Promise<void> {
  await initializeDatabase(env);

  const { results } = await env.DB.prepare(`
    SELECT value as tag, COUNT(*) as count
    FROM entries, json_each(entries.tags)
    WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
      AND value NOT LIKE 'status:%'
      AND value NOT LIKE 'kind:%'
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND ${compressionEligibilitySql("entries.")}
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).bind(Date.now() - COMPRESSION_MIN_AGE_MS).all();

  for (const row of results) {
    const tag = row.tag as string;
    try {
      await compressTag(tag, env, ctx);
    } catch (e) {
      console.error(`Compression failed for tag "${tag}" (non-fatal):`, e);
    }
  }
}

// ─── Shared search path ───────────────────────────────────────────────────────
// Used by both the `recall` MCP tool and GET /recall — the full semantic
// search pipeline (embed → vector query → time-decay rerank → dedupe → D1
// hydration → insight synthesis) lives here once; callers format the result.

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
}

export async function recallEntries(
  params: { query: string; topK: number; tag?: string; after?: number; before?: number; kind?: MemoryKind },
  env: Env,
  ctx: ExecutionContext
): Promise<RecallSearchResult> {
  const { query, topK } = params;
  let { tag, after, before, kind } = params;
  const now = Date.now();

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }

  const [values, queryTags] = await Promise.all([
    embed(embedQuery, env),
    inferQueryTags(embedQuery, env),
  ]);

  let results: { matches: VectorizeMatch[] };
  if (tag) {
    // Tag path: score the tag's own vectors directly. An unconstrained Vectorize
    // query caps at 50 candidates, silently dropping tagged entries whose global
    // semantic rank falls outside the top 50 (issue #141). D1 is the source of
    // truth for tags and already stores each entry's vector_ids.
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids FROM entries WHERE tags LIKE ?`
    ).bind(`%"${tag}"%`).all();
    if (!tagRows.length) return { matches: [], insight: "" };

    const vectorIds = [...new Set(
      (tagRows as any[]).flatMap(r => JSON.parse((r.vector_ids as string) ?? "[]") as string[])
    )];
    if (!vectorIds.length) return { matches: [], insight: "" };

    const vectors: VectorizeVector[] = [];
    for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
      vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
    }

    results = {
      matches: vectors.map(v => ({
        id: v.id,
        score: cosineSim(values, v.values as number[]),
        metadata: v.metadata,
      })) as VectorizeMatch[],
    };
  } else {
    // Cloudflare Vectorize caps topK at 50 when returnMetadata="all" (error 40025)
    const vectorizeTopK = Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
    results = await env.VECTORIZE.query(values, {
      topK: vectorizeTopK,
      returnMetadata: "all",
    });

    if (results.matches.length && results.matches[0].score < DUPLICATE_FLAG_THRESHOLD) {
      results = await env.VECTORIZE.query(values, {
        topK: 50,
        returnMetadata: "all",
      });
    }
  }

  if (!results.matches.length) return { matches: [], insight: "" };

  // Fetch recall_count and importance_score for all candidates to use in scoring.
  // The tag path can produce far more than 100 candidates, so chunk the IN query
  // to stay under D1's bound-parameter limit.
  const candidateIds = [...new Set(results.matches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcRows: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number }[] = [];
  for (let i = 0; i < candidateIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = candidateIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries WHERE id IN (${rcPlaceholders})`
    ).bind(...batch).all() as { results: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number }[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));

  const reranked = rerankWithTimeDecay(results.matches as VectorizeMatch[], recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses);

  const seen = new Set<string>();
  const deduped = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  }).slice(0, topK);

  if (!deduped.length) return { matches: [], insight: "" };

  // Fetch full content from D1 for all matched parent IDs, applying filters: auto-pattern
  // exclusion, status:deprecated exclusion, optional kind match, and optional after/before range
  const parentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);
  const placeholders = parentIds.map(() => "?").join(", ");
  const d1Bindings: (string | number)[] = [...parentIds];
  let d1Sql = `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders}) AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    // Safe to interpolate: `kind` is validated against the KIND_VALUES enum just above,
    // so only "episodic"/"semantic" can reach the string. Kept as a literal (not a bound
    // param) so it doesn't shift the positional after/before bindings below.
    d1Sql += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  if (after !== undefined) { d1Sql += ` AND created_at >= ?`; d1Bindings.push(after); }
  if (before !== undefined) { d1Sql += ` AND created_at <= ?`; d1Bindings.push(before); }
  const { results: d1Rows } = await env.DB.prepare(d1Sql).bind(...d1Bindings).all() as { results: Record<string, any>[] };

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));

  // Increment recall_count for entries actually shown
  ctx.waitUntil(
    Promise.all(
      [...d1Map.keys()].map(id =>
        env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`).bind(id).run()
      )
    ).catch(e => console.error("recall_count update failed (non-fatal):", e))
  );

  const matches: RecallMatch[] = deduped.flatMap((m) => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    const isUpdate = !!meta?.isUpdate;

    if (!row) {
      // D1 row not found — either filtered out (e.g. status:deprecated) or genuinely missing
      return [];
    }

    return [{
      id: parentId,
      content: row.content as string,
      score: m.score,
      createdAt: row.created_at as number,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate,
    }];
  });

  const insight = d1Rows.length > 1
    ? await synthesizeInsight(embedQuery, d1Rows as { id: string; content: string }[], env)
    : "";

  if (d1Rows.length >= 5) {
    ctx.waitUntil(
      derivePattern(d1Rows as { id: string; content: string }[], env, ctx)
        .catch(e => console.error("derivePattern failed (non-fatal):", e))
    );
  }

  return { matches, insight };
}

// ─── Shared write path ────────────────────────────────────────────────────────

// Classify an entry's content (importance + canonical + kind) and apply the tags,
// asynchronously. Used for both newly-inserted entries and smart-merge targets.
function scheduleClassifyAndTag(entryId: string, content: string, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    classifyEntry(content, env)
      .then(async ({ importance, canonical, kind }) => {
        await env.DB.prepare(`UPDATE entries SET importance_score = ? WHERE id = ?`).bind(importance, entryId).run();
        if (!kind && !canonical) return;
        const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(entryId).first() as Record<string, any> | null;
        if (!row) return;
        let tags: string[] = JSON.parse(row.tags ?? "[]");
        if (kind) tags = withKind(tags, kind);
        if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
        await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), entryId).run();
      })
      .catch(e => console.error("Classification failed (non-fatal):", e))
  );
}

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string }
  | { status: "contradiction_protected"; id: string; canonicalId: string; reason?: string }
  | { status: "merged"; id: string }
  | { status: "replaced"; id: string };

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext
): Promise<CaptureResult> {
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  const t = [...new Set([...tags.map(tag => tag.toLowerCase()), ...hashtags])];

  const { duplicate: dup, contradiction, mergeAction } = await checkDuplicateAndContradiction(c, env);

  if (dup.status === "blocked") {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  // ── Smart merge: replace/merge existing entry — no new entry inserted ────────
  if (dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both") {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      `SELECT tags, source, vector_ids, importance_score FROM entries WHERE id = ?`
    ).bind(targetId).first() as Record<string, any> | null;

    if (targetRow) {
      const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
      const existingSource = targetRow.source as string;
      const oldVectorIds: string[] = JSON.parse(targetRow.vector_ids ?? "[]");

      // Protect high-importance or canonical memories from being silently overwritten.
      // Score ≥ 4 means the existing entry is critical; canonical = confirmed authoritative.
      const targetStatus = getStatus(existingTags);
      if ((targetRow.importance_score as number) >= 4 || targetStatus === "canonical") {
        return { status: "flagged", id: crypto.randomUUID(), matchId: targetId, score: dup.score };
      }

      // Step 1: Update D1 content
      await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`).bind(newContent, targetId).run();

      // Step 2: Re-embed new content — inserts new vectors, updates vector_ids in D1
      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, targetId, newContent, existingTags, existingSource, Date.now());
      } catch (e) { console.error("Vectorize re-embed failed (non-fatal):", e); }

      // Step 3: Delete only stale vectors — ids reused by the re-embed must survive
      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

      // Re-classify the merged/replaced content — updates importance_score + kind (and canonical if warranted) on the target.
      scheduleClassifyAndTag(targetId, newContent, env, ctx);

      return mergeAction.action === "merge"
        ? { status: "merged", id: targetId }
        : { status: "replaced", id: targetId };
    }
    // target not found in DB — fall through to normal insert
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const baseTags = contradiction.detected ? [...t, "contradiction-resolved"] : t;
  const finalTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;

  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, c, JSON.stringify(finalTags), source, now, "[]").run();

  ctx.waitUntil(
    storeEntry(env, id, c, finalTags, source, now)
      .catch(e => console.error("Vectorize insert failed (non-fatal):", e))
  );

  scheduleClassifyAndTag(id, c, env, ctx);

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    const conflictRow = await env.DB.prepare(
      `SELECT tags FROM entries WHERE id = ?`
    ).bind(conflictId).first() as Record<string, any> | null;
    const conflictStatus = conflictRow ? getStatus(JSON.parse(conflictRow.tags ?? "[]")) : null;

    if (conflictStatus === "canonical") {
      // Don't overwrite a canonical memory — keep it, demote the new entry to draft.
      // Strip "contradiction-resolved" — that tag marks entries that WON a contradiction;
      // this entry lost, so it must not carry that tag.
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
        .bind(JSON.stringify(withStatus(draftTags, "draft")), id).run();
      // Record the outcome: canonical incumbent survived (win), new draft lost (loss).
      // Non-fatal — a failed count update must not abort capture.
      try {
        await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(conflictId).run();
        await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(id).run();
      } catch (e) {
        console.error("Contradiction count update failed (non-fatal):", e);
      }
      return { status: "contradiction_protected", id, canonicalId: conflictId, reason: contradiction.reason };
    }

    // Non-canonical loser: the new entry wins; the incumbent loses and is deprecated
    // (row kept for audit). Record the outcome before deprecating. Non-fatal.
    try {
      await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(id).run();
      await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(conflictId).run();
    } catch (e) {
      console.error("Contradiction count update failed (non-fatal):", e);
    }
    try {
      await deprecateEntry(conflictId, env);
    } catch (e) {
      console.error("Contradiction deprecation failed (non-fatal):", e);
    }
    return { status: "contradiction", id, resolvedConflict: conflictId, reason: contradiction.reason };
  }

  if (dup.status === "flagged") {
    return { status: "flagged", id, matchId: dup.matchId, score: dup.score };
  }

  return { status: "stored", id };
}

// ─── Shared delete path ───────────────────────────────────────────────────────
// Used by both the `forget` MCP tool and POST /forget so the cleanup logic
// (D1 row + tracked Vectorize IDs) lives in exactly one place.

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number };

export async function forgetEntry(id: string, env: Env): Promise<ForgetResult> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) return { status: "not_found" };

  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

  try {
    if (vectorIds.length) {
      // Delete exact IDs — no guessing, no leaks
      await env.VECTORIZE.deleteByIds(vectorIds);
    }
  } catch (e) {
    console.error("Vectorize delete failed (non-fatal):", e);
  }

  return { status: "deleted", vectorCount: vectorIds.length };
}

// Deprecate (issue #119): keep the D1 row for audit but make the entry
// unrecallable by deleting its vectors and tagging it status:deprecated.
export async function deprecateEntry(id: string, env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT tags, vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  await env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
    .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", id).run();

  try {
    if (vectorIds.length) await env.VECTORIZE.deleteByIds(vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

// Apply a lifecycle status to an entry (issue #119). 'deprecated' deletes vectors
// (via deprecateEntry); others swap the status:* tag in place. Returns ok=false if no such entry.
export async function applyStatus(id: string, status: MemoryStatus, env: Env): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env);
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(withStatus(tags, status)), id).run();
  return true;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.0.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.registerTool(
    "remember",
    {
      description: "Store an idea, task, or note in your second brain. Call this automatically whenever the user shares context, goals, decisions, or preferences.",
      inputSchema: {
        content: z.string().describe("The idea, task, or note to store"),
        tags: z.array(z.string()).optional().describe("Optional tags for filtering"),
        source: z.string().optional().describe("Origin: phone, browser, voice, claude"),
      },
    },
    async ({ content, tags, source }) => {
      const result = await captureEntry(content, tags ?? [], source ?? "claude", env, ctx);
      if (result.status === "blocked") {
        return { content: [{ type: "text", text: `Duplicate detected (${(result.score * 100).toFixed(0)}% match) — not stored. Existing entry ID: ${result.matchId}` }] };
      }
      if (result.status === "contradiction") {
        return { content: [{ type: "text", text: `Stored. ID: ${result.id} — resolved contradiction with entry ${result.resolvedConflict}${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "contradiction_protected") {
        return { content: [{ type: "text", text: `Stored as draft (ID: ${result.id}) — conflicts with a canonical memory (${result.canonicalId}), which was kept${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "replaced") {
        return { content: [{ type: "text", text: `Memory updated — new content replaced outdated entry (ID: ${result.id}).` }] };
      }
      if (result.status === "merged") {
        return { content: [{ type: "text", text: `Memories merged — combined into existing entry (ID: ${result.id}).` }] };
      }
      if (result.status === "flagged") {
        return { content: [{ type: "text", text: `Stored with ID: ${result.id} — note: similar entry exists (${(result.score * 100).toFixed(0)}% match, ID: ${result.matchId}). Tagged as duplicate-candidate.` }] };
      }
      return { content: [{ type: "text", text: `Stored. ID: ${result.id}` }] };
    }
  );

  // ── append ───────────────────────────────────────────────────────────────
  server.registerTool(
    "append",
    {
      description: "Append new information to an existing entry in your second brain. Use when something has changed or been updated — preserves the original and adds the update with a timestamp. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID to append to — from recall or list_recent"),
        addition: z.string().describe("The new information to add to the existing entry"),
      },
    },
    async ({ id, addition }) => {
      const row = await env.DB.prepare(
        `SELECT id, content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return {
          content: [{ type: "text", text: `No entry found with ID: ${id}` }],
        };
      }

      const existingContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const source = row.source as string;
      const a = addition.trim();

      if (!a) {
        return {
          content: [{ type: "text", text: "Addition cannot be empty." }],
        };
      }

      try {
        await appendToEntry(env, id, existingContent, a, tags, source);
      } catch (e) {
        console.error("Append failed:", e);
        return {
          content: [{ type: "text", text: `Append failed: ${(e as Error).message}` }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `Appended to entry ${id}. The original content is preserved and your update has been added with today's date.`,
        }],
      };
    }
  );

  // ── update ───────────────────────────────────────────────────────────────
  server.registerTool(
    "update",
    {
      description: "Replace the full content of an existing memory. Use when information has changed entirely — a preference reversed, a decision overturned, or content is outdated. Use append instead if you're adding new information rather than replacing. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID to update — from recall or list_recent"),
        content: z.string().describe("The new content to replace the existing entry with"),
      },
    },
    async ({ id, content }) => {
      const newContent = content.trim();
      if (!newContent) {
        return { content: [{ type: "text", text: "Content cannot be empty." }] };
      }

      // Read current row upfront — need tags, source, AND old vector_ids before any mutation
      const row = await env.DB.prepare(
        `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      const tags: string[] = JSON.parse(row.tags ?? "[]").filter((t: string) => t !== "rolled-up");
      const source = row.source as string;
      const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

      // Step 1: Update D1 content and tags (strip rolled-up so updated entry ranks normally)
      await env.DB.prepare(`UPDATE entries SET content = ?, tags = ? WHERE id = ?`)
        .bind(newContent, JSON.stringify(tags), id).run();

      // Step 2: Re-embed new content → inserts new vectors + updates vector_ids in D1
      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, id, newContent, tags, source, Date.now());
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }
      const newVectorCount = newVectorIds.length;

      // Step 3: Delete only stale vectors — ids reused by the re-embed must survive
      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }

      return {
        content: [{ type: "text", text: `Updated entry ${id}. Re-embedded as ${newVectorCount} vector(s).` }],
      };
    }
  );

  // ── set_status ─────────────────────────────────────────────────────────────
  server.registerTool(
    "set_status",
    {
      description: "Set a memory's lifecycle status. 'canonical' = confirmed/authoritative (protected from auto-overwrite), 'draft' = tentative, 'deprecated' = no longer accurate (removed from recall, kept for audit). Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID — from recall or list_recent"),
        status: z.enum([...STATUS_VALUES] as [string, ...string[]]).describe("canonical | draft | deprecated"),
      },
    },
    async ({ id, status }) => {
      const ok = await applyStatus(id, status as MemoryStatus, env);
      if (!ok) return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      return { content: [{ type: "text", text: status === "deprecated" ? `Entry ${id} deprecated — removed from recall, kept for audit.` : `Entry ${id} marked ${status}.` }] };
    }
  );

  // ── recall ───────────────────────────────────────────────────────────────
  server.registerTool(
    "recall",
    {
      description: "Recall: semantically search your second brain for relevant notes and context. Call recall automatically at the start of every conversation and every 3-4 messages.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
        tag: z.string().optional().describe("Filter by a specific tag"),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
        kind: z.enum([...KIND_VALUES] as [string, ...string[]]).optional().describe("Filter to episodic (events) or semantic (facts/knowledge)"),
      },
    },
    async ({ query, topK, tag, after, before, kind }) => {
      const { matches, insight } = await recallEntries({ query, topK, tag, after, before, kind: kind as MemoryKind | undefined }, env, ctx);

      if (!matches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      const text = matches.map((m, i) => {
        const date = new Date(m.createdAt).toLocaleDateString();
        const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const src = m.source ? ` · ${m.source}` : "";
        const score = (m.score * 100).toFixed(0);
        const updateLabel = m.isUpdate ? " [updated]" : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}\n${m.content}`;
      }).join("\n\n");

      const finalText = insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
      return { content: [{ type: "text", text: finalText }] };
    }
  );

  // ── list_recent ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_recent",
    {
      description: "list_recent: List the most recent entries by date from your second brain. Use when you need to browse recent entries or find an entry ID. Not the same as recall — returns entries by time, not by meaning.",
      inputSchema: {
        n: z.number().int().min(1).max(50).default(10),
        tag: z.string().optional(),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
      },
    },
    async ({ n, tag, after, before }) => {
      const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before });
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();

      if (!results.length) {
        return { content: [{ type: "text", text: "No entries found." }] };
      }

      const text = (results as Record<string, any>[]).map((row, i) => {
        const date = new Date(row.created_at as number).toLocaleDateString();
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        const tagStr = tags.length ? ` · ${tags.join(", ")}` : "";
        return `${i + 1}. [${date} · ${row.source}${tagStr}]\nID: ${row.id as string}\n${row.content}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── forget ───────────────────────────────────────────────────────────────
  server.registerTool(
    "forget",
    {
      description: "Permanently delete an entry from your second brain by ID. Only call when the user explicitly asks to delete something. Confirm the entry ID using recall or list_recent first. This action cannot be undone.",
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
      },
    },
    async ({ id }) => {
      const result = await forgetEntry(id, env);
      if (result.status === "not_found") {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }
      return { content: [{ type: "text", text: `Deleted entry ${id} and ${result.vectorCount} vector(s)` }] };
    }
  );

  return server;
}

// ─── OAuth API handler — /mcp only ────────────────────────────────────────────
// OAuthProvider validates the token (OAuth grant, or the static AUTH_TOKEN via
// resolveExternalToken) before delegating to this handler.

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!dbReady) {
      ctx.waitUntil(initializeDatabase(env).then(() => { dbReady = true; }));
    }
    const server = buildMcpServer(env, ctx);
    return createMcpHandler(server)(request, env, ctx);
  },
};

// ─── Default handler — all non-MCP routes ────────────────────────────────────

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // OAuth authorize endpoint — hosted login page for browser-based MCP clients.
    if (url.pathname === "/oauth/authorize") {
      let oauthReq: any;
      try {
        // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
        // so parseAuthRequest reads the query params cleanly.
        const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
        oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
      } catch {
        return new Response("Invalid authorization request — this page must be opened by an MCP client.", {
          status: 400, headers: { "Content-Type": "text/plain" },
        });
      }
      if (request.method === "POST") {
        const form = await request.formData();
        if (form.get("password") !== env.AUTH_TOKEN) {
          return new Response(loginHtml("Invalid token"), {
            status: 401, headers: { "Content-Type": "text/html" },
          });
        }
        const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "owner",
          scope: oauthReq.scope,
          props: { userId: "owner" },
        });
        return Response.redirect(redirectTo, 302);
      }
      return new Response(loginHtml(), { headers: { "Content-Type": "text/html" } });
    }

    if (!dbReady) {
      ctx.waitUntil(
        initializeDatabase(env).then(() => { dbReady = true; })
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // POST /capture
    if (url.pathname === "/capture" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { content?: string; tags?: string[]; source?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

      const result = await captureEntry(body.content, body.tags ?? [], body.source ?? "api", env, ctx);

      if (result.status === "blocked") {
        return json({
          ok: false,
          duplicate: true,
          matchId: result.matchId,
          score: parseFloat((result.score * 100).toFixed(1)),
          message: "Near-exact duplicate detected — not stored",
        });
      }
      if (result.status === "contradiction") {
        return json({ ok: true, id: result.id, resolved_conflict: result.resolvedConflict, reason: result.reason });
      }
      if (result.status === "contradiction_protected") {
        return json({ ok: true, id: result.id, status: "draft", kept_canonical: result.canonicalId, reason: result.reason });
      }
      if (result.status === "replaced") {
        return json({ ok: true, id: result.id, action: "replaced", message: "New memory replaced an outdated existing entry" });
      }
      if (result.status === "merged") {
        return json({ ok: true, id: result.id, action: "merged", message: "Memories merged into a single combined entry" });
      }
      if (result.status === "flagged") {
        return json({
          ok: true,
          id: result.id,
          warning: "similar",
          matchId: result.matchId,
          score: parseFloat((result.score * 100).toFixed(1)),
          message: "Stored but similar entry exists — tagged as duplicate-candidate",
        });
      }
      return json({ ok: true, id: result.id });
    }

    // POST /append
    if (url.pathname === "/append" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string; addition?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!body.addition?.trim()) return json({ ok: false, error: "addition is required" }, 400);

      const id = body.id.trim();
      const addition = body.addition.trim();

      const row = await env.DB.prepare(
        `SELECT id, content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }

      const existingContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const source = row.source as string;

      try {
        await appendToEntry(env, id, existingContent, addition, tags, source);
      } catch (e) {
        return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
      }

      return json({
        ok: true,
        id,
        message: "Update appended successfully with timestamp",
      });
    }

    // POST /update
    if (url.pathname === "/update" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string; content?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

      const id = body.id.trim();
      const newContent = body.content.trim();

      const row = await env.DB.prepare(
        `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const { cleanContent, hashtags: newHashtags } = extractHashtags(newContent);
      const mergedTags = [...new Set([...tags, ...newHashtags])];
      const source = row.source as string;
      const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
      const finalContent = cleanContent || newContent;

      await env.DB.prepare(`UPDATE entries SET content = ?, tags = ? WHERE id = ?`)
        .bind(finalContent, JSON.stringify(mergedTags), id).run();

      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, id, finalContent, mergedTags, source, Date.now());
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }
      const newVectorCount = newVectorIds.length;

      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }

      return json({ ok: true, id, vectors: newVectorCount });
    }

    // GET /count
    if (url.pathname === "/count" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const row = await env.DB.prepare(`SELECT COUNT(*) as count FROM entries`).first() as Record<string, any> | null;
      return json({ count: (row?.count as number) ?? 0 });
    }

    // GET /tags
    if (url.pathname === "/tags" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
      ).all();
      return json((results as any[]).map(r => r.value as string));
    }

    // GET /stats
    if (url.pathname === "/stats" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const graceCutoff = Date.now() - graceMs(env);
      const [summary, tagRows, candidateRows] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
           SUM(CASE WHEN vector_ids = '[]' AND created_at < ? THEN 1 ELSE 0 END) as unvectorized
           FROM entries`
        ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
        env.DB.prepare(`SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags) GROUP BY value ORDER BY n DESC LIMIT 5`).all(),
        env.DB.prepare(`
          SELECT value as tag, COUNT(*) as count
          FROM entries, json_each(entries.tags)
          WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
            AND value NOT LIKE 'status:%'
            AND value NOT LIKE 'kind:%'
            AND entries.tags NOT LIKE '%"rolled-up"%'
            AND entries.tags NOT LIKE '%"synthesized"%'
            AND entries.tags NOT LIKE '%"auto-pattern"%'
            AND ${compressionEligibilitySql("entries.")}
          GROUP BY value
          HAVING count > 10
          ORDER BY count DESC
          LIMIT 10
        `).bind(Date.now() - COMPRESSION_MIN_AGE_MS).all(),
      ]);

      const cutoff = Date.now() - 86400000;
      const digestCandidates: { tag: string; count: number }[] = [];
      for (const row of candidateRows.results as any[]) {
        const existing = await env.DB.prepare(
          `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? AND created_at > ? LIMIT 1`
        ).bind(`%"${row.tag}"%`, cutoff).first();
        if (!existing) digestCandidates.push({ tag: row.tag as string, count: row.count as number });
      }

      return json({
        count: (summary?.count as number) ?? 0,
        avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
        top_tags: (tagRows.results as any[]).map(r => r.value as string),
        digest_candidates: digestCandidates,
        unvectorized: (summary?.unvectorized as number) ?? 0,
        vectorize_grace_ms: graceMs(env),
      });
    }

    // GET /list
    if (url.pathname === "/list" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const n = Math.min(parseInt(url.searchParams.get("n") ?? "20", 10), 100);
      const tag = url.searchParams.get("tag")?.trim() || undefined;
      const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
      const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;

      const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before });
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();
      return json(results);
    }

    // GET /recall — semantic search, mirrors the MCP `recall` tool
    if (url.pathname === "/recall" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      const query = url.searchParams.get("query")?.trim();
      if (!query) return json({ ok: false, error: "query is required" }, 400);

      const topK = Math.min(Math.max(parseInt(url.searchParams.get("topK") ?? "5", 10), 1), 20);
      const tag = url.searchParams.get("tag")?.trim() || undefined;
      const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
      const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;
      const kindParam = url.searchParams.get("kind")?.trim();
      const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;

      const { matches, insight } = await recallEntries({ query, topK, tag, after, before, kind }, env, ctx);

      if (!matches.length) {
        return json({ ok: true, results: [], message: "Nothing found matching that query." });
      }

      return json({
        ok: true,
        results: matches.map(m => ({
          id: m.id,
          content: m.content,
          score: parseFloat((m.score * 100).toFixed(1)),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated: m.isUpdate,
        })),
        insight: insight || null,
      });
    }

    // POST /forget — delete-by-id, mirrors the MCP `forget` tool
    if (url.pathname === "/forget" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

      const id = body.id.trim();
      const result = await forgetEntry(id, env);

      if (result.status === "not_found") {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }

      return json({ ok: true, id, deletedVectors: result.vectorCount });
    }

    // POST /status — set lifecycle status, mirrors the MCP `set_status` tool
    if (url.pathname === "/status" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string; status?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!(STATUS_VALUES as readonly string[]).includes(body.status ?? "")) {
        return json({ ok: false, error: `status must be one of: ${STATUS_VALUES.join(", ")}` }, 400);
      }

      const id = body.id.trim();
      const status = body.status as MemoryStatus;
      const ok = await applyStatus(id, status, env);

      if (!ok) {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }

      return json({ ok: true, id, status });
    }

    // POST /chat
    if (url.pathname === "/chat" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { query?: string; memories?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.query?.trim()) return json({ ok: false, error: "query is required" }, 400);

      const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided. Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories. Be concise.`;

      const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;

      // Workers AI requires `as any` here — the SDK types don't cover all models
      const stream = await env.AI.run(LLM_MODEL as any, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        stream: true,
      });

      return new Response(stream as ReadableStream, {
        headers: { "Content-Type": "text/event-stream", ...CORS_HEADERS },
      });
    }

    // GET /digest
    if (url.pathname === "/digest" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const tag = url.searchParams.get("tag")?.trim();
      if (!tag) return json({ ok: false, error: "tag parameter is required" }, 400);

      const result = await compressTag(tag, env, ctx);

      if (!result.synthesizedId) {
        return json({ tag, error: "Could not create digest — tag may have fewer than 20 entries or was recently compressed", source_count: result.entriesUsed });
      }

      return json({ tag, synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
    }

    // POST /vectorize-pending
    if (url.pathname === "/vectorize-pending" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      const graceCutoff = Date.now() - graceMs(env);

      const { results: toProcess } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries
         WHERE vector_ids = '[]' AND created_at < ?
         ORDER BY created_at DESC LIMIT 25`
      ).bind(graceCutoff).all();

      let processed = 0;
      let failed = 0;

      for (const row of toProcess as Record<string, any>[]) {
        try {
          await storeEntry(
            env,
            row.id as string,
            row.content as string,
            JSON.parse(row.tags as string),
            row.source as string,
            row.created_at as number
          );
          processed++;
        } catch (e) {
          console.error("Re-embed failed for entry", row.id, e);
          failed++;
        }
      }

      const remaining = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ?`
      ).bind(graceCutoff).first() as Record<string, any> | null;

      return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─── Export ───────────────────────────────────────────────────────────────────
// Wrap both handlers in OAuthProvider. It auto-serves the OAuth metadata,
// /oauth/token, and /oauth/register (RFC 7591) endpoints, and gates /mcp.
// The scheduled handler runs the nightly compression cron alongside the fetch handler.

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken: async ({ token, env }) => {
    if (token === (env as Env).AUTH_TOKEN) {
      return { props: { userId: "owner" } };
    }
    return null;
  },
});

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    oauthProvider.fetch(req, env as any, ctx),
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runNightlyCompression(env, ctx));
  },
};