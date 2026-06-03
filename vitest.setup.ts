import { vi } from "vitest";

vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn().mockReturnValue(() => new Response("mcp")),
}));

// workers-oauth-provider imports `cloudflare:workers`, which the node test
// loader can't resolve. Stub it with a minimal router that mirrors the real
// provider's behaviour for tests: delegate non-apiRoute requests to the
// defaultHandler, and gate the apiRoute with resolveExternalToken (the static
// AUTH_TOKEN path) so the existing auth tests still pass.
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class {
    options: any;
    constructor(options: any) { this.options = options; }
    async fetch(request: Request, env: any, ctx: any): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === this.options.apiRoute) {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const grant = token ? await this.options.resolveExternalToken?.({ token, env }) : null;
        if (!grant) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401, headers: { "Content-Type": "application/json" },
          });
        }
        return this.options.apiHandler.fetch(request, env, ctx);
      }
      return this.options.defaultHandler.fetch(request, env, ctx);
    }
  },
}));
