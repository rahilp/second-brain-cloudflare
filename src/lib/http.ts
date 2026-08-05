import type { Env } from "../env";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function isAuthorized(request: Request, env: Env): boolean {
  if (request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`) return true;
  return new URL(request.url).searchParams.get("token") === env.AUTH_TOKEN;
}

// Returns a 401 Response if the request lacks a valid token, otherwise null —
// lets routes early-return with `const authErr = requireAuth(...); if (authErr) return authErr;`
export function requireAuth(request: Request, env: Env): Response | null {
  if (isAuthorized(request, env)) return null;
  return json({ ok: false, error: "Unauthorized" }, 401);
}

// Anchored so the whole value has to be an integer. parseInt stops at the first
// character it cannot use, which is how "7abc" became 7, "1e3" became 1 and
// "0x10" became 0 — each of them a value the caller never wrote, accepted
// silently. Whatever it could not salvage became NaN, and NaN survives every
// Math.min/Math.max clamp, so the bad value reached the database: bound as a
// LIMIT it is a D1 SQLITE_MISMATCH (an HTTP 500), and compared against
// created_at it matches nothing, so a malformed date filter reads to the caller
// as an empty brain rather than a bad request.
const INTEGER = /^[+-]?\d+$/;

/**
 * Reads an integer query parameter, or returns the 400 to send back.
 *
 * Malformed is rejected rather than defaulted, which is how every other bad
 * value on this surface is already treated (an unknown `type`, `status` or
 * `action` is a 400, as is any bad value on the config write path) and how the
 * MCP twins of these routes behave, since zod rejects a non-integer outright.
 * `after` and `before` have no default to fall back to either — defaulting them
 * would drop the filter and answer with more rows than were asked for, which is
 * wrong data wearing a 200, the one failure a caller cannot detect.
 *
 * Out of range is still clamped, not rejected: `?n=200` means "as many as
 * you'll give me" and has always been answered with 100.
 *
 * Only an absent parameter gets the default. A present one must parse, and that
 * includes the empty forms `?after=` and `?after` — for the same reason as
 * above, since defaulting them drops the filter. It also means `?n=$UNSET` from
 * a shell says so instead of quietly becoming 20. This is a deliberate
 * divergence from the string parameters beside these, where `?tag=` reads as
 * absent: an empty tag filter has one obvious meaning, an empty timestamp does
 * not.
 *
 * Used as `const n = intParam(url, "n", …); if (n instanceof Response) return n;`
 * — the same early-return shape as requireAuth above.
 */
export function intParam(url: URL, name: string, opts: { fallback: number; min?: number; max?: number }): number | Response;
export function intParam(url: URL, name: string, opts?: { min?: number; max?: number }): number | undefined | Response;
export function intParam(
  url: URL,
  name: string,
  opts: { fallback?: number; min?: number; max?: number } = {},
): number | undefined | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return opts.fallback;

  // An empty value falls through to the check below and is rejected: it is
  // present, so it has to parse.
  const text = raw.trim();
  const value = Number(text);
  if (!INTEGER.test(text) || !Number.isSafeInteger(value)) {
    return json({ ok: false, error: `${name} must be an integer` }, 400);
  }

  const floored = opts.min === undefined ? value : Math.max(opts.min, value);
  return opts.max === undefined ? floored : Math.min(opts.max, floored);
}
