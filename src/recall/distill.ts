import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import {
  KEYWORD_MIN_TOKEN_LEN,
  KEYWORD_STOPWORDS,
  MAX_QUERY_TERMS,
  QUERY_SATURATION_FRACTION,
} from "../constants";
import { readStreamText } from "../lib/ai";
import { extractHashtags } from "../text/hashtags";

export async function inferQueryTags(query: string, env: Env, config: Readonly<Config> = DEFAULTS): Promise<string[]> {
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
    const stream = await env.AI.run(config.LLM_MODEL as any, {
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

export async function distillToRareTerms(query: string, env: Env, config: Readonly<Config> = DEFAULTS): Promise<string> {
  const words = query.split(/\s+/).filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/^[^\w#.]+|[^\w#.]+$/g, "");
  const content = words.filter(w => {
    const n = norm(w);
    return n.length >= KEYWORD_MIN_TOKEN_LEN && !KEYWORD_STOPWORDS.has(n);
  });
  if (content.length <= 1) return content.length ? content.join(" ") : query;

  const uniq = [...new Set(content.map(norm))].slice(0, 16);
  try {
    const sums = uniq.map((_, i) => `SUM(CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS d${i}`).join(", ");
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total, ${sums} FROM entries`)
      .bind(...uniq.map(t => `%${t}%`)).first() as Record<string, number> | null;
    if (!row || !row.total) return content.join(" ");
    const total = row.total;
    const df = new Map(uniq.map((t, i) => [t, (row[`d${i}`] as number) ?? 0]));
    let candidates = uniq.filter(t => (df.get(t) ?? 0) / total <= QUERY_SATURATION_FRACTION);
    if (!candidates.length) candidates = uniq;
    const keep = new Set(
      [...candidates].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, MAX_QUERY_TERMS)
    );
    const rebuilt = [...new Set(content.filter(w => keep.has(norm(w))))];
    return rebuilt.length ? rebuilt.join(" ") : content.join(" ");
  } catch {
    return content.join(" ");
  }
}
