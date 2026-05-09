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

// ─── CORS headers included on every response ─────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

function isAuthorized(request: Request, env: Env): boolean {
  return request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

async function embed(text: string, env: Env): Promise<number[]> {
  const result = (await env.AI.run("@cf/baai/bge-small-en-v1.5" as any, { text: [text] })) as any;
  return result.data[0] as number[];
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.0.0" });

  server.tool(
    "remember",
    "Store an idea, task, or note in your second brain",
    {
      content: z.string(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
    },
    async ({ content, tags, source }) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      const c = content.trim();
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(tags ?? []), source ?? "claude", now).run();
      try {
        const values = await embed(c, env);
        await env.VECTORIZE.insert([{
          id,
          values,
          metadata: { content: c.slice(0, 512), tags: tags ?? [], source: source ?? "claude", created_at: now },
        }]);
      } catch (e) { console.error("Vectorize insert failed:", e); }
      return { content: [{ type: "text", text: `Stored. ID: ${id}` }] };
    }
  );

  server.tool(
    "recall",
    "Semantically search your second brain",
    {
      query: z.string(),
      topK: z.number().int().min(1).max(20).default(5),
      tag: z.string().optional(),
    },
    async ({ query, topK, tag }) => {
      const values = await embed(query, env);
      const results = await env.VECTORIZE.query(values, {
        topK,
        filter: tag ? { tags: { $eq: tag } } : undefined,
        returnMetadata: "all",
      });
      if (!results.matches.length) return { content: [{ type: "text", text: "Nothing found." }] };
      const text = results.matches.map((m, i) => {
        const meta = m.metadata as Record<string, any>;
        const date = meta?.created_at ? new Date(meta.created_at as number).toLocaleDateString() : "?";
        return `${i + 1}. [${date} · ${meta?.source ?? ""}] (${(m.score * 100).toFixed(0)}%)\n${meta?.content ?? ""}`;
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "list_recent",
    "List recent entries from your second brain",
    { n: z.number().int().min(1).max(50).default(10), tag: z.string().optional() },
    async ({ n, tag }) => {
      let q = `SELECT id, content, tags, source, created_at FROM entries`;
      const p: (string | number)[] = [];
      if (tag) { q += ` WHERE tags LIKE ?`; p.push(`%"${tag}"%`); }
      q += ` ORDER BY created_at DESC LIMIT ?`; p.push(n);
      const { results } = await env.DB.prepare(q).bind(...p).all();
      if (!results.length) return { content: [{ type: "text", text: "No entries found." }] };
      const text = (results as Record<string, any>[]).map((row, i) => {
        const date = new Date(row.created_at as number).toLocaleDateString();
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        return `${i + 1}. [${date} · ${row.source}${tags.length ? ` · ${tags.join(",")}` : ""}] ${(row.id as string).slice(0, 8)}\n${row.content}`;
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "forget",
    "Delete an entry by ID",
    { id: z.string() },
    async ({ id }) => {
      await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();
      try { await env.VECTORIZE.deleteByIds([id]); } catch (e) { console.error("Vectorize delete failed:", e); }
      return { content: [{ type: "text", text: `Deleted ${id}` }] };
    }
  );

  return server;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — must be first
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

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(body.tags ?? []), body.source ?? "api", now).run();

      // Embed in background — capture response is instant
      ctx.waitUntil(
        embed(c, env)
          .then((values) => env.VECTORIZE.insert([{
            id,
            values,
            metadata: { content: c.slice(0, 512), tags: body.tags ?? [], source: body.source ?? "api", created_at: now },
          }]))
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

    // /mcp — MCP server for Claude Desktop, Claude Code, claude.ai
    if (url.pathname === "/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = buildMcpServer(env);
      await server.connect(transport);

      const response = await transport.handleRequest(request);

      // Keep server alive until response body is fully consumed
      ctx.waitUntil(
        response.clone().text().finally(() => server.close())
      );

      return response;
    }

    return new Response("Not found", { status: 404 });
  },
};
