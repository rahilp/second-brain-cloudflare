import type { Env } from "../env";
import { initializeDatabase } from "../db/init";
import { getStatus } from "../memory/status";
import { getVolatility, withVolatility } from "../memory/volatility";
import { hasStaleAsOf, withStaleAsOf, withoutStaleAsOf } from "../memory/stale";
import { classifyVolatility, shouldFlagStale } from "./heuristic";

export const STALENESS_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How many candidates one pass inspects.
 *
 * Raising this past 100 breaks the retry re-read: rereadSnapshots binds one parameter per
 * unsettled row into a single `WHERE id IN (…)`, and D1 allows at most 100 bound parameters
 * per query. It fails only under contention, which is the hard case to notice. Chunk that
 * read before raising this.
 */
export const STALENESS_PASS_LIMIT = 25;

// Unchanged from when every row retried on its own. What changed is the price: a whole
// round of retries now costs one re-read plus one batch, not one of each per row, so the
// depth is bounded by correctness rather than by budget.
const STALENESS_CAS_ATTEMPTS = 3;

const SYSTEM_TAG_EXCLUSIONS = [
  `tags NOT LIKE '%"status:deprecated"%'`,
  `tags NOT LIKE '%"auto-pattern"%'`,
  `tags NOT LIKE '%"synthesized"%'`,
  `tags NOT LIKE '%"rolled-up"%'`,
].join(" AND ");

/** The row as the pass last saw it — the CAS guard is built from exactly these values. */
type Snapshot = { id: string; tags: string; content: string };

/** `retryable` marks a CAS, whose result decides whether the row needs another attempt. */
type Write = { id: string; stmt: D1PreparedStatement; retryable: boolean };

function classify(tags: string[], content: string): string[] {
  const classified = classifyVolatility(content, tags);
  const existing = getVolatility(tags);

  if (classified && !existing) {
    tags = withVolatility(tags, classified);
  }

  const volatility = getVolatility(tags);

  if (shouldFlagStale(volatility)) {
    if (!hasStaleAsOf(tags)) tags = withStaleAsOf(tags);
  } else if (volatility === "durable") {
    tags = withoutStaleAsOf(tags);
  }

  return tags;
}

// The guard covers content as well as tags because the classification is derived from
// content. Guarding tags alone is not enough: for an entry carrying neither a volatility:
// nor a stale:as-of tag — the common case — the mutation is a no-op on tags, so a
// concurrent rewrite would leave the guard satisfied and the CAS would commit a verdict
// about content that no longer exists. That misfire does not self-correct either, since
// the concurrent write also bumps updated_at past the staleness cutoff.
//
// Binding content per row means a batch of these carries every candidate's body at once.
// D1 applies its per-statement limits to each statement inside a batch, not to the batch,
// and the ones that could bite are comfortable: the SQL text is a fixed ~110 bytes because
// content and tags are bound rather than interpolated, and 5 bound parameters is far under
// the 100 allowed. Size is bounded too — D1 caps a row at 2 MB, so 25 statements carrying
// content plus tags twice cannot approach the 100 MB request ceiling in any arrangement
// that a 128 MB isolate could have built. The candidate query already materialises all 25
// bodies in one response, so the write side is not the first place this would break;
// STALENESS_PASS_LIMIT is the knob if it ever does.
function casWrite(env: Env, snap: Snapshot, now: number): D1PreparedStatement {
  const nextTags = JSON.stringify(classify(JSON.parse(snap.tags), snap.content));
  return env.DB.prepare(
    `UPDATE entries SET tags = ?, staleness_checked_at = ? WHERE id = ? AND tags = ? AND content = ?`,
  ).bind(nextTags, now, snap.id, snap.tags, snap.content);
}

// The candidate query orders by COALESCE(staleness_checked_at, 0) ASC, so a row left NULL
// sorts first on every future pass and camps one of the 25 slots indefinitely. Any row the
// pass inspects must have its cursor moved, verdict or no verdict.
function cursorWrite(env: Env, id: string, now: number): D1PreparedStatement {
  return env.DB.prepare(`UPDATE entries SET staleness_checked_at = ? WHERE id = ?`).bind(now, id);
}

function planWrite(env: Env, snap: Snapshot, now: number): Write {
  try {
    // A deprecated row is never classified; it only needs to stop being a candidate.
    if (getStatus(JSON.parse(snap.tags)) === "deprecated") {
      return { id: snap.id, stmt: cursorWrite(env, snap.id, now), retryable: false };
    }
    return { id: snap.id, stmt: casWrite(env, snap, now), retryable: true };
  } catch (e) {
    // Tags that will not parse cannot be classified on this attempt or any other, so there
    // is nothing to retry — but the cursor still has to move, or the row parks at the front
    // of the queue forever.
    console.error(`Staleness pass failed for ${snap.id} (non-fatal):`, e);
    return { id: snap.id, stmt: cursorWrite(env, snap.id, now), retryable: false };
  }
}

