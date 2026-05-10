/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
  const result = (await env.AI.run("@cf/baai/bge-small-en-v1.5" as any, { text: [text] })) as any;
  return result.data[0] as number[];
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

type DuplicateResult =
  | { status: "unique" }
  | { status: "blocked"; matchId: string; score: number }
  | { status: "flagged"; matchId: string; score: number };

async function checkDuplicate(content: string, env: Env): Promise<DuplicateResult> {
  const values = await embed(content.slice(0, 500), env);
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

function chunkText(text: string, maxChars = 1600, overlapChars = 200): string[] {
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

// ─── Store entry (full embed + chunk) ────────────────────────────────────────

async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number
): Promise<void> {
  const chunks = chunkText(content);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => ({
      id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
      values: await embed(chunk, env),
      metadata: {
        content: chunk.slice(0, 512),
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
      },
    }))
  );

  await env.VECTORIZE.insert(vectors);
}

// ─── Append to existing entry ─────────────────────────────────────────────────
// Updates D1 with the full appended content, then adds only the new addition
// as a new Vectorize chunk pointing to the same parent ID.

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

  // Count existing chunks so we don't collide on IDs
  // Vectorize doesn't have a list-by-prefix API so we track via D1
  // We store chunk count in a simple way: try IDs until we find a gap
  let chunkIndex = 0;
  // Find next available chunk index by checking if base ID exists
  // For single-chunk entries the base ID is used directly, so start at 1
  // For multi-chunk entries, chunks are {id}-chunk-0, {id}-chunk-1, etc.
  // We add the new addition chunk at the next available index
  // Safe approach: use timestamp-based suffix to guarantee uniqueness
  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env);
  await env.VECTORIZE.insert([{
    id: newChunkId,
    values,
    metadata: {
      content: addition.slice(0, 512),
      parentId: id,
      chunkIndex: chunkIndex,
      totalChunks: 1,
      isUpdate: true,
      tags,
      source,
      created_at: Date.now(),
    },
  }]);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.0.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store an idea, task, or note in your second brain",
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
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(finalTags), s, now).run();

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
    "Append new information to an existing entry in your second brain. Use this when something has changed or you have an update to a stored note — preserves the original and adds the update with a timestamp.",
    {
      id: z.string().describe("Entry ID to append to — from recall or list_recent"),
      addition: z.string().describe("The new information to add to the existing entry"),
    },
    async ({ id, addition }) => {
      // Look up the existing entry
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
    "Semantically search your second brain for relevant notes",
    {
      query: z.string().describe("Natural language search query"),
      topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
      tag: z.string().optional().describe("Filter by a specific tag"),
    },
    async ({ query, topK, tag }) => {
      const values = await embed(query, env);
      const results = await env.VECTORIZE.query(values, {
        topK: topK * 3,
        filter: tag ? { tags: { $eq: tag } } : undefined,
        returnMetadata: "all",
      });

      if (!results.matches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      const seen = new Set<string>();
      const deduped = results.matches.filter((m) => {
        const parentId = (m.metadata as any)?.parentId ?? m.id;
        if (seen.has(parentId)) return false;
        seen.add(parentId);
        return true;
      }).slice(0, topK);

      const text = deduped.map((m, i) => {
        const meta = m.metadata as Record<string, any>;
        const date = meta?.created_at ? new Date(meta.created_at as number).toLocaleDateString() : "?";
        const tagList = Array.isArray(meta?.tags) && meta.tags.length ? ` [${(meta.tags as string[]).join(", ")}]` : "";
        const src = meta?.source ? ` · ${meta.source}` : "";
        const score = (m.score * 100).toFixed(0);
        const chunkLabel = meta?.totalChunks > 1 ? ` (chunk ${meta.chunkIndex + 1}/${meta.totalChunks})` : "";
        const updateLabel = meta?.isUpdate ? " [updated]" : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${chunkLabel}${updateLabel}\n${meta?.content ?? ""}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── list_recent ──────────────────────────────────────────────────────────
  server.tool(
    "list_recent",
    "List the most recent entries from your second brain",
    {
      n: z.number().int().min(1).max(50).default(10),
      tag: z.string().optional(),
    },
    async ({ n, tag }) => {
      let q = `SELECT id, content, tags, source, created_at FROM entries`;
      const p: (string | number)[] = [];
      if (tag) { q += ` WHERE tags LIKE ?`; p.push(`%"${tag}"%`); }
      q += ` ORDER BY created_at DESC LIMIT ?`; p.push(n);

      const { results } = await env.DB.prepare(q).bind(...p).all();

      if (!results.length) {
        return { content: [{ type: "text", text: "No entries found." }] };
      }

      const text = (results as Record<string, any>[]).map((row, i) => {
        const date = new Date(row.created_at as number).toLocaleDateString();
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        const tagStr = tags.length ? ` · ${tags.join(", ")}` : "";
        return `${i + 1}. [${date} · ${row.source}${tagStr}] ${(row.id as string).slice(0, 8)}\n${row.content}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── forget ───────────────────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete an entry from your second brain by ID",
    { id: z.string().describe("Entry ID from recall or list_recent") },
    async ({ id }) => {
      await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

      try {
        const chunkIds = Array.from({ length: 20 }, (_, i) => `${id}-chunk-${i}`);
        await env.VECTORIZE.deleteByIds([id, ...chunkIds]);
        // Also attempt to delete any update chunks
        const updateIds = Array.from({ length: 50 }, (_, i) => `${id}-update-${i}`);
        await env.VECTORIZE.deleteByIds(updateIds);
      } catch (e) {
        console.error("Vectorize delete failed (non-fatal):", e);
      }

      return { content: [{ type: "text", text: `Deleted entry ${id}` }] };
    }
  );

  return server;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(finalTags), s, now).run();

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
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = buildMcpServer(env);
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
};