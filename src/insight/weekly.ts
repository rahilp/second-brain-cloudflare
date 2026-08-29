/**
 * The weekly reasoning pass.
 *
 * Does no searching: nightly accrual has already left scored pairs in
 * insight_candidates, so this reads an ordered slice and spends its whole
 * budget on reasoning.
 *
 * Producing nothing is a correct outcome. The generator this replaces made 136
 * proposals and none were ever promoted; three filler insights a week is how a
 * review queue becomes something its owner stops opening.
 */
import type { Env } from "../env";
import { resolveConfig } from "../config";
import { initializeDatabase } from "../db/init";
import { captureEntry } from "../capture/entry";
import { reasonOverPair, restatesRecent } from "./reason";
import { PENDING_INSIGHT_SQL, WRITTEN_INSIGHT_SQL } from "../memory/patterns";
import { edgeInsertStatement } from "../graph/edges";
import { isEligiblePair, parseTags } from "./candidates";
import { D1_MAX_BOUND_PARAMS } from "../constants";

/** Pairs considered per run. Each costs one model call. */
export const WEEKLY_CANDIDATE_LIMIT = 10;

/** Written per run, however many qualify. */
export const MAX_INSIGHTS_PER_RUN = 3;

/**
 * How many recently written insights the novelty floor compares a new
 * candidate against, in addition to whatever this run itself accepts.
 *
 * Bounded on purpose — spec D2 explicitly rejects comparing against "the
 * whole history" — but wide enough to catch what the design's own motivating
 * case needed: the 2026-08-16 run restated an insight the 2026-08-12 dry run
 * had produced, four days and one cycle earlier. At MAX_INSIGHTS_PER_RUN (3)
 * per run, 10 covers a little over three runs' worth of unreviewed backlog —
 * generous enough for a queue a week or two behind, not the whole history.
 * Matches WEEKLY_CANDIDATE_LIMIT's existing round number rather than
 * introducing a second unrelated one.
 */
export const RECENT_INSIGHT_WINDOW = 10;

/**
 * The most candidate statements one run will spend on a workspace slice.
 *
 * Chunking the slice (below) trades the bound-parameter ceiling for a
 * subrequest one: each statement past the first is one more of the invocation's
 * 50, and the team invocation measures 47 of 50 at its worst slate on one
 * workspace and 48 of 50 at 50 and at 98 — both MEASURED end to end through
 * scheduled() in test/integration/insight-cron-budget.test.ts, not inferred
 * from the 47 by adding one. The slack survives, and a regression past 50 is
 * now a red test rather than a production incident. Two covers 98 company workspaces —
 * far past any brain this ships to — and leaves the novelty floor's own slice
 * (which binds each id ONCE, so 98 + 1 = 99) inside the bound-parameter
 * ceiling without a second statement of its own.
 *
 * Past 98 the slice is TRUNCATED and the truncation is logged. Losing the tail
 * of the list is a real loss, but it is a bounded and legible one, where
 * overflowing the budget mid-loop throws, loses the whole run including the
 * batch that settles the candidates, and is swallowed by the catch at the
 * bottom of this file.
 */
export const MAX_SLICE_STATEMENTS = 2;

interface CandidateRow {
  id: string;
  score: number;
  a_id: string;
  b_id: string;
  a_content: string;
  b_content: string;
  a_tags: string;
  b_tags: string;
  a_workspace_id: string;
  b_workspace_id: string;
}

/**
 * A stored auto-insight's `content` carries the reasoned text plus a fixed
 * "[Insight: shape — drawn from 2 memories]" footer (built below). Comparing
 * against the raw stored content would give every insight a few tokens
 * ("insight", "drawn", "memories", its shape word) that match purely because
 * they are boilerplate, not because the two insights say anything alike —
 * inflating restatesRecent's overlap ratio for genuinely distinct insights
 * that merely share a shape. Stripping the footer keeps the comparison the
 * same shape as the within-run one, which compares raw `result.text` values.
 *
 * Exported so src/routes/admin.ts's dry-run endpoint can build the identical
 * comparison list this pass does — one definition of "what a reader has
 * already seen," not a second copy that could drift from this one.
 */
