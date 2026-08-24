/**
 * Nightly candidate accrual.
 *
 * Search and reasoning are split because coverage, not token cost, is what
 * binds. A weekly job gets ~50 D1 subrequests, which buys about 25 Vectorize
 * seeds — 97 weeks to cross a 1,940-entry brain once. Accruing nightly from the
 * entries just written turns that into continuous coverage, and new entries are
 * where new tension appears: a memory written today is the one most likely to
 * contradict or extend something from March.
 *
 * Nothing here re-embeds. Vectors were written at capture time; this reads them.
 *
 * Neighbour dates, tags, content and importance come from D1, not Vectorize
 * metadata. Metadata is stamped when the vector is *written*, not when the
 * entry was created — an append re-embeds with `Date.now()` (see
 * src/capture/store.ts) — so an old memory that was touched recently would
 * report a false-recent date under metadata and fail the gap floor, silently
 * dropping exactly the long-lived entries most likely to have drifted.
 * `entries.created_at` is never rewritten after capture, so it is the only
 * value trusted for the gap, the eligibility check, and the importance term
 * `scoreCandidate` uses.
 */
import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { VECTORIZE_GET_BY_IDS_BATCH, D1_MAX_BOUND_PARAMS } from "../constants";
import { isInsightEligible, isAssistantAuthored } from "./eligibility";
import { MIN_GAP_MS, MIN_SIMILARITY, normalisePair, scoreCandidate, type ScorableEntry } from "./score";

/**
 * Authorship is a property of the PAIR, not the entry.
 *
 * An assistant's note connected to something the user wrote is a legitimate
 * insight and often the useful kind. Two assistant notes connected to each other
 * have no original in them: the result is a summary of summaries presented as an
 * observation about the user's thinking, which is how the Aug 16 run produced a
 * confidently-worded wrong detail.
 */
export function isEligiblePair(a: { tags: string[] }, b: { tags: string[] }): boolean {
  return !(isAssistantAuthored(a.tags) && isAssistantAuthored(b.tags));
}

/** Where accrual resumes from. Operational state, so KV rather than a column. */
export const ACCRUAL_CURSOR_KEY = "insight:accrual-cursor";

/**
 * Seeds per run. Each costs one Vectorize query, and the budget is 50
 * subrequests for the whole invocation. Measured at a full 25-seed batch
 * (steady-state, already-migrated schema): 1 schema probe + 1 seed select +
 * 2 getByIds batches + 25 queries + 1 D1 hydration lookup + 1 batched insert
 * + 1 supersedes select + 1 supersedes batched insert + 1 KV read + 1 KV
 * write is ~34-37 depending on how many distinct neighbours need hydrating
 * (chunked at D1_MAX_BOUND_PARAMS). See task-6-report.md for the measurement.
 */
export const ACCRUAL_SEED_LIMIT = 25;

/** Neighbours considered per seed. */
const NEIGHBOUR_TOP_K = 10;

interface SeedRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  importance_score: number | null;
  vector_ids: string;
  workspace_id: string;
}

/** A neighbour, hydrated live from D1 rather than trusted from vector metadata. */
interface NeighbourRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  importance_score: number | null;
  workspace_id: string;
}

/** The examined-so-far position. A keyset, not an offset — see `seedSql`. */
interface AccrualCursor {
  createdAt: number;
  id: string;
}

/**
 * Exported for src/insight/weekly.ts and src/routes/admin.ts's dry-run
 * endpoint, which both need to read `a.tags`/`b.tags` off a raw D1 row the
 * same way this module already does — one parser rather than a second
 * hand-written copy.
 */
export const parseTags = (raw: string): string[] => {
  try { return JSON.parse(raw ?? "[]"); } catch { return []; }
};

/**
 * A cursor written by an older shape, or hand-edited, or simply absent: all
 * treated as "start from the top" rather than trusting a position that cannot
 * be read. Restarting costs one more pass over already-seen rows; trusting a
 * bad cursor could skip entries silently, which is worse. Mirrors
 * `readMigration`'s tolerance in src/migration/embedding.ts.
 */
function parseCursor(raw: string | null): AccrualCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.createdAt === "number" && typeof parsed?.id === "string") {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // fall through to null
  }
  return null;
}

async function writeCursor(env: Env, row: { created_at: number; id: string }): Promise<void> {
  try {
    const cursor: AccrualCursor = { createdAt: row.created_at, id: row.id };
    await env.OAUTH_KV.put(ACCRUAL_CURSOR_KEY, JSON.stringify(cursor));
  } catch (e) {
    console.error("Insight accrual cursor write failed (non-fatal):", e);
  }
}

