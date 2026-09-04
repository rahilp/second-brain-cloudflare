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

/** The write half of classification, shared by both schedulers below. */
async function applyClassification(
  entryId: string,
  env: Env,
  { importance, canonical, kind }: { importance: number; canonical: boolean; kind: MemoryKind | null },
): Promise<void> {
  await env.DB.prepare(`UPDATE entries SET importance_score = ? WHERE id = ?`).bind(importance, entryId).run();
  if (!kind && !canonical) return;
  // scope-exempt: by-id: the entry this background pass was queued for
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(entryId).first() as Record<string, any> | null;
  if (!row) return;
  let tags: string[] = JSON.parse(row.tags ?? "[]");
  if (kind) tags = withKind(tags, kind);
  if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
  await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), entryId).run();
}

export function scheduleClassifyAndTag(
  entryId: string,
  content: string,
  env: Env,
  ctx: ExecutionContext,
  config: Readonly<Config> = DEFAULTS,
): void {
  ctx.waitUntil(
    classifyEntry(content, env, config)
      .then(c => applyClassification(entryId, env, c))
      .catch(e => console.error("Classification failed (non-fatal):", e))
  );
}

/**
 * Classify, then infer edges with the kind that classification just produced.
 *
 * One `classifyEntry` call feeding both halves, not two: the kind an edge type
 * needs to gate on is the same kind the tagger writes, and asking twice would
 * add a model call per capture to learn something already known.
 *
 * Inference runs whatever classification did. A failed or unparseable
 * classification degrades to `kind: null`, which costs the capture its typed
 * edge and nothing else — the generic edge is still drawn. Losing the graph
 * write because the classifier was unavailable would be a much worse trade.
 */
export function classifyThenInfer(
  entryId: string,
  content: string,
  env: Env,
  ctx: ExecutionContext,
  config: Readonly<Config>,
  infer: (kind: MemoryKind | null) => Promise<void>,
): void {
  ctx.waitUntil(
    classifyEntry(content, env, config)
      .then(async c => { await applyClassification(entryId, env, c); return c.kind; })
      .catch(e => { console.error("Classification failed (non-fatal):", e); return null; })
      .then(kind => infer(kind).catch(e => console.error("Edge inference failed (non-fatal):", e)))
  );
}
