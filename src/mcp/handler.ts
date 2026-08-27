import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      const server = buildMcpServer(env, ctx, auth);
      const isToolsList = await isMcpToolsListRequest(request);
      const response = await createMcpHandler(server)(request, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
