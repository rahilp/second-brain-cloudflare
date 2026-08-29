/**
 * Who is holding the token this install was set up with.
 *
 * Three answers, because the app has three different things to say. "owner" is
 * the identity holding this deployment's AUTH_TOKEN — the person who created
 * the brain in their own Cloudflare account, and the only one who can rotate
 * the password or update the Worker. "admin" is a team admin holding a member
 * token with the admin role: they can invite people from the dashboard but have
 * no Cloudflare account here, so both of those dead-end for them. "member" can
 * do neither.
 *
 * The brain itself decides which, through GET /team/me. Nothing local is
 * evidence of ownership — see `RoleProbe.owner` for the signal this replaced
 * and why it was wrong.
 *
 * Derived, never stored: a member promoted to admin in the dashboard would
 * otherwise keep whatever this app decided on the day they installed it.
 *
 * Imports nothing, deliberately — `main.ts` resolves `#app` at module scope and
 * cannot be loaded outside a webview, so the rules only get a test if they live
 * somewhere a test runner can reach. Same arrangement as `rotation-state.ts`.
 */
export type ConnectionRole = "owner" | "admin" | "member";

/** What one look at the brain can tell this app about the token it holds. */
export interface RoleProbe {
  /** Does this brain have anyone on it but its owner? */
  team: boolean;
  /** `profile.role` from GET /team/me, or null if it could not be read. */
  role: string | null;
  /**
   * `profile.owner` from GET /team/me — true only for the identity holding this
   * deployment's AUTH_TOKEN.
   *
   * This is the app's ONLY evidence of ownership, and it deliberately replaced
   * the previous one. That was `signedInToCloudflare()` — `accounts.length > 0`,
   * a module global in `main.ts` set by any successful `connect_cloudflare` in
   * the window and never cleared. It meant "somebody logged into some Cloudflare
   * account here", not "this person controls the deployment", and the app's own
   * primary connect path walked a member straight through it: sign in to
   * Cloudflare (the primary button), discovery finds nothing because the brain
   * is in the OWNER's account, fall through to manual entry, paste the invite
   * token — and the app then told a member they were the owner-admin.
   *
   * The brain is the authority on this and nothing else is. Least privilege
   * does the rest: anything that is not a literal `true` is not ownership.
   */
  owner: boolean;
  /**
   * True only when `/team/me` answered with a well-formed profile that carried
   * NO `owner` key at all — a Worker deployed before the key existed.
   *
   * Deliberately not read by `roleFromProbe`: a legacy Worker cannot say who is
   * holding the token, so nobody is promoted by it. It exists for one caller,
   * `canUpdateWorker`, and the reasoning is in that function's comment.
   */
  legacyWorker?: boolean;
}

export function roleFromProbe(probe: RoleProbe): ConnectionRole {
  // A brain with one user is its owner's, whatever token opened it. This
  // short-circuits before any /team/me request, so a solo install pays nothing.
  if (!probe.team) return "owner";
  // Ahead of `role`, because `role` cannot answer this: src/lib/tenancy.ts
  // hashes AUTH_TOKEN into a users row with role 'admin', so the owner and a
  // colleague they promoted are the same value there.
  //
  // `=== true`, not truthy: a 200 carrying `owner: "yes"` is an unexpected body,
  // and an unexpected body must not promote anyone.
  if (probe.owner === true) return "owner";
  if (probe.role === "admin") return "admin";
  // Everything else — "member", an unrecognised string, or `null` from a Worker
  // too old to answer /team/me, a non-2xx, a timeout, or a request that never
  // landed — falls to the least-privileged answer. Under-claiming costs a
  // hidden button; over-claiming is the sentence this module exists to delete.
  return "member";
}

/**
 * How long the app will wait for `/team/me` before answering without it.
 *
 * A rejected fetch already reduces to "member". A fetch that never settles did
 * not: `existingTeamScreen` awaits this probe before the next screen, so a brain
 * behind a black-holed TCP connection or a captive portal left the user on
 * "Checking…" with no route forward but quitting the app — the safe default
 * being unreachable exactly when it was most needed. Long enough for a cold
 * Worker on a slow link, short enough to be a pause rather than a hang.
 */
