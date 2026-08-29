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
 * Asks a brain who is holding this token. Never rejects and never hangs.
 *
 * Every failure — a Worker too old to serve the route, a 401/403/404, a body
 * that will not parse, a request that never lands — reduces to the same
 * unanswered shape, which `roleFromProbe` turns into "member". That is the
 * point: the failure this whole module exists to fix is the app telling a
 * member they are the owner-admin, so an unanswerable probe must claim less,
 * not more.
 */
export async function fetchRoleProbe(
  fetchImpl: ProbeFetch,
  brainUrl: string,
  token: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ role: string | null; owner: boolean }> {
  const unanswered = { role: null, owner: false };
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
      const body = (await res.json()) as { profile?: { role?: unknown; owner?: unknown } } | null;
      const profile = body?.profile;
      return {
        role: typeof profile?.role === "string" ? profile.role : null,
        owner: profile?.owner === true,
      };
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

/** Which team-card copy this role gets. Returns a key, never a string. */
export function teamCardKeys(role: ConnectionRole): { label: string; body: string } {
  const label = "details.teamCardLabel";
  if (role === "owner") return { label, body: "details.teamCardBody" };
  if (role === "admin") return { label, body: "details.teamCardBodyAdmin" };
  return { label, body: "details.teamCardBodyMember" };
}

/** Whether this install may offer to change the brain's password. */
export function canRotatePassword(role: ConnectionRole): boolean {
  return role === "owner";
}
