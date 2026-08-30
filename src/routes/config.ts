/**
 * Config read/write surface for the desktop app (#245, consumed by #246).
 *
 * Authenticated with the same AUTH_TOKEN as the rest of the API: the Worker
 * stores and reads config, and the desktop app is the only writer.
 *
 * GET /config is member-readable. PATCH and DELETE require admin — these values
 * drive deployment-wide AI, recall, compression, and team defaults.
 *
 * The response deliberately carries three things rather than one — the
 * effective values, the sparse overrides, and the shipped defaults. A settings
 * UI needs all three to render a row as "changed from 0.6 to 0.4" and to know
 * whether a reset control should be active at all, and deriving that from the
 * effective values alone is impossible once an override happens to equal a
 * default.
 */
import type { Env } from "../env";
import { json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { countActiveMembers } from "../lib/team-admin";
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
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const [config, overrides] = await Promise.all([resolveConfig(env), readOverrides(env)]);
    return json({ ok: true, config, overrides, defaults: DEFAULTS });
  }

  // PATCH /config — sparse update; the whole patch is rejected if any key fails
  if (url.pathname === "/config" && request.method === "PATCH") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    let patch: Record<string, unknown>;
    try {
      patch = await request.json() as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return json({ ok: false, error: "Body must be an object of setting → value" }, 400);
    }

    // TEAM_MODE "off" while colleagues are still here is the one config write
    // that can make the product lie: the dashboard drops every sharing control
    // and layer picker, while the company workspace still exists and every
    // member still holds a token that reads it. One source of truth or none.
    //
    // TWO MECHANISMS, DELIBERATELY, and this is the one that EXPLAINS. The one
    // that ENFORCES is the floor in isTeamBrain() (src/lib/team-admin.ts),
    // where real membership overrides a stored "off" so the invariant holds by
    // construction — which is what actually closes the hole this check cannot
    // see, "acquire members while it is already off". Keeping the refusal as
    // well is not redundancy: without it the admin's write would appear to
    // succeed and then be silently ignored, and a control that quietly does
    // nothing is worse than one that says why it will not.
    //
    // HERE, not inside writeOverrides, and not as an INVARIANT. writeOverrides
    // is the generic write path — per-key type and range checks, plus pure
    // synchronous invariants over the config object itself — and this rule is
    // neither generic nor pure: it is one key's rule and it needs a D1
    // headcount. Pushing it down would give every config write a database
    // dependency and make the config layer import the team schema to satisfy a
    // single setting. PATCH /config is writeOverrides' only non-test caller, so
    // this route is a complete boundary for the rule.
    //
    // Before the write, so a refused patch writes NOTHING — the same
    // all-or-nothing writeOverrides already gives a patch with a bad value in
    // it. "on" and "auto" are never blocked: the first only ever adds the
    // shared layer, and the second hands the decision back to what is actually
    // there.
    if (patch.TEAM_MODE === "off") {
      const activeMembers = await countActiveMembers(env);
      if (activeMembers > 1) {
        return json({
          ok: false,
          error:
            `Team mode cannot be turned off while ${activeMembers} people are still on the team. ` +
            `Remove the other members first — their shared memories stay, and their names stay on them.`,
        }, 400);
      }
    }

    const result = await writeOverrides(env, patch as never);
    // 400 rather than 422: the message names the offending key or the invariant
    // it breaks, which is what the settings UI surfaces to the user.
    if (!result.ok) return json({ ok: false, error: result.error }, 400);

    return json({ ok: true, config: await resolveConfig(env) });
  }

  // DELETE /config/:key — per-setting reset, independent of every other setting
  if (url.pathname.startsWith("/config/") && request.method === "DELETE") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const key = decodeURIComponent(url.pathname.slice("/config/".length));
    if (!(key in DEFAULTS)) {
      return json({ ok: false, error: `${key} is not a known setting` }, 404);
    }

    await resetOverride(env, key as ConfigKey);
    return json({ ok: true, config: await resolveConfig(env) });
  }

  return null;
}
