/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { withFtsWriteGuard } from "./db/fts-write-guard";
import { runNightlyCompression } from "./compression/nightly";
import { runGraphPass } from "./graph/pass";
import { INTEGRATION_SYNC_CRON, runScheduledIntegrationSync } from "./integrations/mirror";
import { MAX_PUSH_FETCHES_PER_RUN, newPushBudget, pushDueItemsAllWorkspaces, PLATFORM_EXTERNAL_FETCH_BUDGET_PER_RUN } from "./push/send";
import { runStalenessPass } from "./staleness/pass";
import { runWhenExtractPass } from "./when/pass";
import { runFtsMaintenance } from "./db/fts-backfill";
import { runNightlyCleanup } from "./memory/cleanup";
import { runNightlyVectorizePending } from "./vectorize/pending";
import { nextWorkspace } from "./runtime/rotation";
import { recordNightSummary } from "./runtime/night-summary";
import { runInsightAccrual } from "./insight/candidates";
import { companyWorkspaceIds, runWeeklyInsights } from "./insight/weekly";
import { INSIGHT_ACCRUAL_CRON, INSIGHT_TEAM_WEEKLY_CRON, INSIGHT_WEEKLY_CRON } from "./insight/schedule";
import { resolveConfig } from "./config";
import { resolveIdentityFromToken } from "./lib/identity";
import { apiHandler } from "./mcp/handler";
import { augmentOAuthRegistrationRequest } from "./oauth/register";
import { defaultHandler } from "./routes";
import { classifyD1DailyLimitError, dailyLimitMcpResponse, dailyLimitRestResponse } from "./lib/daily-limit";
import { json } from "./lib/http";
import { ScopeWriteError } from "./lib/scope";

export type { Env } from "./env";

/**
 * Accept the static AUTH_TOKEN or a member token for Claude Desktop + mcp-remote
 * (no browser flow, no OAuth grant). `via: "token"` tells resolveClientLabel
 * (src/mcp/client-label.ts) this caller never held a grant, so it skips the
 * legacy grant lookup outright rather than spend two KV reads on an
 * unwrapToken call that can never succeed for this kind of token.
 *
 * Exported for direct unit testing: the real @cloudflare/workers-oauth-provider
 * only ever calls this through its own `fetch`, which needs a live KV-backed
 * provider this codebase's tests do not stand up.
 */
export async function resolveExternalToken({ token, env }: { token: string; request: Request; env: unknown }) {
  const e = env as Env;
  if (token === e.AUTH_TOKEN) {
    return { props: { userId: "owner", via: "token" as const } };
  }
  const identity = await resolveIdentityFromToken(token, e);
  if (identity) return { props: { userId: identity.userId, via: "token" as const } };
  return null;
}

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  resolveExternalToken,
});

