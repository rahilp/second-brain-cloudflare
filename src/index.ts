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

// ─── Chunking ─────────────────────────────────────────────────────────────────
// Splits long text into overlapping segments so each gets a clean embedding.
// Short content (under ~400 tokens / 1600 chars) is returned as a single chunk.

function chunkText(text: string, maxChars = 1600, overlapChars = 200): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end < text.length) {
      // Prefer breaking at sentence or newline boundary
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

// ─── Store entry with chunked embeddings ──────────────────────────────────────

async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number
): Promise<void> {
  const chunks = chunkText(content);

  // If single chunk, use the entry ID directly (backwards compatible)
  // If multiple chunks, use `{id}-chunk-{i}` so recall can deduplicate
  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => ({
      id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
      values: await embed(chunk, env),
      metadata: {
        content: chunk.slice(0, 512), // Vectorize metadata limit
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
      const id = crypto.randomUUID();
      const now = Date.now();
      const c = content.trim();
      const t = tags ?? [];
      const s = source ?? "claude";

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(t), s, now).run();

      try {
        await storeEntry(env, id, c, t, s, now);
      } catch (e) {
        console.error("Vectorize insert failed (non-fatal):", e);
      }

      return { content: [{ type: "text", text: `Stored. ID: ${id}` }] };
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
        topK: topK * 3, // Fetch extra to account for chunk deduplication
        filter: tag ? { tags: { $eq: tag } } : undefined,
        returnMetadata: "all",
      });

      if (!results.matches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      // Deduplicate by parentId — only return the best chunk per entry
      const seen = new Set<string>();
      const deduped = results.matches.filter((m) => {
        const parentId = (m.metadata as any)?.parentId ?? m.id;
        if (seen.has(parentId)) return false;
        seen.add(parentId);
        return true;
      }).slice(0, topK);

      const text = deduped.map((m, i) => {
        const meta = m.metadata as Record<string, any>;
        const date = meta?.created_at
          ? new Date(meta.created_at as number).toLocaleDateString()
          : "?";
        const tagList = Array.isArray(meta?.tags) && meta.tags.length
          ? ` [${(meta.tags as string[]).join(", ")}]`
          : "";
        const src = meta?.source ? ` · ${meta.source}` : "";
        const score = (m.score * 100).toFixed(0);
        const chunks = meta?.totalChunks > 1 ? ` (chunk ${meta.chunkIndex + 1}/${meta.totalChunks})` : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${chunks}\n${meta?.content ?? ""}`;
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

      // Delete all chunks for this entry
      try {
        const chunkIds = Array.from({ length: 20 }, (_, i) => `${id}-chunk-${i}`);
        await env.VECTORIZE.deleteByIds([id, ...chunkIds]);
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // POST /capture — intake from bookmarklet, iOS Shortcuts, scripts
    if (url.pathname === "/capture" && request.method === "POST") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

      let body: { content?: string; tags?: string[]; source?: string };
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!body.content?.trim()) return json({ error: "content is required" }, 400);

      const id = crypto.randomUUID();
      const now = Date.now();
      const c = body.content.trim();
      const t = body.tags ?? [];
      const s = body.source ?? "api";

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(t), s, now).run();

      // Embed and chunk in background — capture response is instant
      ctx.waitUntil(
        storeEntry(env, id, c, t, s, now)
          .catch((e) => console.error("Async embed failed:", e))
      );

      return json({ ok: true, id });
    }

    // GET /list — debug / review endpoint
    if (url.pathname === "/list" && request.method === "GET") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const n = Math.min(parseInt(url.searchParams.get("n") ?? "20", 10), 100);
      const { results } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries ORDER BY created_at DESC LIMIT ?`
      ).bind(n).all();
      return json(results);
    }

    // /mcp — MCP server for Claude Desktop, Claude Code, claude.ai, ChatGPT
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