export const PROBE_TIMEOUT_MS = 8000;

/** The subset of `fetch` this probe uses, so a test can pass a function. */
type ProbeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Reads a 200 from `/team/me` into the three facts the app can act on.
 *
 * A 200 is not a promise about shape, and there are three different things a
 * body can mean, not two:
 *
 *   1. it carries a boolean `owner` — the brain has answered, trust it;
 *   2. it is well formed but has NO `owner` key — a Worker deployed before the
 *      key existed, positively identified as such;
 *   3. anything else — no profile, no string role, or an `owner` key that is
 *      present but is not a boolean — nothing was established.
 *
 * (3) deliberately swallows `owner: "yes"` and friends. The key being THERE and
 * unreadable is not the same fact as the key being ABSENT: the first is a body
 * no brain this app talks to would send, and an unexpected body must not
 * license anything. Only a genuine absence, alongside a role the Worker did
 * manage to state, counts as legacy.
 */
function answerToProbe(body: unknown): { role: string | null; owner: boolean; legacyWorker: boolean } {
  const profile = (body as { profile?: unknown } | null)?.profile;
  if (profile === null || typeof profile !== "object") {
    return { role: null, owner: false, legacyWorker: false };
  }
  const p = profile as { role?: unknown; owner?: unknown };
  const role = typeof p.role === "string" ? p.role : null;
  return {
    role,
    owner: p.owner === true,
    // `in`, not `=== undefined`: JSON cannot produce an explicit `undefined`,
    // so the key's absence is exactly the signal, and a role the Worker DID
    // state is what makes the absence evidence rather than silence.
    legacyWorker: role !== null && !("owner" in p),
  };
}

/**
 * Asks a brain who is holding this token. Never rejects and never hangs.
 *
 * Every failure — a 401/403/404, a body that will not parse, a request that
 * never lands — reduces to the same unanswered shape, which `roleFromProbe`
 * turns into "member". That is the point: the failure this whole module exists
 * to fix is the app telling a member they are the owner-admin, so an
 * unanswerable probe must claim less, not more.
 *
 * A Worker too old to carry `owner` is NOT one of those failures, and the
 * distinction is the whole of `legacyWorker` — see `answerToProbe`.
 */