/**
 * One round of writes as a single subrequest, keeping the per-row path as a fallback.
 *
 * All four nightly jobs fire from one scheduled() invocation and share its budget (#278),
 * and at one UPDATE per candidate — plus retries, plus cursor advances — this pass was the
 * largest consumer of it. A batch costs one subrequest whatever it carries.
 *
 * batch() is atomic, and the two ways a statement can come back have to be told apart. A
 * CAS that loses reports changes: 0 and does not roll the batch back (verified against
 * workerd, not assumed), so contention is free here. A genuine SQL error does roll back
 * everything, which would leave up to 25 inspected rows with a NULL cursor sitting at the
 * front of the next run's queue — so a rejected batch replays per row: the behaviour this
 * replaced, at the cost it used to pay, on the path that used to be the only path.
 *
 * That fallback is deliberately not free. If every batch is rejected AND every per-row
 * replay also fails, the pass degenerates to about 107 subrequests — 1 candidate query,
 * then a rejected batch plus 25 replays on each of three attempts and again on the cursor
 * advance. That is well over the free plan's 50, but it only happens when D1 is refusing
 * writes outright, and a pass that spends the budget failing is strictly better than one
 * that abandons 25 rows with NULL cursors for every later run to trip over.
 */
async function runWrites(env: Env, writes: Write[]): Promise<number[]> {
  if (!writes.length) return [];
  try {
    const results = await env.DB.batch(writes.map(w => w.stmt));
    return results.map(r => r.meta.changes ?? 0);
  } catch (e) {
    console.error("Batched staleness writes failed; retrying per row (non-fatal):", e);
    const changes: number[] = [];
    for (const w of writes) {
      try {
        const result = await w.stmt.run();
        changes.push(result.meta.changes ?? 0);
      } catch (err) {
        console.error(`Staleness pass failed for ${w.id} (non-fatal):`, err);
        // Indistinguishable from a lost CAS from here, and treated as one: retried, and
        // cursor-advanced if it never lands. No row is left owed a write it never gets.
        changes.push(0);
      }
    }
    return changes;
  }
}

/**
 * Fresh tags AND content for every loser, in one read rather than one read each.
 *
 * One bound parameter per id, against D1's limit of 100 per query — safe only because
 * STALENESS_PASS_LIMIT caps the caller at 25. See the note on that constant.
 */
async function rereadSnapshots(env: Env, ids: string[]): Promise<Snapshot[] | null> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, tags, content FROM entries WHERE id IN (${ids.map(() => "?").join(", ")})`,
    ).bind(...ids).all() as { results: { id: string; tags: string; content: string }[] };
    return results.map(r => ({ id: r.id, tags: r.tags ?? "[]", content: r.content }));
  } catch (e) {
    console.error("Staleness retry re-read failed (non-fatal):", e);
    return null;
  }
}

export async function runStalenessPass(env: Env, _ctx: ExecutionContext): Promise<void> {
  await initializeDatabase(env);

  const cutoff = Date.now() - STALENESS_AGE_MS;
  const now = Date.now();
  let candidates: Snapshot[] = [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags FROM entries
       WHERE COALESCE(updated_at, created_at) < ?
         AND ${SYSTEM_TAG_EXCLUSIONS}
       ORDER BY COALESCE(staleness_checked_at, 0) ASC
       LIMIT ${STALENESS_PASS_LIMIT}`,
    ).bind(cutoff).all() as { results: { id: string; content: string; tags: string }[] };
    candidates = results.map(r => ({ id: r.id, tags: r.tags ?? "[]", content: r.content }));
  } catch (e) {
    console.error("Staleness pass query failed (non-fatal):", e);
    return;
  }

  // Rows still owed a write. A row leaves this list only by landing its CAS, by being
  // deleted underneath the pass, or — below the loop — by having its cursor advanced.
  let unsettled = candidates;
  // Rows whose cursor write itself failed. There is no verdict left to retry for these, but
  // the cursor is still owed: a row that keeps a NULL cursor sorts first on every future
  // pass forever, so dropping it here would be exactly the camping bug the cursor prevents.
  const cursorFailed: string[] = [];

  for (let attempt = 0; attempt < STALENESS_CAS_ATTEMPTS && unsettled.length; attempt++) {
    if (attempt > 0) {
      // A lost CAS means someone else wrote the row, so the retry re-classifies from the
      // fresh tags and content rather than from the snapshot that just lost. Ids that do
      // not come back were deleted mid-pass: no verdict and no cursor to write.
      const fresh = await rereadSnapshots(env, unsettled.map(r => r.id));
      if (!fresh) break; // read failed — stop retrying, but still advance the cursors below
      unsettled = fresh;
    }

    const writes = unsettled.map(snap => planWrite(env, snap, now));
    const changes = await runWrites(env, writes);
    const lost = new Set<string>();
    writes.forEach((w, i) => {
      if (changes[i] !== 0) return;
      // A CAS reporting no change usually lost a race and is worth re-reading. A cursor
      // write reporting none only ever means the write failed — the row is not a candidate
      // for reclassification, it just still needs its cursor moved.
      if (w.retryable) lost.add(w.id); else cursorFailed.push(w.id);
    });
    unsettled = unsettled.filter(snap => lost.has(snap.id));
  }

  // Everything still owed a cursor: rows whose every CAS attempt lost, and rows whose
  // cursor write failed earlier. One more batch is the last attempt either gets — a cursor
  // UPDATE on a row deleted meanwhile is a harmless no-op, so nothing needs excluding.
  const owed = [...unsettled.map(snap => snap.id), ...cursorFailed];
  if (owed.length) {
    await runWrites(env, owed.map(id => ({ id, stmt: cursorWrite(env, id, now), retryable: false })));
  }
}