/**
 * Rows after the cursor, oldest first.
 *
 * Keyed on `(created_at, id)` rather than `created_at` alone: several entries
 * can share a millisecond timestamp — bulk imports and rapid captures produce
 * this routinely — and a single-column cursor that lands inside such a tie
 * group drops the rest of it permanently, since none of the remaining rows'
 * timestamps are ever greater than the cursor's. Matches
 * `src/migration/embedding.ts`'s `pageSql`, including the tie-break column.
 */
function seedSql(hasCursor: boolean): string {
  const where = hasCursor ? `WHERE created_at > ? OR (created_at = ? AND id > ?)` : "";
  // workspace_id rides along so a candidate pair can be kept inside one workspace:
  // accrual walks every workspace's rows (it is a maintenance pass), but a pair
  // spanning two workspaces would have the weekly pass reason over two people's
  // memories at once, so the cross-workspace match is dropped at pairing time below.
  return `SELECT id, content, tags, source, created_at, importance_score, vector_ids, workspace_id
            FROM entries
            ${where}
           ORDER BY created_at ASC, id ASC
           LIMIT ${ACCRUAL_SEED_LIMIT}`;
}

/**
 * What one accrual pass did. `seedsExamined` is the size of the window
 * pulled this pass (bounded by ACCRUAL_SEED_LIMIT) — every row looked at,
 * whether or not it turned out eligible — which is what `POST
 * /insights/accrue` (src/routes/admin.ts) reports back so a self-hoster
 * priming a large brain can tell the pass is making progress and knows when
 * to stop calling it (seedsExamined drops once the cursor reaches the end of
 * the table).
 */
export interface AccrualSummary {
  seedsExamined: number;
}

