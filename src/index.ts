/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  AUTH_TOKEN: string;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DUPLICATE_BLOCK_THRESHOLD = 0.95;
const DUPLICATE_FLAG_THRESHOLD = 0.85;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  return request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function embed(text: string, env: Env): Promise<number[]> {
  // Workers AI requires `as any` here — the SDK types don't cover all models
  const result = (await env.AI.run("@cf/baai/bge-small-en-v1.5" as any, { text: [text] })) as any;
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

async function checkDuplicate(content: string, env: Env): Promise<DuplicateResult> {
  const sample = getDuplicateCheckSample(content);
  const values = await embed(sample, env);
  const results = await env.VECTORIZE.query(values, { topK: 1, returnMetadata: "all" });

  if (!results.matches.length) return { status: "unique" };

  const top = results.matches[0];
  const score = top.score;
  const matchId = (top.metadata as any)?.parentId ?? top.id;

  if (score >= DUPLICATE_BLOCK_THRESHOLD) return { status: "blocked", matchId, score };
  if (score >= DUPLICATE_FLAG_THRESHOLD) return { status: "flagged", matchId, score };
  return { status: "unique" };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

export function chunkText(text: string, maxChars = 1600, overlapChars = 200): string[] {
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

export function rerankWithTimeDecay(matches: VectorizeMatch[]): VectorizeMatch[] {
  const now = Date.now();

  return matches
    .map(match => {
      const meta = match.metadata as any;
      const createdAt = meta?.created_at ?? now;
      const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
      const ageMs = now - createdAt;

      const halfLifeMs = getHalfLifeMs(tags);
      const recencyMultiplier = Math.exp(-ageMs / halfLifeMs);

      return { ...match, score: match.score * recencyMultiplier };
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
        content: chunk.slice(0, 512),
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
// Updates D1 with the full appended content, then adds only the new addition
// as a new Vectorize chunk pointing to the same parent ID.
// Tracks the new chunk ID in vector_ids so forget() can clean it up exactly.

async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string
): Promise<void> {
  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  // Update full content in D1
  await env.DB.prepare(
    `UPDATE entries SET content = ? WHERE id = ?`
  ).bind(newContent, id).run();

  // Timestamp-based suffix guarantees uniqueness across concurrent appends
  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env);

  const metadata: Record<string, any> = {
    content: addition.slice(0, 512),
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

  // Append the new chunk ID to the tracked vector_ids list in D1
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  const existing: string[] = JSON.parse(row?.vector_ids ?? "[]");
  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify([...existing, newChunkId]), id).run();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.0.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store an idea, task, or note in your second brain. Call this automatically whenever the user shares context, goals, decisions, or preferences.",
    {
      content: z.string().describe("The idea, task, or note to store"),
      tags: z.array(z.string()).optional().describe("Optional tags for filtering"),
      source: z.string().optional().describe("Origin: phone, browser, voice, claude"),
    },
    async ({ content, tags, source }) => {
      const c = content.trim();
      const t = tags ?? [];
      const s = source ?? "claude";

      const dup = await checkDuplicate(c, env);

      if (dup.status === "blocked") {
        return {
          content: [{
            type: "text",
            text: `Duplicate detected (${(dup.score * 100).toFixed(0)}% match) — not stored. Existing entry ID: ${dup.matchId}`,
          }],
        };
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const finalTags = dup.status === "flagged" ? [...t, "duplicate-candidate"] : t;

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(finalTags), s, now, "[]").run();

      try {
        await storeEntry(env, id, c, finalTags, s, now);
      } catch (e) {
        console.error("Vectorize insert failed (non-fatal):", e);
      }

      if (dup.status === "flagged") {
        return {
          content: [{
            type: "text",
            text: `Stored with ID: ${id} — note: similar entry exists (${(dup.score * 100).toFixed(0)}% match, ID: ${dup.matchId}). Tagged as duplicate-candidate.`,
          }],
        };
      }

      return { content: [{ type: "text", text: `Stored. ID: ${id}` }] };
    }
  );

  // ── append ───────────────────────────────────────────────────────────────
  server.tool(
    "append",
    "Append new information to an existing entry in your second brain. Use when something has changed or been updated — preserves the original and adds the update with a timestamp. Get the entry ID from recall or list_recent first.",
    {
      id: z.string().describe("Entry ID to append to — from recall or list_recent"),
      addition: z.string().describe("The new information to add to the existing entry"),
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

  // ── recall ───────────────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Recall: semantically search your second brain for relevant notes and context. Call recall automatically at the start of every conversation and every 3-4 messages.",
    {
      query: z.string().describe("Natural language search query"),
      topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
      tag: z.string().optional().describe("Filter by a specific tag"),
      after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
      before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
    },
    async ({ query, topK, tag, after, before }) => {
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
        if (tagFilterIds.size === 0) {
          return { content: [{ type: "text", text: "Nothing found matching that query." }] };
        }
      }

      // Query Vectorize without filter — tag filtering happens in-memory below
      const results = await env.VECTORIZE.query(values, {
        topK: topK * 3,
        returnMetadata: "all",
      });

      if (!results.matches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      const reranked = rerankWithTimeDecay(results.matches as VectorizeMatch[]);

      const seen = new Set<string>();
      const deduped = reranked.filter((m) => {
        const parentId = (m.metadata as any)?.parentId ?? m.id;
        if (seen.has(parentId)) return false;
        // Apply tag filter against D1-resolved IDs
        if (tagFilterIds && !tagFilterIds.has(parentId)) return false;
        seen.add(parentId);
        return true;
      }).slice(0, topK);

      if (!deduped.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      // Fetch full content from D1 for all matched parent IDs, applying time filter if set
      const parentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);
      const placeholders = parentIds.map(() => "?").join(", ");
      const d1Bindings: (string | number)[] = [...parentIds];
      let d1Sql = `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders})`;
      if (after !== undefined) { d1Sql += ` AND created_at >= ?`; d1Bindings.push(after); }
      if (before !== undefined) { d1Sql += ` AND created_at <= ?`; d1Bindings.push(before); }
      const { results: d1Rows } = await env.DB.prepare(d1Sql).bind(...d1Bindings).all() as { results: Record<string, any>[] };

      const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));

      const text = deduped.map((m, i) => {
        const meta = m.metadata as Record<string, any>;
        const parentId = (meta?.parentId ?? m.id) as string;
        const row = d1Map.get(parentId);
        const score = (m.score * 100).toFixed(0);
        const updateLabel = meta?.isUpdate ? " [updated]" : "";

        if (row) {
          const date = new Date(row.created_at as number).toLocaleDateString();
          const tags: string[] = JSON.parse(row.tags ?? "[]");
          const tagList = tags.length ? ` [${tags.join(", ")}]` : "";
          const src = row.source ? ` · ${row.source}` : "";
          return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}\n${row.content}`;
        }

        // Fallback to metadata if D1 row not found (shouldn't happen)
        const date = meta?.created_at ? new Date(meta.created_at as number).toLocaleDateString() : "?";
        const tagList = Array.isArray(meta?.tags) && meta.tags.length ? ` [${(meta.tags as string[]).join(", ")}]` : "";
        const src = meta?.source ? ` · ${meta.source}` : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}\n${meta?.content ?? ""}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── list_recent ──────────────────────────────────────────────────────────
  server.tool(
    "list_recent",
    "list_recent: List the most recent entries by date from your second brain. Use when you need to browse recent entries or find an entry ID. Not the same as recall — returns entries by time, not by meaning.",
    {
      n: z.number().int().min(1).max(50).default(10),
      tag: z.string().optional(),
      after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
      before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
    },
    async ({ n, tag, after, before }) => {
      const conds: string[] = [];
      const p: (string | number)[] = [];
      if (tag) { conds.push(`tags LIKE ?`); p.push(`%"${tag}"%`); }
      if (after !== undefined) { conds.push(`created_at >= ?`); p.push(after); }
      if (before !== undefined) { conds.push(`created_at <= ?`); p.push(before); }
      let q = `SELECT id, content, tags, source, created_at FROM entries`;
      if (conds.length) q += ` WHERE ` + conds.join(` AND `);
      q += ` ORDER BY created_at DESC LIMIT ?`; p.push(n);

      const { results } = await env.DB.prepare(q).bind(...p).all();

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
  server.tool(
    "forget",
    "Permanently delete an entry from your second brain by ID. Only call when the user explicitly asks to delete something. Confirm the entry ID using recall or list_recent first. This action cannot be undone.",
    { id: z.string().describe("Entry ID from recall or list_recent") },
    async ({ id }) => {
      // Fetch tracked vector IDs before deleting the D1 row
      const row = await env.DB.prepare(
        `SELECT vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      const vectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");

      await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

      try {
        if (vectorIds.length) {
          // Delete exact IDs — no guessing, no leaks
          await env.VECTORIZE.deleteByIds(vectorIds);
        }
      } catch (e) {
        console.error("Vectorize delete failed (non-fatal):", e);
      }

      return { content: [{ type: "text", text: `Deleted entry ${id} and ${vectorIds.length} vector(s)` }] };
    }
  );

  return server;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    ctx.waitUntil(initializeDatabase(env));

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // POST /capture
    if (url.pathname === "/capture" && request.method === "POST") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

      let body: { content?: string; tags?: string[]; source?: string };
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!body.content?.trim()) return json({ error: "content is required" }, 400);

      const c = body.content.trim();
      const t = body.tags ?? [];
      const s = body.source ?? "api";

      const dup = await checkDuplicate(c, env);

      if (dup.status === "blocked") {
        return json({
          ok: false,
          duplicate: true,
          matchId: dup.matchId,
          score: parseFloat((dup.score * 100).toFixed(1)),
          message: "Near-exact duplicate detected — not stored",
        });
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const finalTags = dup.status === "flagged" ? [...t, "duplicate-candidate"] : t;

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(finalTags), s, now, "[]").run();

      ctx.waitUntil(
        storeEntry(env, id, c, finalTags, s, now)
          .catch((e) => console.error("Async embed failed:", e))
      );

      if (dup.status === "flagged") {
        return json({
          ok: true,
          id,
          warning: "similar",
          matchId: dup.matchId,
          score: parseFloat((dup.score * 100).toFixed(1)),
          message: "Stored but similar entry exists — tagged as duplicate-candidate",
        });
      }

      return json({ ok: true, id });
    }

    // POST /append
    if (url.pathname === "/append" && request.method === "POST") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

      let body: { id?: string; addition?: string };
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ error: "id is required" }, 400);
      if (!body.addition?.trim()) return json({ error: "addition is required" }, 400);

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

    // GET /tags
    if (url.pathname === "/tags" && request.method === "GET") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
      ).all();
      return json((results as any[]).map(r => r.value as string));
    }

    // GET /list
    if (url.pathname === "/list" && request.method === "GET") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const n = Math.min(parseInt(url.searchParams.get("n") ?? "20", 10), 100);
      const { results } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries ORDER BY created_at DESC LIMIT ?`
      ).bind(n).all();
      return json(results);
    }

    // /mcp
    if (url.pathname === "/mcp") {
      // Create a new server instance per request (required for security)
      const server = buildMcpServer(env);

      // Use Cloudflare's recommended handler
      return createMcpHandler(server)(request, env, ctx);
    }

    // POST /chat
    if (url.pathname === "/chat" && request.method === "POST") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

      let body: { query?: string; memories?: string };
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!body.query?.trim()) return json({ error: "query is required" }, 400);

      const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided. Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories. Be concise.`;

      const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;

      // Workers AI requires `as any` here — the SDK types don't cover all models
      const stream = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct" as any, {
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

    return new Response("Not found", { status: 404 });
  },
};