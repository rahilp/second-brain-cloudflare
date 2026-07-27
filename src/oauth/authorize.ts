import type { Env } from "../env";
import { authorizeErrorHint, authorizeErrorHtml, loginHtml } from "./pages";

export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthReq: any;
  try {
    // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
    // so parseAuthRequest reads the query params cleanly.
    const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
    oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("OAuth authorize parse failed:", detail);
    return new Response(authorizeErrorHtml(authorizeErrorHint(detail), detail), {
      status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "POST") {
    const form = await request.formData();
    if (form.get("password") !== env.AUTH_TOKEN) {
      return new Response(loginHtml("Invalid token"), {
        status: 401, headers: { "Content-Type": "text/html" },
      });
    }
    const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: "owner",
      scope: oauthReq.scope,
      props: { userId: "owner" },
    });
    return Response.redirect(redirectTo, 302);
  }
  return new Response(loginHtml(), { headers: { "Content-Type": "text/html" } });
}
