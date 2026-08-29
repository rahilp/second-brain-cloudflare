/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { runNightlyCompression } from "./compression/nightly";
import { runGraphPass } from "./graph/pass";
import { INTEGRATION_SYNC_CRON, runScheduledIntegrationSync } from "./integrations/mirror";
import { runStalenessPass } from "./staleness/pass";
import { nextWorkspace } from "./runtime/rotation";
import { runInsightAccrual } from "./insight/candidates";
import { companyWorkspaceIds, runWeeklyInsights } from "./insight/weekly";
import { INSIGHT_ACCRUAL_CRON, INSIGHT_TEAM_WEEKLY_CRON, INSIGHT_WEEKLY_CRON } from "./insight/schedule";
import { resolveConfig } from "./config";
import { resolveIdentityFromToken } from "./lib/identity";
import { apiHandler } from "./mcp/handler";
import { augmentOAuthRegistrationRequest } from "./oauth/register";
import { defaultHandler } from "./routes";

export type { Env } from "./env";

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken: async ({ token, env }) => {
    const e = env as Env;
    if (token === e.AUTH_TOKEN) {
      return { props: { userId: "owner" } };
    }
    const identity = await resolveIdentityFromToken(token, e);
    if (identity) return { props: { userId: identity.userId } };
    return null;
  },
});

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const augmented = await augmentOAuthRegistrationRequest(req);
      return oauthProvider.fetch(augmented, env as any, ctx);
    }
    return oauthProvider.fetch(req, env as any, ctx);
  },
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    // The jobs are independent, and each begins by awaiting the shared schema init. One
    // of them failing — including on that init — must not take the others down or surface
    // as an unhandled rejection inside waitUntil.
    // `Promise<unknown>` rather than `Promise<void>`: runInsightAccrual returns
    // a summary (seeds examined) for POST /insights/accrue to report, and this
    // scheduled path fires the same promise but never reads that value.
    const job = (name: string, run: Promise<unknown>) =>
      ctx.waitUntil(run.catch((e) => console.error(`${name} failed (non-fatal):`, e)));

    // Two schedules, two budgets (#290). A Worker invocation gets 50 D1 queries and 10 ms
    // of CPU on the free plan; the maintenance jobs below already spend 30 of those
    // queries, so the mirror sync gets its own invocation rather than the remainder of
    // this one. Routing on the cron string is what makes that real — without the branch
    // both triggers would run everything and the split would cost budget instead of
    // buying it.
    if (event.cron === INTEGRATION_SYNC_CRON) {
      job("integration sync", runScheduledIntegrationSync(env));
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
    job("nightly compression", runNightlyCompression(env, ctx, slice));
    job("graph pass", runGraphPass(env, ctx, slice));
    job("staleness pass", runStalenessPass(env, ctx, slice));
  },
};
