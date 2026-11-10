import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import {
  // Write-path only and deliberately not exposed as a setting (#245): recall
  // applies no minimum-score cutoff, so surfacing this would imply a recall
  // control that does not exist.
  CANDIDATE_SCORE_THRESHOLD,
  WRITE_PATH_TOPK,
  CONTRADICTION_MAX_TOKENS,
  SMART_MERGE_MAX_TOKENS,
  VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY,
} from "../constants";
import { embed, readStreamText } from "../lib/ai";
import { excludeHeld } from "../quarantine/tags";
import { nearestParents } from "../vectorize/parents";
import { queryVectorizeScoped, singleWorkspaceFilter } from "../vectorize/scope";

type DuplicateResult =
  | { status: "unique" }
  | { status: "blocked"; matchId: string; score: number }
  | { status: "flagged"; matchId: string; score: number };

interface ContradictionResult {
  detected: boolean;
  conflicting_id?: string;
  reason?: string;
}

export type MergeAction =
  | { action: "keep_both" }
  | { action: "replace"; target_id: string }
  | { action: "merge"; target_id: string; merged_content: string };

export function getDuplicateCheckSample(content: string): string {
  if (content.length <= 1500) return content;

  const start = content.slice(0, 500);
  const midIndex = Math.floor(content.length / 2);
  const middle = content.slice(midIndex - 250, midIndex + 250);
  const end = content.slice(-500);

  return `${start}\n...\n${middle}\n...\n${end}`;
}

