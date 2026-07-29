/**
 * Config read/write surface for the desktop app (#245, consumed by #246).
 *
 * Authenticated with the same AUTH_TOKEN as the rest of the API: the Worker
 * stores and reads config, and the desktop app is the only writer.
 *
 * The response deliberately carries three things rather than one — the
 * effective values, the sparse overrides, and the shipped defaults. A settings
 * UI needs all three to render a row as "changed from 0.6 to 0.4" and to know
 * whether a reset control should be active at all, and deriving that from the
 * effective values alone is impossible once an override happens to equal a
 * default.
 */
import type { Env } from "../env";
import { json, requireAuth } from "../lib/http";
import {
  DEFAULTS,
  readOverrides,
  resetOverride,
  resolveConfig,
  writeOverrides,
  type ConfigKey,
} from "../config";

export async function handleConfigRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /config — effective values, what is overridden, and the shipped defaults
  if (url.pathname === "/config" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const [config, overrides] = await Promise.all([resolveConfig(env), readOverrides(env)]);
    return json({ ok: true, config, overrides, defaults: DEFAULTS });
  }

  // PATCH /config — sparse update; the whole patch is rejected if any key fails
  if (url.pathname === "/config" && request.method === "PATCH") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let patch: Record<string, unknown>;
    try {
      patch = await request.json() as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return json({ ok: false, error: "Body must be an object of setting → value" }, 400);
    }

    const result = await writeOverrides(env, patch as never);
    // 400 rather than 422: the message names the offending key or the invariant
    // it breaks, which is what the settings UI surfaces to the user.
    if (!result.ok) return json({ ok: false, error: result.error }, 400);

    return json({ ok: true, config: await resolveConfig(env) });
  }

  // DELETE /config/:key — per-setting reset, independent of every other setting
  if (url.pathname.startsWith("/config/") && request.method === "DELETE") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const key = decodeURIComponent(url.pathname.slice("/config/".length));
    if (!(key in DEFAULTS)) {
      return json({ ok: false, error: `${key} is not a known setting` }, 404);
    }

    await resetOverride(env, key as ConfigKey);
    return json({ ok: true, config: await resolveConfig(env) });
  }

  return null;
}
