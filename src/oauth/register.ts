// Cursor (and other MCP clients) may register different OAuth redirect URIs across
// versions. Accept every known callback so authorize does not fail after a client update.
export const CURSOR_MCP_REDIRECT_URIS = [
  "http://localhost:8787/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
];

export async function augmentOAuthRegistrationRequest(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return request;
  }
  const existing = Array.isArray(body.redirect_uris) ? body.redirect_uris as string[] : [];
  const merged = [...new Set([...existing, ...CURSOR_MCP_REDIRECT_URIS])];
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, redirect_uris: merged }),
  });
}