export async function fetchRoleProbe(
  fetchImpl: ProbeFetch,
  brainUrl: string,
  token: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ role: string | null; owner: boolean; legacyWorker: boolean }> {
  const unanswered = { role: null, owner: false, legacyWorker: false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A race rather than an abort alone: aborting asks the transport to stop, and
  // a transport that ignores its signal could otherwise still hold the screen
  // open. Answering on the timer means the least-privileged default is reached
  // whatever the transport does.
  const gaveUp = new Promise<typeof unanswered>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(unanswered);
    }, timeoutMs);
  });

  const asked = (async () => {
    try {
      const res = await fetchImpl(`${brainUrl.replace(/\/+$/, "")}/team/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) return unanswered;
      return answerToProbe(await res.json());
    } catch {
      return unanswered;
    }
  })();

  try {
    return await Promise.race([asked, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Connection details window's version of the same question.
 *
 * That window has no token — it stays in the Rust core — so it asks through the
 * `connection_role` Tauri command, whose answer arrives as whatever
 * `invoke` deserialised, or `null` if the command itself failed. Narrowing it
 * here rather than in `details.ts` is what makes the window's role testable:
 * `details.ts` resolves `#app` at module scope and cannot be imported by a test.
 *
 * `teamMode` comes from the keychain via `get_connection_details`, so a solo
 * install answers "owner" without asking the brain anything at all.
 */
export function roleFromDetailsProbe(teamMode: boolean, probe: unknown): ConnectionRole {
  const p = (probe ?? null) as { role?: unknown; owner?: unknown } | null;
  return roleFromProbe({
    team: teamMode,
    role: typeof p?.role === "string" ? p.role : null,
    owner: p?.owner === true,
  });
}

/**
 * The same window's version of "is this brain's Worker too old to say?".
 *
 * Separate from `roleFromDetailsProbe` because it answers a different question
 * and feeds a different decision: the role decides what the window CLAIMS, this
 * decides only whether the Worker-update button is reachable. Both narrow the
 * same `invoke` result, so the window pays for one round trip, not two.
 *
 * `=== true` and nothing else: a probe that failed is `null`, and a `null` probe
 * is not a legacy Worker — it is no answer at all.
 */
export function legacyWorkerFromDetailsProbe(probe: unknown): boolean {
  return (probe as { legacyWorker?: unknown } | null)?.legacyWorker === true;
}

/** Which team-card copy this role gets. Returns a key, never a string. */
export function teamCardKeys(role: ConnectionRole): { label: string; body: string } {
  const label = "details.teamCardLabel";
  if (role === "owner") return { label, body: "details.teamCardBody" };
  if (role === "admin") return { label, body: "details.teamCardBodyAdmin" };
  return { label, body: "details.teamCardBodyMember" };
}

/**
 * Whether this install may offer to change the brain's password.
 *
 * Takes a role and nothing else, and must keep taking a role and nothing else.
 * The Worker-update route below has a legacy allowance and this one deliberately
 * does not — the asymmetry is explained there, and the two rules are NOT the
 * same rule wearing different names any more.
 */
export function canRotatePassword(role: ConnectionRole): boolean {
  return role === "owner";
}

/**
 * Whether this install may offer to update the deployed Worker.
 *
 * The same answer as `canRotatePassword`, for the same reason and not by
 * coincidence: both redeploy something inside the Cloudflare account the Worker
 * lives in, and `start_worker_update` resolves that account by matching the
 * brain's workers.dev subdomain against the signed-in session. A team admin has
 * no more access to it than a member does, so "admin" does not unlock this.
 *
 * The desktop app self-updates from GitHub Releases with no Cloudflare
 * involvement, which is why this matters: a member keeping their app current
 * pushes their BUNDLED Worker version ahead of the team's DEPLOYED one, so
 * `is_behind` is true on every launch and stays true until the owner acts.
 * Without this gate they were offered the update every single time, and it
 * could never succeed.
 *
 * `legacyWorker` is the escape hatch's own escape hatch, and it exists because
 * the gate above, alone, is a DEADLOCK. The app self-updates from GitHub
 * Releases and the Worker can only be updated FROM the app, so the app is always
 * ahead of the deployment. On a brain whose deployed Worker predates `owner`:
 * `/team/me` answers without it → the role is indeterminate → least privilege
 * suppresses this route → and this route is the only thing that deploys the
 * Worker that adds `owner`. The way out was gated on a capability only the
 * version you are trying to reach reports.
 *
 * So a POSITIVELY IDENTIFIED legacy Worker (answered, well formed, no `owner`
 * key — not "the probe failed", which stays suppressed) opens this one route.
 * That is not a weakening: `start_worker_update` resolves the hosting account
 * by matching the brain's workers.dev subdomain against the signed-in
 * Cloudflare session and answers ErrorWrongCfAccount to anyone else, so the
 * real gate here was never the role. And it self-heals — after one successful
 * update the brain can say who is asking, and this argument is false forever
 * after.
 *
 * THE ASYMMETRY WITH `canRotatePassword` IS DELIBERATE. Do not simplify the two
 * back into one rule. Rotation gets no legacy allowance because rotation is not
 * a way out of anything: nobody needs a new password to update a Worker, the
 * card comes back on its own once the Worker can answer, and unlike this route
 * the app cannot tell an owner from a member while it is suppressed.
 *
 * Defaults to false so that a caller who has not thought about it gets the
 * least-privileged answer rather than the allowance.
 */
export function canUpdateWorker(role: ConnectionRole, legacyWorker: boolean = false): boolean {
  return role === "owner" || legacyWorker;
}
