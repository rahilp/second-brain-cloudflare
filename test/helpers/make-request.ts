const BASE = "http://localhost";
const TOKEN = "test-token";

export function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null } = {}
): Request {
  const { body, token = TOKEN } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
