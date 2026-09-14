import type { Env } from "../env";
import { CORS_HEADERS } from "../lib/http";
import { handleOAuthAuthorize } from "../oauth/authorize";
import { ensureDbReady } from "../runtime/state";
import { handleCaptureRoutes } from "./capture";
import { handlePromptCapsuleRoutes } from "./prompt-capsule";
import { handleRecallRoutes } from "./recall";
import { handleEntriesRoutes } from "./entries";
import { handleGraphRoutes } from "./graph";
import { handleIntegrationsRoutes } from "./integrations";
import { handleAdminRoutes } from "./admin";
import { handleBriefRoutes } from "./brief";
import { handleConfigRoutes } from "./config";
import { handleMigrationRoutes } from "./migration";
import { handleOAuthRevokeRoutes } from "./oauth-revoke";

type RouteHandler = (
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response | null>;

const routeHandlers: RouteHandler[] = [
  handleCaptureRoutes,
  handlePromptCapsuleRoutes,
  handleRecallRoutes,
  handleEntriesRoutes,
  handleGraphRoutes,
  handleIntegrationsRoutes,
  handleAdminRoutes,
  handleBriefRoutes,
  handleConfigRoutes,
  handleMigrationRoutes,
  handleOAuthRevokeRoutes,
];

export function createDefaultHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // OAuth authorize endpoint — hosted login page for browser-based MCP clients.
      if (url.pathname === "/oauth/authorize") {
        return handleOAuthAuthorize(request, env);
      }

      ensureDbReady(ctx, env);

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
      }

      for (const handler of routeHandlers) {
        const response = await handler(request, url, env, ctx);
        if (response) return response;
      }

      return new Response("Not found", { status: 404 });
    },
  };
}

export const defaultHandler = createDefaultHandler();
