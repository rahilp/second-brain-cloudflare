import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const server = buildMcpServer(env, ctx);
      const isToolsList = await isMcpToolsListRequest(request);
      const response = await createMcpHandler(server)(request, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