export async function runInsightAccrual(env: Env, ctx: ExecutionContext): Promise<AccrualSummary> {
  let seedsExamined = 0;
  try {
    await initializeDatabase(env);

    let cursor: AccrualCursor | null = null;
    try {
      cursor = parseCursor(await env.OAUTH_KV.get(ACCRUAL_CURSOR_KEY));
    } catch (e) {
      console.error("Insight accrual cursor read failed; starting from the top (non-fatal):", e);
    }

    // When there is no cursor yet, the same query walks forward from the
    // start, which is the backfill: on a quiet night it picks up historical
    // entries instead of doing nothing.
    const { results } = (
      cursor
        ? await env.DB.prepare(seedSql(true)).bind(cursor.createdAt, cursor.createdAt, cursor.id).all()
        : await env.DB.prepare(seedSql(false)).all()
    ) as { results: SeedRow[] };
    seedsExamined = results.length;

    const seeds = results.filter(r =>
      isInsightEligible({ content: r.content, tags: parseTags(r.tags), source: r.source })
      && parseTags(r.vector_ids).length > 0
    );

    if (!seeds.length) {
      // Every row in the window was examined and correctly rejected — none of
      // them qualified as a seed (too short, machine-tagged, no vector yet).
      // Unlike the vectorById case below, these rows WERE looked at, so
      // holding the cursor buys nothing: it would just re-read the same
      // rejected window every night, wedging accrual permanently.
      if (results.length) await writeCursor(env, results[results.length - 1]);
      return { seedsExamined };
    }

    const vectorById = new Map<string, number[]>();
    const headIdOf = new Map<string, string>();
    for (const seed of seeds) {
      const head = parseTags(seed.vector_ids)[0];
      if (head) headIdOf.set(seed.id, head);
    }

    const headIds = [...headIdOf.values()];
    for (let i = 0; i < headIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
      const batch = headIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH);
      const fetched = await env.VECTORIZE.getByIds(batch);
      for (const v of fetched as { id: string; values?: number[] }[]) {
        if (v.values) vectorById.set(v.id, v.values);
      }
    }

    // Nothing came back. That is not an error — an index still catching up
    // returns an empty array rather than throwing — but advancing the cursor
    // past seeds that were never examined would skip them permanently, which
    // is precisely what the cursor exists to prevent. Leave it and retry.
    if (!vectorById.size) return { seedsExamined };

    // Candidate neighbours, gathered across every seed before any of them is
    // trusted. Only two things are decided from the Vectorize match itself:
    // the parent id (identity, not subject to the metadata-staleness problem)
    // and the similarity score (Vectorize's own cosine distance, not derived
    // from anything written at a different time). Everything else about the
    // neighbour — is it the seed's own chunk aside, that's covered by parentId
    // — is decided after hydrating the real row from D1 below.
    const pending: { seed: SeedRow; parentId: string; similarity: number }[] = [];
    const neighbourIds = new Set<string>();

    for (const seed of seeds) {
      const head = headIdOf.get(seed.id);
      const values = head ? vectorById.get(head) : undefined;
      if (!values) continue;

      const { matches } = await env.VECTORIZE.query(values, {
        topK: NEIGHBOUR_TOP_K,
        returnMetadata: "all",
      });

      for (const match of matches) {
        const meta = (match.metadata ?? {}) as Record<string, any>;
        const parentId = (meta.parentId ?? match.id) as string;
        // Another chunk of the same entry is not a second memory. Decided
        // before paying for a D1 lookup that would only ever rehydrate the
        // seed's own row anyway (same id, same created_at — a self-match's
        // gap is always zero once hydrated, so this also just avoids the cost
        // of finding that out the slow way).
        if (parentId === seed.id) continue;
        if (match.score < MIN_SIMILARITY) continue;

        pending.push({ seed, parentId, similarity: match.score });
        neighbourIds.add(parentId);
      }
    }

    // One hydration lookup (chunked at D1_MAX_BOUND_PARAMS — 25 seeds x topK 10
    // can exceed 100 distinct ids, D1's bound-parameter ceiling) instead of one
    // per candidate. A neighbour missing here — deleted, or a race with a
    // delete — has nothing authoritative to check it against, so it is
    // skipped rather than falling back to the metadata this step exists to
    // not trust.
    const neighbourById = new Map<string, NeighbourRow>();
    const neighbourIdList = [...neighbourIds];
    for (let i = 0; i < neighbourIdList.length; i += D1_MAX_BOUND_PARAMS) {
      const batch = neighbourIdList.slice(i, i + D1_MAX_BOUND_PARAMS);
      const placeholders = batch.map(() => "?").join(", ");
      const { results: hydrated } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at, importance_score, workspace_id
           FROM entries
          WHERE id IN (${placeholders})`,
      ).bind(...batch).all() as { results: NeighbourRow[] };
      for (const row of hydrated) neighbourById.set(row.id, row);
    }

    const rows: {
      id: string; a: string; b: string; similarity: number; gap: number; score: number;
    }[] = [];

    for (const { seed, parentId, similarity } of pending) {
      const neighbour = neighbourById.get(parentId);
      if (!neighbour) continue;

      // Tenancy: a pair is only ever one workspace's content. The Vectorize query
      // cannot know about workspaces yet (namespacing is a later phase), so a
      // match from someone else's personal workspace arrives here routinely and is
      // dropped once the hydrated rows disagree — before anything about either row
      // influences a score, an insight, or an edge.
      if (neighbour.workspace_id !== seed.workspace_id) continue;

      const gap = Math.abs(seed.created_at - neighbour.created_at);
      if (gap < MIN_GAP_MS) continue;

      const neighbourTags = parseTags(neighbour.tags);
      const eligible = isInsightEligible({
        content: neighbour.content,
        tags: neighbourTags,
        source: neighbour.source,
      });
      if (!eligible) continue;

      const seedTags = parseTags(seed.tags);
      // Both sides individually clear isInsightEligible above; this is the
      // pair-level check — two assistant-written notes have no original
      // between them even when each alone is legitimate seed/neighbour
      // material. See isEligiblePair's own comment for why.
      if (!isEligiblePair({ tags: seedTags }, { tags: neighbourTags })) continue;

      const seedScorable: ScorableEntry = {
        id: seed.id,
        tags: seedTags,
        importance: seed.importance_score ?? 0,
        createdAt: seed.created_at,
      };
      // The neighbour's real importance, not zero: `scoreCandidate`'s boost
      // uses max(a.importance, b.importance), so a high-importance neighbour
      // that never boosts anything would defeat the whole point of that term.
      const other: ScorableEntry = {
        id: neighbour.id,
        tags: neighbourTags,
        importance: neighbour.importance_score ?? 0,
        createdAt: neighbour.created_at,
      };
      const [a, b] = normalisePair(seed.id, neighbour.id);
      rows.push({
        id: crypto.randomUUID(),
        a, b,
        similarity,
        gap,
        score: scoreCandidate(seedScorable, other, similarity),
      });
    }

    if (rows.length) {
      const now = Date.now();
      // One batch is one subrequest whatever it carries — the same argument
      // src/compression/digest.ts makes for its rolled-up marks.
      await env.DB.batch(rows.map(r => env.DB.prepare(
        `INSERT INTO insight_candidates
           (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'vector', 'pending', ?)
         ON CONFLICT(a_id, b_id) DO NOTHING`,
      ).bind(r.id, r.a, r.b, r.similarity, r.gap, r.score, now)));
    }

    // Explicitly recorded supersessions. One query, and the pairs it yields are
    // the highest-precision input available — but only about half of the
    // system-provenance edges are genuine, so these are proposals for the
    // reasoning step to accept or decline, never claims.
    try {
      const { results: superseded } = await env.DB.prepare(
        `SELECT e.source_id, e.target_id,
                a.created_at AS a_created, a.content AS a_content, a.tags AS a_tags, a.source AS a_source,
                b.created_at AS b_created, b.content AS b_content, b.tags AS b_tags, b.source AS b_source
         FROM edges e
         JOIN entries a ON a.id = e.source_id
         JOIN entries b ON b.id = e.target_id
         WHERE e.type = 'supersedes'
           AND a.workspace_id = b.workspace_id
           AND ABS(a.created_at - b.created_at) >= ?
           AND a.tags NOT LIKE '%"status:deprecated"%'
           AND b.tags NOT LIKE '%"status:deprecated"%'
         ORDER BY e.created_at DESC
         LIMIT 10`,
      ).bind(MIN_GAP_MS).all() as {
        results: {
          source_id: string; target_id: string;
          a_created: number; a_content: string; a_tags: string; a_source: string;
          b_created: number; b_content: string; b_tags: string; b_source: string;
        }[];
      };

      // The deprecation half of eligibility is filtered here, in SQL, rather
      // than left to the JS pass below — because LIMIT 10 runs before that
      // pass ever sees a row. A system-provenance supersedes edge always
      // deprecates its target the instant it is created (src/capture/entry.ts
      // calls deprecateEntry(conflictId) immediately before createEdge(...,
      // "supersedes", { provenance: "system" })), and system edges outnumber
      // explicit ones roughly 3:1 and are usually the newest. Unfiltered, an
      // `ORDER BY e.created_at DESC LIMIT 10` window fills entirely with rows
      // that isInsightEligible was always going to reject, and the rare
      // user-authored supersedes edge between two still-live entries gets
      // crowded out before it is ever examined. This query has no cursor, so
      // that crowding-out is permanent — the same dead rows win the window
      // again on every later run, not just this one.
      //
      // This does NOT resurrect system-provenance candidates: the deprecated
      // side's vectors are already deleted and that signal is genuinely
      // unusable, so those rows are excluded exactly as before. All this
      // buys is that they no longer consume every slot in the window, so a
      // pair that could actually qualify has a chance to be one of the ten
      // rows examined.
      //
      // isInsightEligible still has to run below: it also checks machine
      // tags, integration sources and the content floor, none of which this
      // predicate touches. SQL narrows the window to rows that CAN pass;
      // JS remains the authority on whether they DO.
      // An explicit supersedes link (src/mcp/server.ts, src/routes/graph.ts)
      // never runs deprecateEntry the way a system-detected contradiction
      // does (src/capture/entry.ts), so both sides can independently clear
      // isInsightEligible above while still both being assistant-authored.
      // The pair-level rule applies here exactly as it does to the
      // vector-neighbour path above — authorship is a property of the pair,
      // not of which accrual path found it.
      const eligible = superseded.filter(row =>
        isInsightEligible({ content: row.a_content, tags: parseTags(row.a_tags), source: row.a_source })
        && isInsightEligible({ content: row.b_content, tags: parseTags(row.b_tags), source: row.b_source })
        && isEligiblePair({ tags: parseTags(row.a_tags) }, { tags: parseTags(row.b_tags) }),
      );

      if (eligible.length) {
        const now = Date.now();
        await env.DB.batch(eligible.map(row => {
          const [a, b] = normalisePair(row.source_id, row.target_id);
          const gap = Math.abs(row.a_created - row.b_created);
          return env.DB.prepare(
            `INSERT INTO insight_candidates
               (id, a_id, b_id, similarity, gap_ms, score, signal, status, created_at)
             VALUES (?, ?, ?, 1.0, ?, ?, 'supersedes', 'pending', ?)
             ON CONFLICT(a_id, b_id) DO NOTHING`,
          ).bind(crypto.randomUUID(), a, b, gap, Math.log1p(gap / 86400000), now);
        }));
      }
    } catch (e) {
      console.error("Supersedes candidate accrual failed (non-fatal):", e);
    }

    // Advanced only after the work landed. A failure above leaves the cursor
    // where it was, so tomorrow re-examines this slice rather than skipping it —
    // and the UNIQUE constraint makes the repeat a no-op.
    await writeCursor(env, seeds[seeds.length - 1]);
    return { seedsExamined };
  } catch (e) {
    console.error("Insight accrual failed (non-fatal):", e);
    return { seedsExamined };
  }
}
