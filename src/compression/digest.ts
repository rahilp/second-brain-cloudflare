import type { Env } from "../env";
import { DEFAULTS, resolveConfig, type Config } from "../config";
import { captureEntry } from "../capture/entry";
import { DIGEST_MAX_TOKENS, LLM_MODEL } from "../constants";
import { readStreamText } from "../lib/ai";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import {
  compressionEligibilitySql,
  isTopicTag,
} from "./eligibility";

export async function synthesizeDigest(
  tag: string,
  rows: { id: string; content: string }[],
  env: Env,
  config: Readonly<Config> = DEFAULTS
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
    const stream = await (env.AI as any).run(config.LLM_MODEL as any, {
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

/**
 * Mark the entries a digest was built from, so they stop being eligible for compression.
 *
 * One statement per source used to be issued serially, which was roughly 88% of the whole
 * nightly cron's D1 cost — all four jobs share one invocation and therefore one subrequest
 * budget (#278). A batch is a single subrequest whatever it carries.
 *
 * batch() is atomic, and that matters more than it looks here: the digest entry has already
 * been written by this point, so a source that misses its `rolled-up` mark stays eligible
 * and gets compressed again on a later night, producing a duplicate digest. Letting one bad
 * row roll back the whole batch would turn one duplicate into a tag's worth, so a failed
 * batch falls back to per-row writes — the behaviour this replaced, at the cost it used to
 * pay, on the path that used to be the only path.
 */
async function markSourcesRolledUp(env: Env, ids: string[], digestId: string): Promise<void> {
  if (!ids.length) return;
  const note = `\n\n[Digest: ${digestId}]`;
  const mark = (id: string) => env.DB.prepare(
    `UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content || ? WHERE id = ?`
  ).bind(note, id);

  try {
    await env.DB.batch(ids.map(mark));
  } catch (e) {
    console.error("Batched rolled-up mark failed; retrying per row (non-fatal):", e);
    for (const id of ids) {
      try {
        await mark(id).run();
      } catch (err) {
        console.error(`Failed to update source entry ${id} (non-fatal):`, err);
      }
    }
  }
}

export async function compressTag(
  tag: string,
  env: Env,
  ctx: ExecutionContext
): Promise<{ synthesizedId: string | null; entriesUsed: number; text: string }> {
  // Guard before resolveConfig: that is a KV read, and a system tag never compresses, so
  // paying for it first is a wasted subrequest per skipped tag per night. The candidate
  // query excludes these already; this is the backstop for a tag arriving another way, and
  // GET /digest?tag= hands this function an arbitrary user string. isTopicTag rather than
  // isReservedTag, because the bookkeeping tags are not "reserved" but are just as
  // destructive to compress: `duplicate-candidate` has no row-level exclusion either.
  if (!isTopicTag(tag)) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }
  const cfg = await resolveConfig(env);

  const recentSynth = await env.DB.prepare(`
    SELECT id FROM entries
    WHERE tags LIKE '%"synthesized"%'
      AND tags LIKE ? ${TAG_LIKE_ESCAPE}
      AND created_at > ?
    LIMIT 1
  `).bind(tagLikePattern(tag), Date.now() - 86400000).first();

  if (recentSynth) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const { results: rawEntries } = await env.DB.prepare(`
    SELECT id, content FROM entries
    WHERE tags LIKE ? ${TAG_LIKE_ESCAPE}
      AND tags NOT LIKE '%"synthesized"%'
      AND tags NOT LIKE '%"auto-pattern"%'
      AND tags NOT LIKE '%"rolled-up"%'
      AND ${compressionEligibilitySql("", cfg)}
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(tagLikePattern(tag), Date.now() - cfg.COMPRESSION_MIN_AGE_MS).all();

  if (rawEntries.length < 10) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const rows = rawEntries.map(r => ({ id: r.id as string, content: r.content as string }));
  const text = await synthesizeDigest(tag, rows, env, cfg);
  if (!text) return { synthesizedId: null, entriesUsed: 0, text: "" };

  const content = `[Synthesized from ${rows.length} entries tagged "${tag}"]\n\n${text}`;
  const result = await captureEntry(content, ["synthesized", tag], "system", env, ctx);

  if (result.status !== "stored") {
    return { synthesizedId: null, entriesUsed: 0, text };
  }

  await markSourcesRolledUp(env, rows.map(r => r.id), result.id);

  return { synthesizedId: result.id, entriesUsed: rows.length, text };
}