export function rawInsightText(content: string): string {
  const footer = content.indexOf("\n\n[Insight:");
  return footer === -1 ? content : content.slice(0, footer);
}

/**
 * Every company workspace on the deployment. A cron has no caller to
 * scope to; `kind` is the whole predicate and the result is a list of
 * ids, never content.
 */
export async function companyWorkspaceIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM workspaces WHERE kind = 'company'`,
  ).all<{ id: string }>();
  return (results ?? []).map(r => r.id);
}

/**
 * `onlyWorkspaceIds` narrows the candidate slate to pairs whose BOTH sides sit
 * in one of the named workspaces. Absent or empty means the whole corpus — the
 * personal pass — so a solo brain's empty company list reads as "no
 * restriction was asked for" rather than "restrict to nothing".
 *
 * One implementation, two invocations. Everything the personal and team passes
 * do differs by this predicate and nothing else: the eligibility gate, the
 * same-workspace gate, the novelty floor, the three-per-run cap, the
 * drawn_from edges and the batch are behaviour both need and neither may drift
 * on, so a second function would be two things to keep in step rather than one
 * thing to get right.
 */
export async function runWeeklyInsights(
  env: Env,
  ctx: ExecutionContext,
  opts?: { onlyWorkspaceIds?: string[] },
): Promise<void> {
  try {
    const cfg = await resolveConfig(env);
    await initializeDatabase(env);

    const sliceIds = opts?.onlyWorkspaceIds ?? [];
    // Chunked against the platform's bound-parameter ceiling, the way every
    // other IN-list in src/ is (entries/import.ts, graph/traverse.ts,
    // insight/candidates.ts). Each slice id is bound TWICE below — once per
    // alias — so a statement costs 2N + 1 parameters for N workspaces, and the
    // /2 here is the same arithmetic traverse.ts's edgeTake does for the same
    // reason. Unchunked, a deployment with 50 company workspaces sends 101
    // parameters, D1 rejects the statement outright, the catch at the bottom of
    // this function swallows the rejection, and the team pass stops producing
    // anything forever with no user-visible signal.
    //
    // ceil(N / 49) statements, capped at MAX_SLICE_STATEMENTS, so a brain with
    // one or two teams — every brain that exists — pays exactly what it paid
    // before: one subrequest. Each extra chunk is one more subrequest out of
    // the same 50 the model calls come from, which is why the chunk is as
    // large as the ceiling allows rather than a round number.
    //
    // One consequence worth naming: past 49 workspaces a candidate whose two
    // sides sit in DIFFERENT chunks is no longer drawn at all, where before it
    // was drawn and then discarded by the same-workspace gate below. It stays
    // `pending` instead of being settled `used` — the same outcome the pass
    // already gives a pair with only one side inside the slice.
    const sliceChunkSize = Math.floor((D1_MAX_BOUND_PARAMS - 1) / 2);
    const sliceCapacity = sliceChunkSize * MAX_SLICE_STATEMENTS;
    if (sliceIds.length > sliceCapacity) {
      console.error("[insight] weekly pass: slice truncated to fit the subrequest budget", {
        workspaces: sliceIds.length, drawn: sliceCapacity, dropped: sliceIds.length - sliceCapacity,
      });
    }
    const drawnSliceIds = sliceIds.slice(0, sliceCapacity);
    const sliceChunks: string[][] = drawnSliceIds.length
      ? Array.from(
          { length: Math.ceil(drawnSliceIds.length / sliceChunkSize) },
          (_, i) => drawnSliceIds.slice(i * sliceChunkSize, (i + 1) * sliceChunkSize),
        )
      : [[]];   // no slice asked for: one statement over the whole corpus

    // One statement per chunk rather than a select-then-hydrate: the join is what keeps
    // this inside the subrequest budget, and a candidate whose entries have
    // since been forgotten drops out of the result rather than needing a guard.
    //
    // The deprecation check is the same reasoning applied to a candidate whose
    // entries still exist but should no longer be reasoned over: accrual is
    // nightly and this is weekly, so up to seven days can pass between a pair
    // being accrued and being read here, and a `supersedes` edge deprecates its
    // target the moment it is created (src/capture/entry.ts). Filtering both
    // sides here catches that drift regardless of which signal accrued the
    // candidate or how eligibility was — or was not — checked at accrual time.
    // a.tags/b.tags ride along on the same join this query already makes —
    // D1 (isEligiblePair, ./candidates.ts) has to be applied here too, not
    // only at accrual, or every candidate accrued before D1 existed keeps
    // being drawn under the old rule until the pool empties. Free: the JOIN
    // was already selecting these rows, this only widens the column list.
    const drawn: CandidateRow[] = [];
    for (const chunk of sliceChunks) {
      // Built here rather than inline in the template so the query carries a
      // plain identifier: a conditional written inside `${…}` is unscoped on the
      // arm that matters and scripts/check-scope.mjs refuses it on sight.
      const slicePlaceholders = chunk.map(() => "?").join(", ");
      const sliceClause = chunk.length
        ? `AND a.workspace_id IN (${slicePlaceholders}) AND b.workspace_id IN (${slicePlaceholders})`
        : "";
      const { results: chunkRows } = await env.DB.prepare(
        // scope-exempt: cron: no caller to scope to. Both workspaces are projected, and the loop below compares them BEFORE the pair reaches the model: a candidate whose two entries sit in different workspaces is skipped and settled, never reasoned over and never written anywhere. Accrual refuses to pair across workspaces (candidates.ts), so that only fires for pre-tenancy candidate rows. sliceClause is optionally present and is a list of workspace IDS read from the `workspaces` table (companyWorkspaceIds, below), never from a request — it narrows this cron's slate, it does not scope it to a caller, and there is no caller to scope to on either invocation
        `SELECT c.id, c.score, c.a_id, c.b_id, a.content AS a_content, b.content AS b_content,
                a.tags AS a_tags, b.tags AS b_tags,
                a.workspace_id AS a_workspace_id, b.workspace_id AS b_workspace_id
         FROM insight_candidates c
         JOIN entries a ON a.id = c.a_id
         JOIN entries b ON b.id = c.b_id
         WHERE c.status = 'pending'
           AND a.tags NOT LIKE '%"status:deprecated"%'
           AND b.tags NOT LIKE '%"status:deprecated"%'
           ${sliceClause}
         ORDER BY c.score DESC
         LIMIT ?`,
      ).bind(...chunk, ...chunk, WEEKLY_CANDIDATE_LIMIT).all() as { results: CandidateRow[] };
      drawn.push(...chunkRows);
    }
    // Each chunk returned its own top WEEKLY_CANDIDATE_LIMIT, so the ordering
    // the pass spends its three write slots by has to be re-established across
    // chunks. A no-op on the one-chunk path every real deployment takes: the
    // rows arrive ordered and there are at most LIMIT of them.
    const results = drawn
      .sort((x, y) => y.score - x.score)
      .slice(0, WEEKLY_CANDIDATE_LIMIT);

    // Seeds the novelty floor with what a reader would already have seen: the
    // last RECENT_INSIGHT_WINDOW insights the pass has WRITTEN, not just what
    // this run itself is about to write. Without a cross-run seed, restatesRecent
    // could only catch two candidate pairs in the SAME run reaching the same
    // conclusion — not the case the spec's evidence is built on, where the
    // restated insight came from an earlier run.
    //
    // WRITTEN_INSIGHT_SQL, not PENDING_INSIGHT_SQL. The pending window empties
    // as fast as the queue is reviewed: measured on a real brain the day this
    // shipped, zero unreviewed insights meant zero comparisons and a guard that
    // could not fire at all. Reviewing promptly was switching it off.
    //
    // THE FLOOR IS PER-WORKSPACE, and that is the whole of what it is.
    //
    // The floor asks "has this reader already seen this?", so its answer is a
    // property of ONE workspace: the reader of an insight filed in W is the
    // people who can read W, and nobody else. Getting that wrong does not
    // merely skip a pair — a suppressed candidate is settled `used`, so the
    // insight is DESTROYED rather than deferred, and the loser cannot come
    // back next week the way one that lost a write slot can.
    //
    // It was first written unsliced, which let a member's personal insight
    // destroy a company one. Slicing it by the pass's own slice fixed that and
    // introduced the same fault one level up: companyWorkspaceIds() returns
    // EVERY company on the deployment and src/index.ts hands the whole list to
    // one call, so on a two-company deployment company A's last ten insights
    // sat in company B's floor. "The reader" was never the slice; both
    // spellings were approximations of the workspace, so this reads the
    // workspace.
    //
    // Keyed on the workspaces the DRAWN candidates can actually land in, not
    // on the slice: `results` is already in hand, an insight inherits its
    // inputs' workspace when they agree (the gate below), and a pair whose two
    // sides disagree is settled without ever reaching the model. That is at
    // most WEEKLY_CANDIDATE_LIMIT distinct workspaces however wide the slice
    // is, so this stays ONE statement at 11 bound parameters at the very worst
    // — no chunking, and strictly narrower than either earlier spelling. With
    // nothing drawn there is nothing to compare and the statement is not
    // issued at all.
    //
    // ROW_NUMBER over a partition rather than a bare LIMIT: a plain
    // `ORDER BY created_at DESC LIMIT 10` across several workspaces is a
    // shared window again by another name, and one busy workspace would crowd
    // every other one's floor down to nothing. Each workspace gets its own
    // RECENT_INSIGHT_WINDOW rows, which is what a solo brain — one workspace —
    // has always had.
    const floorWorkspaces = [...new Set(
      results
        .filter(c => (c.a_workspace_id ?? "") === (c.b_workspace_id ?? ""))
        .map(c => c.a_workspace_id ?? ""),
    )];
    const recentInsightRows: { workspace_id: string; content: string }[] = [];
    if (floorWorkspaces.length) {
      const { results: rows } = await env.DB.prepare(
        // NOT caller-scoped, and it carries no licence saying it is: this is a
        // cron, there is no caller, and check-scope.mjs is satisfied here on the
        // merits because the `workspace_id IN (…)` predicate is literal in the
        // source rather than interpolated the way its sliced predecessor was.
        // What the list means is "which reader is this candidate measured
        // against" — the drawn candidates' own workspace ids, read out of
        // `entries` by the query above and never out of a request. The content
        // is compared and never returned.
        `SELECT workspace_id, content FROM (
           SELECT workspace_id, content,
                  ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at DESC) AS rn
             FROM entries
            WHERE ${WRITTEN_INSIGHT_SQL}
              AND workspace_id IN (${floorWorkspaces.map(() => "?").join(", ")})
         ) WHERE rn <= ?`,
      ).bind(...floorWorkspaces, RECENT_INSIGHT_WINDOW).all() as {
        results: { workspace_id: string; content: string }[]
      };
      recentInsightRows.push(...(rows ?? []));
    }

    let written = 0;
    // D2 instrumentation (spec: "if it starts rejecting often, the corpus is
    // telling us D3 is due"). candidatesReasoned counts only pairs that
    // actually reached the model — a D1 pair-rule rejection below never
    // calls reasonOverPair, so it must not inflate this count the way it
    // would if measured off `results.length`.
    let candidatesReasoned = 0;
    let restatementsSuppressed = 0;
    const rejected: string[] = [];
    const used: string[] = [];
    // Two per stored insight: which memories it was drawn from. Collected as
    // plain pairs rather than calling edgeInsertStatement here — that call is
    // just a local statement builder (no D1 round trip), but issuing it
    // mid-loop would interleave it with the next candidate's own D1 activity.
    // Building every prepared statement in one synchronous pass right beside
    // rejected.map/used.map, immediately before env.DB.batch(statements),
    // keeps the whole batch's statements prepared together — which is what
    // lets it join the status updates as a single subrequest.
    const drawnFromPairs: { insightId: string; targetId: string; workspaceId: string }[] = [];
    // Texts to compare a new proposal against, PER WORKSPACE: the insights that
    // workspace has already been given, plus (appended below) whatever this run
    // itself writes into it. Two different candidate pairs — in this run, or one
    // from weeks back — can reason to the same conclusion; a corpus full of
    // near-duplicate memories makes that common, not rare, and each is a slot
    // this run gets to spend only three of. Checked independently against each
    // entry (restatesRecent), never concatenated.
    //
    // The within-run half is keyed the same way as the cross-run half on
    // purpose: an insight this run writes for company A is no more visible to
    // company B than one written last week, so letting it suppress B's
    // candidate would reintroduce the same defect inside a single run.
    const seenByWorkspace = new Map<string, string[]>();
    for (const row of recentInsightRows) {
      const list = seenByWorkspace.get(row.workspace_id ?? "");
      if (list) list.push(rawInsightText(row.content));
      else seenByWorkspace.set(row.workspace_id ?? "", [rawInsightText(row.content)]);
    }
    const seenIn = (workspaceId: string): string[] => {
      const list = seenByWorkspace.get(workspaceId);
      if (list) return list;
      const fresh: string[] = [];
      seenByWorkspace.set(workspaceId, fresh);
      return fresh;
    };

    for (const candidate of results) {
      if (written >= MAX_INSIGHTS_PER_RUN) break;

      // D1 at the draw, not only at accrual: a candidate accrued before the
      // guard existed is still sitting in the pool under the old rule, and
      // this join already has both sides' tags on hand at zero extra cost.
      // Marked `used`, the same as a restatement — the pair is disqualified
      // outright, and re-accrual would just re-insert the identical row
      // (ON CONFLICT(a_id, b_id) DO NOTHING), so a `pending` or `rejected`
      // status here would only have the pass re-discover and re-skip it
      // every week rather than settling it once.
      if (!isEligiblePair({ tags: parseTags(candidate.a_tags) }, { tags: parseTags(candidate.b_tags) })) {
        used.push(candidate.id);
        continue;
      }

      // THE INSIGHT-WORKSPACE RULE, applied as a GATE on synthesis rather than as
      // placement afterwards.
      //
      // reasonOverPair puts `a.content` and `b.content` in ONE prompt, and the
      // insight's vocabulary floor requires the sentence that comes back to name
      // something particular to each side — so a pair spanning two workspaces was
      // synthesised into a sentence carrying specifics from both before anything
      // looked at where it belonged. Filing that sentence in "" narrowed who could
      // read it, but readableWorkspaces hands "" to admins, so it still reached a
      // reader on /patterns. There is no correct place for it: it should never have
      // been written.
      //
      // Free: the candidate join already projects both sides' workspace_id, so
      // this needs no extra query. Marked `used` for the same reason the D1
      // pair-rule rejection above is — the pair is disqualified outright, and
      // re-accrual would re-insert the identical row, so leaving it `pending`
      // would only have the pass re-draw and re-skip it every week.
      //
      // An insight inherits its inputs' workspace when they agree: the synthesis is
      // then that workspace's own content turned back on itself, and hiding it from
      // the people who wrote it would make insights unreadable by their owners.
      //
      // Accrual (src/insight/candidates.ts) already refuses to pair across
      // workspaces in both paths, so this only fires for candidates that predate
      // tenancy — which is every candidate an upgraded v2 brain carries in.
      //
      // It holds identically on the sliced (team) invocation, and it is not
      // made redundant by the slice: `onlyWorkspaceIds` can name more than one
      // company workspace, and a pair with one side in each passes both IN
      // predicates. This gate is the only thing between such a pair and the
      // model. Team insights (spec 4.5) are a company-SCOPED pass, not a
      // cross-workspace one.
      const inputWorkspaces = new Set([candidate.a_workspace_id ?? "", candidate.b_workspace_id ?? ""]);
      if (inputWorkspaces.size !== 1) {
        used.push(candidate.id);
        continue;
      }
      const insightWorkspace = [...inputWorkspaces][0];

      candidatesReasoned++;
      const result = await reasonOverPair(
        { content: candidate.a_content },
        { content: candidate.b_content },
        env,
        cfg,
      );

      // A refusal is settled; a thrown call is not. reasonOverPair now says
      // which one happened instead of returning null for both. A "declined"
      // candidate is marked `rejected` below — re-asking a model that has
      // already answered costs tokens for a response already given. A "failed"
      // candidate is left untouched in `pending`: nothing was decided, and
      // re-accrual cannot resurrect a `rejected` row (`ON CONFLICT DO NOTHING`
      // leaves its status alone), so the only way a transient failure gets a
      // second chance is by never having been marked settled in the first
      // place.
      if (result.outcome === "failed") continue;
      if (result.outcome === "declined") {
        rejected.push(candidate.id);
        continue;
      }

      // A rejected restatement marks its candidate `used`, not `rejected` —
      // the pair reasoned over successfully, it just landed where the reader
      // has already been, whether that's this run or an earlier one still
      // sitting unreviewed. `rejected` is reserved for a pair the model
      // itself declined; marking a restatement `rejected` would make the
      // pass re-propose and re-pay for it on a later run.
      const seenHere = seenIn(insightWorkspace);
      if (restatesRecent(result.text, seenHere)) {
        restatementsSuppressed++;
        used.push(candidate.id);
        continue;
      }
      seenHere.push(result.text);

      // insightWorkspace was settled above, before the pair reached the model.
      const content = `${result.text}\n\n[Insight: ${result.shape} — drawn from 2 memories]`;
      // actorId stays "": the insight is system-authored regardless of whose
      // workspace it inherits.
      const captured = await captureEntry(content, ["auto-insight"], "system", env, ctx, cfg,
        { workspaceId: insightWorkspace, actorId: "" });

      // A non-stored result means the insight duplicated an earlier one. Mark it
      // used anyway, or the pass re-proposes and re-pays for this pair forever.
      used.push(candidate.id);
      if (captured.status === "stored") {
        written++;
        // Only on a real, created entry — an edge sourced from a capture that
        // declined to store would point at a row that never exists. The edge
        // carries the insight's own workspace so scoped graph walks can see it.
        for (const targetId of [candidate.a_id, candidate.b_id]) {
          drawnFromPairs.push({ insightId: captured.id, targetId, workspaceId: insightWorkspace });
        }
      }
    }

    // One structured line, before the batch: candidatesReasoned vs. results.length
    // shows how much of the slice D1 removed before a model call was ever
    // made; declinedByModel vs. restatementsSuppressed vs. written separates
    // three failure modes that all otherwise collapse into "output was low"
    // — a corpus running dry, D2 over-firing, and the model itself saying no
    // look identical from the outside without this line.
    console.log("[insight] weekly pass:", {
      candidatesDrawn: results.length,
      candidatesReasoned,
      declinedByModel: rejected.length,
      restatementsSuppressed,
      written,
    });

    const statements = [
      ...rejected.map(id => env.DB.prepare(
        `UPDATE insight_candidates SET status = 'rejected' WHERE id = ?`).bind(id)),
      ...used.map(id => env.DB.prepare(
        `UPDATE insight_candidates SET status = 'used' WHERE id = ?`).bind(id)),
      ...drawnFromPairs
        .map(({ insightId, targetId, workspaceId }) => edgeInsertStatement(
          insightId, targetId, "drawn_from", { provenance: "system", weight: 1, workspaceId }, env,
        ))
        .filter((stmt): stmt is D1PreparedStatement => stmt !== null),
    ];
    if (statements.length) await env.DB.batch(statements);
  } catch (e) {
    // The ONLY signal either invocation ever failed. It carries the slice size
    // because the personal and team passes share this implementation and this
    // line: without it a rejected statement on the team pass reads exactly like
    // one on the personal pass, and a pass that dies permanently and says
    // nothing distinguishable is how the unchunked bind above stayed invisible.
    console.error("Weekly insight pass failed (non-fatal):",
      { sliceWorkspaces: opts?.onlyWorkspaceIds?.length ?? 0 }, e);
  }
}
