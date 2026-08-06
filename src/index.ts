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
    if (token === (env as Env).AUTH_TOKEN) {
      return { props: { userId: "owner" } };
    }
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
    const job = (name: string, run: Promise<void>) =>
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

    // Anything else runs maintenance: the nightly cron, and any invocation whose cron we
    // do not recognise (a hand-fired trigger, or a schedule added to wrangler.jsonc and
    // not yet routed here). Maintenance is the safe default — skipping it degrades recall
    // quality silently, whereas a skipped mirror sync is picked up on the next hour.
    job("nightly compression", runNightlyCompression(env, ctx));
    job("graph pass", runGraphPass(env, ctx));
    job("staleness pass", runStalenessPass(env, ctx));
  },
};
