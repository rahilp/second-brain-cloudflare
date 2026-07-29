import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { CLASSIFY_MAX_TOKENS, LLM_MODEL } from "../constants";
import { readStreamText } from "../lib/ai";
import { withKind, type MemoryKind } from "../memory/kind";
import { getStatus, withStatus } from "../memory/status";

function normalizeKind(raw: unknown): MemoryKind | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (/episod|event|decision|milestone|occurrence/.test(v)) return "episodic";
  if (/semantic|fact|preference|knowledge|belief/.test(v)) return "semantic";
  return null;
}

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
    } catch { /* fall through */ }
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

export async function classifyEntry(content: string, env: Env, config: Readonly<Config> = DEFAULTS): Promise<{ importance: number; canonical: boolean; kind: MemoryKind | null }> {
  let text: string;
  try {
    const stream = await env.AI.run(config.LLM_MODEL as any, {
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

export function scheduleClassifyAndTag(entryId: string, content: string, env: Env, ctx: ExecutionContext): void {
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
