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
}

const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DUPLICATE_BLOCK_THRESHOLD = 0.95;
const DUPLICATE_FLAG_THRESHOLD = 0.85;
const CANDIDATE_SCORE_THRESHOLD = 0.45;

// ─── Model constants ──────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

// ─── Chunking constants ───────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 200;

// ─── Token limits ─────────────────────────────────────────────────────────────

const CONTRADICTION_MAX_TOKENS = 80;
const SMART_MERGE_MAX_TOKENS = 250;
const INSIGHT_MAX_TOKENS = 300;
const PATTERN_MAX_TOKENS = 100;
const DIGEST_MAX_TOKENS = 400;

// ─── Vectorize constants ──────────────────────────────────────────────────────

const VECTORIZE_TOP_K_MULTIPLIER = 3;

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

export function rerankWithTimeDecay(
  matches: VectorizeMatch[],
  recallCounts: Map<string, number> = new Map(),
  importanceScores: Map<string, number> = new Map()
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

      // importance_score 0 = unscored (neutral). 1–5 scales from 0.88 → 1.20.
      // Lets high-importance memories surface above the recency cap without dominating.
      const imp = importanceScores.get(parentId) ?? 0;
      const importanceMultiplier = imp === 0 ? 1.0 : 0.8 + (imp / 5) * 0.4;

      return { ...match, score: match.score * combinedMultiplier * appendPenalty * rolledUpPenalty * importanceMultiplier };
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

// ─── AI importance scoring ────────────────────────────────────────────────────

async function scoreImportance(content: string, env: Env): Promise<number> {
  try {
    const stream = await env.AI.run(LLM_MODEL as any, {
      messages: [{
        role: "user", content:
          `Rate the long-term importance of this memory 1-5. Reply with only a single digit.\n1=trivial 3=useful context 5=critical decision or goal\n\nMemory: ${content.slice(0, 500)}`
      }],
      stream: true,
    });
    const text = await readStreamText(stream as ReadableStream);
    const score = parseInt(text.trim(), 10);
    return score >= 1 && score <= 5 ? score : 3;
  } catch {
    return 0;
  }
}

// ─── Hashtag extraction ───────────────────────────────────────────────────────

export function extractHashtags(content: string): { cleanContent: string; hashtags: string[] } {
  const hashtags = (content.match(/#\w+/g) ?? []).map(t => t.slice(1).toLowerCase());
  const cleanContent = content.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
  return { cleanContent, hashtags };
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

  let sql = `SELECT id, content, tags, source, created_at FROM entries`;
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
    try {
      await storeEntry(env, id, newContent, tags, source, Date.now());
    } catch (e) {
      console.error("Vectorize re-embed failed (non-fatal):", e);
    }

    // Step 3: Delete old vectors after new ones are safely inserted
    try {
      if (existingVectorIds.length) await env.VECTORIZE.deleteByIds(existingVectorIds);
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
      AND (importance_score IS NULL OR importance_score < 4)
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(`%"${tag}"%`).all();

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
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND (entries.importance_score IS NULL OR entries.importance_score < 4)
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).all();

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
  params: { query: string; topK: number; tag?: string; after?: number; before?: number },
  env: Env,
  ctx: ExecutionContext
): Promise<RecallSearchResult> {
  const { query, topK } = params;
  let { tag, after, before } = params;
  const now = Date.now();

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }

  const values = await embed(embedQuery, env);

  // If tag filter, resolve matching IDs from D1 first (D1 is source of truth for tags)
  let tagFilterIds: Set<string> | null = null;
  if (tag) {
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id FROM entries WHERE tags LIKE ?`
    ).bind(`%"${tag}"%`).all();
    tagFilterIds = new Set((tagRows as any[]).map(r => r.id as string));
    if (tagFilterIds.size === 0) return { matches: [], insight: "" };
  }

  // Query Vectorize without filter — tag filtering happens in-memory below
  // Cloudflare Vectorize caps topK at 50 when returnMetadata="all" (error 40025)
  const vectorizeTopK = Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
  let results = await env.VECTORIZE.query(values, {
    topK: vectorizeTopK,
    returnMetadata: "all",
  });

  if (results.matches.length && results.matches[0].score < DUPLICATE_FLAG_THRESHOLD) {
    results = await env.VECTORIZE.query(values, {
      topK: 50,
      returnMetadata: "all",
    });
  }

  if (!results.matches.length) return { matches: [], insight: "" };

  // Fetch recall_count and importance_score for all candidates to use in scoring
  const candidateIds = [...new Set(results.matches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcPlaceholders = candidateIds.map(() => "?").join(", ");
  const { results: rcRows } = await env.DB.prepare(
    `SELECT id, recall_count, importance_score FROM entries WHERE id IN (${rcPlaceholders})`
  ).bind(...candidateIds).all() as { results: { id: string; recall_count: number; importance_score: number }[] };
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));

  const reranked = rerankWithTimeDecay(results.matches as VectorizeMatch[], recallCounts, importanceScores);

  const seen = new Set<string>();
  const deduped = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    // Apply tag filter against D1-resolved IDs
    if (tagFilterIds && !tagFilterIds.has(parentId)) return false;
    seen.add(parentId);
    return true;
  }).slice(0, topK);

  if (!deduped.length) return { matches: [], insight: "" };

  // Fetch full content from D1 for all matched parent IDs, applying time filter if set
  const parentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);
  const placeholders = parentIds.map(() => "?").join(", ");
  const d1Bindings: (string | number)[] = [...parentIds];
  let d1Sql = `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders}) AND tags NOT LIKE '%"auto-pattern"%'`;
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

  const matches: RecallMatch[] = deduped.map((m) => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    const isUpdate = !!meta?.isUpdate;

    if (row) {
      return {
        id: parentId,
        content: row.content as string,
        score: m.score,
        createdAt: row.created_at as number,
        tags: JSON.parse(row.tags ?? "[]"),
        source: row.source as string,
        isUpdate,
      };
    }

    // Fallback to metadata if D1 row not found (shouldn't happen)
    return {
      id: parentId,
      content: (meta?.content as string) ?? "",
      score: m.score,
      createdAt: (meta?.created_at as number) ?? now,
      tags: Array.isArray(meta?.tags) ? (meta.tags as string[]) : [],
      source: (meta?.source as string) ?? "",
      isUpdate,
    };
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

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string }
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

      // Protect high-importance memories from being silently overwritten.
      // Score ≥ 4 means the existing entry is critical — keep both rather than replace.
      if ((targetRow.importance_score as number) >= 4) {
        return { status: "flagged", id: crypto.randomUUID(), matchId: targetId, score: dup.score };
      }

      // Step 1: Update D1 content
      await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`).bind(newContent, targetId).run();

      // Step 2: Re-embed new content — inserts new vectors, updates vector_ids in D1
      try {
        await storeEntry(env, targetId, newContent, existingTags, existingSource, Date.now());
      } catch (e) { console.error("Vectorize re-embed failed (non-fatal):", e); }

      // Step 3: Delete old vectors after new ones are safely in place
      try {
        if (oldVectorIds.length) await env.VECTORIZE.deleteByIds(oldVectorIds);
      } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

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

  ctx.waitUntil(
    scoreImportance(c, env)
      .then(score => env.DB.prepare(`UPDATE entries SET importance_score = ? WHERE id = ?`).bind(score, id).run())
      .catch(e => console.error("Importance scoring failed (non-fatal):", e))
  );

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    try {
      const conflictRow = await env.DB.prepare(
        `SELECT vector_ids FROM entries WHERE id = ?`
      ).bind(conflictId).first() as Record<string, any> | null;
      const conflictVectorIds: string[] = JSON.parse(conflictRow?.vector_ids ?? "[]");
      await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(conflictId).run();
      if (conflictVectorIds.length) await env.VECTORIZE.deleteByIds(conflictVectorIds);
    } catch (e) {
      console.error("Contradiction resolution cleanup failed (non-fatal):", e);
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
      let newVectorCount = 0;
      try {
        const newVectorIds = await storeEntry(env, id, newContent, tags, source, Date.now());
        newVectorCount = newVectorIds.length;
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }

      // Step 3: Delete old vectors — after new ones are safely in place
      try {
        if (oldVectorIds.length) await env.VECTORIZE.deleteByIds(oldVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }

      return {
        content: [{ type: "text", text: `Updated entry ${id}. Re-embedded as ${newVectorCount} vector(s).` }],
      };
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
      },
    },
    async ({ query, topK, tag, after, before }) => {
      const { matches, insight } = await recallEntries({ query, topK, tag, after, before }, env, ctx);

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

      let newVectorCount = 0;
      try {
        const newVectorIds = await storeEntry(env, id, finalContent, mergedTags, source, Date.now());
        newVectorCount = newVectorIds.length;
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }

      try {
        if (oldVectorIds.length) await env.VECTORIZE.deleteByIds(oldVectorIds);
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
      const [summary, tagRows, candidateRows] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) as count, AVG(importance_score) as avg_importance FROM entries`).first() as Promise<Record<string, any> | null>,
        env.DB.prepare(`SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags) GROUP BY value ORDER BY n DESC LIMIT 5`).all(),
        env.DB.prepare(`
          SELECT value as tag, COUNT(*) as count
          FROM entries, json_each(entries.tags)
          WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
            AND entries.tags NOT LIKE '%"rolled-up"%'
            AND entries.tags NOT LIKE '%"synthesized"%'
            AND entries.tags NOT LIKE '%"auto-pattern"%'
            AND (entries.importance_score IS NULL OR entries.importance_score < 4)
          GROUP BY value
          HAVING count > 10
          ORDER BY count DESC
          LIMIT 10
        `).all(),
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

      const { matches, insight } = await recallEntries({ query, topK, tag, after, before }, env, ctx);

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