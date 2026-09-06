import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { EMBEDDING_MODEL } from "../constants";

export function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

/**
 * Workers AI streams two different answer shapes depending on model lineage.
 * Llama-family models (the shipped default) put the text directly on
 * `response`. OpenAI-lineage models (`@cf/openai/gpt-oss-*`) stream an
 * OpenAI-style chat-completion delta instead, under `choices[0].delta.content`
 * — and the reasoning ones in that family emit chain-of-thought first, as
 * `delta.reasoning` / `delta.reasoning_content`, before any `delta.content`.
 * That chain-of-thought is deliberately never returned here: every caller of
 * `readStreamText` treats the result as the answer — JSON.parse'ing it or
 * feeding it straight into a digest — not as reasoning prose.
 *
 * POST /chat (src/routes/recall.ts) is the one caller that does NOT go
 * through `readStreamText` — it streams the raw Workers AI response
 * straight to the browser, so public/js/recall.js hand-mirrors this exact
 * function (extractChatChunkText) and the buffering below it. Keep the two
 * in sync: a change here is a prompt to check there, and vice versa.
 */
function extractChunkText(d: any): string {
  if (d?.response) return d.response;
  const content = d?.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

function consumeSseLine(line: string, onText: (chunk: string) => void): void {
  if (!line.startsWith("data: ") || line.includes("[DONE]")) return;
  try {
    const d = JSON.parse(line.slice(6));
    const text = extractChunkText(d);
    if (text) onText(text);
  } catch (e) {
    // A parse failure here is on a COMPLETE line (buffering already held back
    // any partial one), so it's a genuine anomaly rather than a chunk-boundary
    // artifact — worth a log, but it must not interrupt the stream: dropping
    // one malformed SSE line is far better than losing everything read so far.
    console.error("readStreamText: malformed SSE line (non-fatal):", e);
  }
}

export async function readStreamText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // { stream: true } holds back a trailing partial multi-byte sequence
    // until the bytes that complete it arrive in the next chunk.
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // The last element is either "" (buffer ended on a newline) or an
    // incomplete line — either way it isn't a complete line yet, so it stays
    // buffered for the next read rather than being parsed now.
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeSseLine(line, chunk => { text += chunk; });
  }
  // Flush any bytes the decoder was holding back for a not-yet-complete
  // multi-byte character.
  buffer += decoder.decode();
  reader.releaseLock();
  // The stream may end without a trailing newline after its last line —
  // process whatever is left in the buffer rather than dropping it.
  if (buffer) consumeSseLine(buffer, chunk => { text += chunk; });
  return text;
}

export async function embed(
  text: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<number[]> {
  // bge-m3 rejects input past its token limit unless told to truncate; the
  // bge-en models have no such switch and reject unknown fields. Applied as a
  // defensive default (controller ruling) — live measurement against
  // Workers AI wasn't possible in the environment that authored this; see
  // the #326 spec, §10.6.
  const input = config.EMBEDDING_MODEL === "@cf/baai/bge-m3"
    ? { text: [text], truncate_inputs: true }
    : { text: [text] };
  // Workers AI requires `as any` here — the SDK types don't cover all models
  const result = (await env.AI.run(config.EMBEDDING_MODEL as any, input as any)) as any;
  return result.data[0] as number[];
}
