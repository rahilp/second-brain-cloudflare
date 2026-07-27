import type { Env } from "../env";
import { LLM_MODEL, INSIGHT_MAX_TOKENS } from "../constants";
import { readStreamText } from "../lib/ai";

export async function synthesizeInsight(
  query: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
    .join("\n\n");

  const prompt = `You are a second brain assistant. Summarize what the user's stored memories below say in relation to their query. Base the insight ONLY on these memories.

Query: "${query}"

Memories:
${memoriesList}

Rules:
- Use ONLY the information in the memories above. Do not add, infer, guess, or speculate, and do not use hedging language like "might" or "it seems".
- These memories are a retrieved subset, not the user's full memory store. Never say that information is missing, unavailable, or does not exist.
- If the memories don't address the query, briefly state only what they do contain.

Write a brief insight (2-4 sentences).`;

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