export async function checkDuplicateAndContradiction(
  content: string,
  env: Env,
  config: Readonly<Config> = DEFAULTS,
  workspaceId?: string,
  // Optional so every existing direct caller (tests, and any future internal
  // caller) stays callable without one. Threaded through only to hand
  // queryVectorizeScoped a fire-and-forget KV write on filter degradation —
  // src/vectorize/scope.ts itself stays env-free.
  ctx?: { waitUntil(promise: Promise<unknown>): void },
  opts: {
    /**
     * A held write (16-t3-t4-trust-spec.md 5.4 W-a, P6): duplicate flagging still runs (the
     * embed and Vectorize query above are unconditional), but no model call is made, so a
     * planted note can never talk its way into a merge or a contradiction verdict.
     */
    skipModelCall?: boolean;
  } = {},
): Promise<{
  duplicate: DuplicateResult;
  contradiction: ContradictionResult;
  mergeAction: MergeAction | null;
  neighbors: { id: string; score: number }[];
}> {
  const sample = getDuplicateCheckSample(content);
  const values = await embed(sample, env, config);

  // Duplicate detection, contradiction detection and neighbour edges are all
  // advisory — a capture without them is still correct, just less enriched. This
  // runs before the D1 insert, so throwing here rejected the write entirely (#270)
  // on deployments the read path already serves keyword-only (recall/search.ts).
  let matches: VectorizeMatch[] = [];
  try {
    let hits: VectorizeMatch[];
    if (workspaceId !== undefined) {
      // Dedupe/contradiction compare against the WRITE TARGET's workspace only:
      // a private note must not collide with a colleague's shared one, and
      // vice versa. Falls back to unfiltered when Vectorize rejects the filter.
      const onDegrade = ctx
        ? () => ctx.waitUntil(
            env.OAUTH_KV.put(VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY, String(Date.now()))
              .catch((e: unknown) => console.error("Vectorize filter-degradation marker write failed (non-fatal):", e)),
          )
        : undefined;
      let degraded: boolean;
      ({ matches: hits, degraded } = await queryVectorizeScoped<VectorizeMatch>(
        env.VECTORIZE, values, { topK: WRITE_PATH_TOPK, filter: singleWorkspaceFilter(workspaceId).filter, onDegrade },
      ));
      // Unfiltered, other workspaces' vectors would take the nearest slots before the
      // scoped read below can drop them. An unstamped vector is left for that read to decide.
      if (degraded) hits = hits.filter(h => {
        const ws = (h.metadata as any)?.workspace_id;
        return ws === undefined || ws === null || ws === workspaceId;
      });
    } else {
      ({ matches: hits } = await env.VECTORIZE.query(values, { topK: WRITE_PATH_TOPK, returnMetadata: "all" }));
    }
    // One long note is several vectors; keep the best hit of each of the five nearest distinct notes.
    matches = nearestParents(hits);
  } catch (e) {
    console.error("Vectorize query failed (capturing without duplicate/contradiction checks):", e);
  }

  const neighborScores = new Map<string, number>();
  for (const m of matches) {
    const pid = (m.metadata as any)?.parentId ?? m.id;
    neighborScores.set(pid, Math.max(neighborScores.get(pid) ?? 0, m.score));
  }
  let neighbors = [...neighborScores.entries()].map(([id, score]) => ({ id, score }));

  // Superseded rows are history (T-0089.2.1): never a duplicate to block on, a merge target or a
  // contradiction candidate, or "I moved back to Denver" would collide with the old Denver row
  // instead of replacing Austin. One read of the candidate rows, the same statement the candidate
  // path below always issued; it now runs before the duplicate verdict too.
  const writerWorkspaceId = workspaceId ?? "";
  const readThreshold = Math.min(CANDIDATE_SCORE_THRESHOLD, config.DUPLICATE_FLAG_THRESHOLD, config.DUPLICATE_BLOCK_THRESHOLD);
  const readIds = [...new Set(matches.filter(m => m.score >= readThreshold).map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  let candidateRows: { id: string; content: string }[] = [];
  const superseded = new Set<string>();
  // Ids of the matches the writer's workspace actually holds, held rows included.
  const readable = new Set<string>();
  if (readIds.length) {
    const now = Date.now();
    const placeholders = readIds.map(() => "?").join(", ");
    // Scoped, not by-id-exempt: see the comment on the candidate prompt below.
    // validity: current: superseded rows are dropped in JS below, from the candidates and from the duplicate verdict
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, valid_until FROM entries WHERE id IN (${placeholders}) AND +workspace_id = ?`
    ).bind(...readIds, writerWorkspaceId).all() as { results: { id: string; content: string; tags: string; valid_until: number | null }[] };
    // Codex review class E (T-0089.4.2): Vectorize's stale vector for a row held AFTER it was
    // embedded can still surface here as a "match" — this read is what actually keeps a held
    // neighbor's content out of the merge/contradiction prompt below, not the vector query.
    for (const r of results ?? []) readable.add(r.id);
    for (const r of excludeHeld(results ?? [])) {
      if (r.valid_until !== null && r.valid_until !== undefined && r.valid_until <= now) superseded.add(r.id);
      else candidateRows.push({ id: r.id, content: r.content });
    }
  }
  // An unfiltered fallback query can rank another member's memory first, and the
  // verdict below names its id back to the writer. Every match that could reach a
  // verdict (score >= readThreshold) must be a row the scoped read returned.
  matches = matches.filter(m => {
    const pid = (m.metadata as any)?.parentId ?? m.id;
    return !superseded.has(pid) && (m.score < readThreshold || readable.has(pid));
  });
  // Same rule for edge inference, which would refuse a foreign pair after it had taken a slot.
  neighbors = neighbors.filter(n => n.score < readThreshold || readable.has(n.id));

  let duplicate: DuplicateResult = { status: "unique" };
  if (matches.length) {
    const top = matches[0];
    const matchId = (top.metadata as any)?.parentId ?? top.id;
    if (top.score >= config.DUPLICATE_BLOCK_THRESHOLD) duplicate = { status: "blocked", matchId, score: top.score };
    else if (top.score >= config.DUPLICATE_FLAG_THRESHOLD) duplicate = { status: "flagged", matchId, score: top.score };
  }

  let contradiction: ContradictionResult = { detected: false };
  let mergeAction: MergeAction | null = null;

  if (duplicate.status !== "blocked" && !opts.skipModelCall) {
    const candidates = matches.filter(m => m.score >= CANDIDATE_SCORE_THRESHOLD);
    if (candidates.length) {
      const parentIds = new Set(candidates.map(m => (m.metadata as any)?.parentId ?? m.id));

      // Scoped, not by-id-exempt. src/lib/scope.ts licenses an unscoped by-id
      // lookup when the ids came from an already-scoped read; these came from a
      // Vectorize query, and its workspace filter is best-effort by contract
      // (src/vectorize/scope.ts degrades to an unfiltered query on a
      // filter-shaped rejection and latches that per isolate). In that degraded
      // mode the ids can name another member's entry — and this is not a
      // ranking list: `rows` becomes the merge/contradiction prompt, and
      // captureEntry rewrites whichever row the model names as the target. So
      // the predicate below is what actually keeps a colleague's memory out of
      // the prompt and their row out of the write.
      //
      // A predicate on the query that was already being issued, not a second
      // statement: capture is the hot path and this adds no subrequest. `?? ""`
      // is the pre-tenancy workspace, which is where an entry written without a
      // WriteContext lives, so a solo brain compares exactly the rows it did.
      // The rows were read above, before the duplicate verdict; the candidates are the
      // current ones among them, in the order the read returned them.
      const rows = candidateRows.filter(r => parentIds.has(r.id));

      if (rows.length) {
        // The ids the model is allowed to name back. `parentIds` is the raw
        // Vectorize answer and can still hold a row in another workspace when the
        // metadata filter degraded; `rows` is what survived the workspace
        // predicate above, which is also exactly what the prompt below shows.
        // Validating against the wider list would let a model that named an id it
        // was never shown reach captureEntry's by-id merge, which rewrites its
        // target — so the two lists must be the same list.
        const offeredIds = rows.map(r => r.id);
        const existingList = rows
          .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
          .join("\n\n");

        if (duplicate.status === "flagged") {
          const prompt = `You are deciding what to do with a new memory that is very similar to existing memories.

New memory: "${content}"

Similar existing memories:
${existingList}

Choose exactly one action. Prioritise in this order:
1. "contradiction" — new memory DIRECTLY CONFLICTS with an existing one (opposite location, reversed decision, changed fact). Include conflicting_id and reason.
2. "replace" — new memory clearly supersedes an existing one (updated version of the same fact, original is now stale). Include target_id.
3. "merge" — both memories are complementary and better as one combined entry. Include target_id and merged_content (max 400 chars).
4. "keep_both" — memories are different enough to coexist, or you are uncertain. This is the safe default.

Respond with JSON only. No text outside the JSON.
{"action":"keep_both"} OR {"action":"contradiction","conflicting_id":"<id>","reason":"<10 words max>"} OR {"action":"replace","target_id":"<id>"} OR {"action":"merge","target_id":"<id>","merged_content":"<text>"}`;

          try {
            const stream = await (env.AI as any).run(config.LLM_MODEL as any, {
              messages: [{ role: "user", content: prompt }],
              max_tokens: SMART_MERGE_MAX_TOKENS,
              stream: true,
            });
            const text = await readStreamText(stream as ReadableStream);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const action = parsed.action as string;

              if (action === "contradiction" && parsed.conflicting_id) {
                const validId = offeredIds.find(id => id === parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
              } else if (action === "replace" && parsed.target_id) {
                const validId = offeredIds.find(id => id === parsed.target_id);
                mergeAction = validId ? { action: "replace", target_id: validId } : { action: "keep_both" };
              } else if (action === "merge" && parsed.target_id && parsed.merged_content?.trim()) {
                const validId = offeredIds.find(id => id === parsed.target_id);
                mergeAction = validId
                  ? { action: "merge", target_id: validId, merged_content: parsed.merged_content.trim() }
                  : { action: "keep_both" };
              } else {
                mergeAction = { action: "keep_both" };
              }
            } else {
              mergeAction = { action: "keep_both" };
            }
          } catch {
            mergeAction = { action: "keep_both" };
          }
        } else {
          const prompt = `You are checking if a new memory contradicts existing memories.

New memory: "${content}"

Existing memories:
${existingList}

A contradiction means the new memory states something that DIRECTLY CONFLICTS with an existing memory — a different current location, reversed preference, changed decision, or updated fact. Partial overlaps, additions, or elaborations are NOT contradictions.

Respond with JSON only. No text outside the JSON object.
{"contradicts": false} OR {"contradicts": true, "conflicting_id": "<exact_id>", "reason": "<10 words max>"}`;

          try {
            const stream = await (env.AI as any).run(config.LLM_MODEL as any, {
              messages: [{ role: "user", content: prompt }],
              max_tokens: CONTRADICTION_MAX_TOKENS,
              stream: true,
            });
            const text = await readStreamText(stream as ReadableStream);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.contradicts && parsed.conflicting_id) {
                const validId = offeredIds.find(id => id === parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
              }
            }
          } catch {
            // non-fatal
          }
        }
      }
    }
  }

  return { duplicate, contradiction, mergeAction, neighbors };
}
