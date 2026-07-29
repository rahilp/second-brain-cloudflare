import type { Env } from "../env";
import { CORS_HEADERS } from "../lib/http";
import { handleOAuthAuthorize } from "../oauth/authorize";
import { ensureDbReady } from "../runtime/state";
import { handleCaptureRoutes } from "./capture";
import { handleRecallRoutes } from "./recall";
import { handleEntriesRoutes } from "./entries";
import { handleGraphRoutes } from "./graph";
import { handleIntegrationsRoutes } from "./integrations";
import { handleAdminRoutes } from "./admin";
import { handleConfigRoutes } from "./config";

type RouteHandler = (
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response | null>;

const routeHandlers: RouteHandler[] = [
  handleCaptureRoutes,
  handleRecallRoutes,
  handleEntriesRoutes,
  handleGraphRoutes,
  handleIntegrationsRoutes,
  handleAdminRoutes,
  handleConfigRoutes,
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