export default {
  fetch: async (req: Request, rawEnv: Env, ctx: ExecutionContext) => {
    // Every entries write in this Worker — capture, MCP remember/append/update/
    // forget, the dashboard, integration mirroring, import — goes through this
    // one env.DB, so guarding it here is the single choke point: a write that
    // fails because entries_fts is missing or broken repairs it and retries
    // once instead of 500ing (see src/db/fts-write-guard.ts).
    const env = withFtsWriteGuard(rawEnv);
    const url = new URL(req.url);
    try {
      if (url.pathname === "/oauth/register" && req.method === "POST") {
        const augmented = await augmentOAuthRegistrationRequest(req);
        return await oauthProvider.fetch(augmented, env as any, ctx);
      }
      return await oauthProvider.fetch(req, env as any, ctx);
    } catch (e) {
      // R3 (budget audit, MAJOR): once the account's daily D1 cap is spent, D1 hard-fails every
      // query — including identity resolution, which every authenticated route runs first — and
      // an uncaught throw here would otherwise reach the caller as Cloudflare's opaque error 1101
      // with no wording about the limit. Caught once, here, for every route including /mcp: the
      // MCP surface's own pre-dispatch identity check is itself a D1 read and fails the same way.
      const kind = classifyD1DailyLimitError(e);
      if (kind) return url.pathname === "/mcp" ? dailyLimitMcpResponse(kind) : dailyLimitRestResponse(kind);
      // Map a typed scope-write refusal to a 400 for REST only; a plain Error still rethrows.
      if (e instanceof ScopeWriteError && url.pathname !== "/mcp") {
        return json({ ok: false, error: e.message }, e.status);
      }
      throw e;
    }
  },
  scheduled: async (event: ScheduledEvent, rawEnv: Env, ctx: ExecutionContext) => {
    const env = withFtsWriteGuard(rawEnv);
    // The jobs are independent, and each begins by awaiting the shared schema init. One
    // of them failing — including on that init — must not take the others down or surface
    // as an unhandled rejection inside waitUntil.
    // `Promise<unknown>` rather than `Promise<void>`: runInsightAccrual returns
    // a summary (seeds examined) for POST /insights/accrue to report, and this
    // scheduled path fires the same promise but never reads that value.
    const job = (name: string, run: Promise<unknown>) =>
      ctx.waitUntil(run.catch((e) => console.error(`${name} failed (non-fatal):`, e)));

    // Two schedules, two budgets (#290). The free plan's real subrequest ceiling is
    // 1,000 D1/KV/Vectorize calls and 50 external fetch()es per invocation, but every
    // invocation still gets only 10 ms of CPU, and this codebase keeps a much tighter
    // self-imposed D1 budget (~50 statements) for cost discipline; the maintenance jobs
    // below already spend 30 of those, so the mirror sync gets its own invocation rather
    // than the remainder of this one. Routing on the cron string is what makes that
    // real — without the branch both triggers would run everything and the split would
    // cost CPU and D1-cost budget instead of buying it.
    if (event.cron === INTEGRATION_SYNC_CRON) {
      job("integration sync", (async () => {
        // Read once for the whole run: the sync's writes and the push pass over every workspace take it,
        // instead of each resolving its own (a KV read apiece).
        const cfg = await resolveConfig(env);
        // FX3 finding 3: the sync and push are the only two fetchers this invocation ever runs,
        // and they share the platform's real 50-external-fetch ceiling, not one each. Counting
        // real fetch() calls made during the sync (rather than trusting any budget it tracks
        // itself) works regardless of which provider ran or how it accounts for its own calls.
        let syncFetches = 0;
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
          syncFetches++;
          return realFetch(...args);
        }) as typeof fetch;
        try {
          await runScheduledIntegrationSync(env, cfg);
        } catch (e) {
          console.error("integration sync failed (non-fatal):", e);
        } finally {
          globalThis.fetch = realFetch;
        }
        // Own try/catch, run after the sync regardless of whether it
        // succeeded: due items reaching a subscribed device must not depend
        // on the mirror sync's health, and a slow or failing sync must not
        // delay notifications past the hour they were due.
        try {
          const pushBudget = newPushBudget(Math.max(0, Math.min(MAX_PUSH_FETCHES_PER_RUN, PLATFORM_EXTERNAL_FETCH_BUDGET_PER_RUN - syncFetches)));
          await pushDueItemsAllWorkspaces(env, cfg, pushBudget);
        } catch (e) {
          console.error("push due items failed (non-fatal):", e);
        }
      })());
      return;
    }

    // Both insight schedules get their own invocation, and therefore their own
    // D1 and CPU budget. They must be routed explicitly: the fallthrough below
    // is maintenance, so without these each new trigger would run compression,
    // the graph pass and staleness a second and third time every day.
    //
    // Accrual and the PERSONAL weekly pass stay whole-corpus: they are already
    // budget-managed on their own invocations (#290), and cross-workspace
    // candidate pairs were handled in P1a, so a maintenance-style rotation
    // slice would only stretch coverage over K nights without buying headroom.
    //
    // The TEAM pass below is the one exception, and it is not that kind of
    // slice. It is not a rotation and it does not exist to save budget: it is
    // the same pass given the company workspaces so the shared layer stops
    // competing with every member's personal pairs for the same ten-candidate
    // slate and the same three write slots (spec 4.5). One implementation, two
    // invocations — see runWeeklyInsights's own note.
    if (event.cron === INSIGHT_ACCRUAL_CRON) {
      job("insight accrual", runInsightAccrual(env, ctx));
      return;
    }
    if (event.cron === INSIGHT_WEEKLY_CRON) {
      job("weekly insights", runWeeklyInsights(env, ctx));
      return;
    }

    // The team pass. Gated on config rather than on "is this a team brain",
    // because a brain can have a company workspace and still not want its
    // shared memory reasoned over — and an empty id list is a no-op either way.
    //
    // Every company workspace shares this one pass, and therefore its three
    // write slots: with two teams, team B competes with team A on exactly the
    // terms 4.5 stopped the shared layer competing with personal pairs on.
    // Known and DEFERRED — per-team scheduling belongs with the multi-team
    // switcher work, which is out of scope for this whole effort.
    //
    // WRITE SLOTS, and nothing else. What makes that deferral acceptable is
    // that losing a slot leaves a candidate `pending`, so it comes back next
    // week. Anything in this pass that SETTLES a candidate on another company's
    // state would destroy it instead, which is a different and much worse
    // outcome and is not what was accepted here. The novelty floor is the one
    // thing that settles, and it is keyed per workspace for exactly that
    // reason — see runWeeklyInsights.
    if (event.cron === INSIGHT_TEAM_WEEKLY_CRON) {
      job("team insights", (async () => {
        const cfg = await resolveConfig(env);
        if (cfg.TEAM_INSIGHTS !== "on") return;
        const ids = await companyWorkspaceIds(env);
        if (!ids.length) return;
        await runWeeklyInsights(env, ctx, { onlyWorkspaceIds: ids });
      })());
      return;
    }

    // Anything else runs maintenance: the nightly cron, and any invocation whose cron we
    // do not recognise (a hand-fired trigger, or a schedule added to wrangler.jsonc and
    // not yet routed here). Maintenance is the safe default — skipping it degrades recall
    // quality silently, whereas a skipped mirror sync is picked up on the next hour.
    //
    // One workspace slice per night (v3 Team Edition): the three passes share a single
    // resolved slice so the whole deployment moves through the ring together, one
    // workspace per night. A null slice (empty corpus, or the rotation read failed)
    // means every pass scans the whole corpus exactly as it did pre-v3. Direct and
    // manual callers — admin routes that re-trigger these passes — never pass a slice.
    const slice = await nextWorkspace(env);
    // The three passes used to be three independent waitUntil()s so one
    // failing never delayed or hid the others. They still run concurrently
    // and still log their own failures independently below, bundled into one
    // job() only so their counts can be collected once the night is over and
    // handed to recordNightSummary in a single, fully-built write (never a
    // partial record; see src/runtime/night-summary.ts). insightsProposed is
    // always 0 here: the weekly insight pass runs on its own cron trigger
    // (INSIGHT_WEEKLY_CRON / INSIGHT_TEAM_WEEKLY_CRON above) and never inside
    // this invocation.
    //
    // The when-extraction pass runs AFTER these three, not alongside them: it
    // is capped at WHEN_EXTRACT_PER_NIGHT model calls and its own ten-D1-
    // statement budget, on top of what compression/graph/staleness already
    // spend, and keeping it sequential and separately caught means a slow or
    // failing model call cannot delay or hide the other three the way
    // bundling it into the same Promise.allSettled would.
    job("nightly maintenance", (async () => {
      const [compression, graph, staleness] = await Promise.allSettled([
        runNightlyCompression(env, ctx, slice),
        runGraphPass(env, ctx, slice),
        runStalenessPass(env, ctx, slice),
      ]);
      if (compression.status === "rejected") console.error("nightly compression failed (non-fatal):", compression.reason);
      if (graph.status === "rejected") console.error("graph pass failed (non-fatal):", graph.reason);
      if (staleness.status === "rejected") console.error("staleness pass failed (non-fatal):", staleness.reason);

      let whenExtracted = 0;
      let whenJudged = 0;
      let whenSkipped = 0;
      try {
        const whenResult = await runWhenExtractPass(env, ctx, slice);
        whenExtracted = whenResult.whenExtracted;
        whenJudged = whenResult.whenJudged;
        whenSkipped = whenResult.whenSkipped;
        // The pass has already rolled its own cursor back when this is
        // false (Finding 1) — logged here only so a real outage is visible
        // in the tail, not to retry: retrying is what next night already does.
        if (!whenResult.ok) console.error("when-extraction pass: batch write failed, cursor not advanced (non-fatal)");
      } catch (e) {
        console.error("when-extraction pass failed (non-fatal):", e);
      }

      // Same shape as the when pass: sequential and separately caught after
      // the core three. An FTS failure here is non-fatal and recoverable —
      // the nightly try/catch logs it, and whichever write hit the index
      // first triggers its own repair — so it must not delay or hide the
      // when counts or the night summary.
      try {
        await runFtsMaintenance(env);
      } catch (e) {
        console.error("FTS maintenance failed (non-fatal):", e);
      }

      // Trash purge and the resume of a pending member removal, on one rows-written budget.
      try {
        await runNightlyCleanup(env, ctx);
      } catch (e) {
        console.error("Nightly cleanup failed (non-fatal):", e);
      }

      // Deferred indexing (rows left at vector_ids '[]', e.g. an undo past its inline re-embed
      // budget): a small bounded slice each night, so none waits on a caller. No cron of its own.
      try {
        await runNightlyVectorizePending(env, () => resolveConfig(env));
      } catch (e) {
        console.error("Nightly vectorize-pending failed (non-fatal):", e);
      }

      // No single workspace to attribute the summary to: an empty corpus (nothing
      // ran) or a rotation read failure (the passes fell back to a whole-corpus
      // scan pre-v3 style, which spans every workspace, not one).
      //
      // `== null` deliberately, not `!slice`: "" is the legacy pre-team bucket
      // and a genuine ring member (src/runtime/rotation.ts), so it must write
      // night:'' like any other slice. Only null/undefined skip the write.
      // GET /stats/night reads it back for admins via readableWorkspaces.
      if (slice == null) return;

      await recordNightSummary(env, slice, {
        digestsWritten: compression.status === "fulfilled" ? compression.value.digestsWritten : 0,
        linksInferred: graph.status === "fulfilled" ? graph.value.inserted : 0,
        claimsFlagged: staleness.status === "fulfilled" ? staleness.value.flagged : 0,
        insightsProposed: 0,
        whenExtracted,
        whenJudged,
        whenSkipped,
      });
    })());
  },
};
