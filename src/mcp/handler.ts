import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { requireIdentity } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      // Resolved once per request, the same way the REST routes do it: the
      // static AUTH_TOKEN short-circuits to the owner identity via the tenant
      // bootstrap, and an issued member token resolves to its own row. Every
      // tool below scopes its reads and writes through this value.
      const auth = await requireIdentity(request, env);
      if (auth instanceof Response) return auth;
      const server = buildMcpServer(env, ctx, auth);
      const isToolsList = await isMcpToolsListRequest(request);
      const response = await createMcpHandler(server)(request, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
