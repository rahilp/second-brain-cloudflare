/**
 * Who is holding the token this install was set up with.
 *
 * Three answers, because the app has three different things to say. "owner"
 * is the person who provisioned the brain from this app — they have a
 * Cloudflare session for it and can rotate the password. "admin" is a team
 * admin holding a member token with the admin role: they can invite people
 * from the dashboard but cannot rotate the deployment's AUTH_TOKEN, because
 * that lives in Cloudflare and they have no account there. "member" can do
 * neither.
 *
 * Derived, never stored: a member promoted to admin in the dashboard would
 * otherwise keep whatever this app decided on the day they installed it.
 *
 * Imports nothing, deliberately — `main.ts` resolves `#app` at module scope and
 * cannot be loaded outside a webview, so the rules only get a test if they live
 * somewhere a test runner can reach. Same arrangement as `rotation-state.ts`.
 */
export type ConnectionRole = "owner" | "admin" | "member";

export function roleFromProbe(probe: {
  team: boolean;
  role: string | null;
  hasCloudflareSession: boolean;
}): ConnectionRole {
  // A brain with one user is its owner's, whatever token opened it. This
  // short-circuits before any /team/me request, so a solo install pays nothing.
  if (!probe.team) return "owner";
  // A Cloudflare session for the account the Worker lives in is the only
  // evidence this app can have that this person controls the deployment.
  if (probe.hasCloudflareSession) return "owner";
  if (probe.role === "admin") return "admin";
  // Everything else — "member", an unrecognised string, or `null` from a Worker
  // too old to answer /team/me, a non-2xx, or a request that never landed —
  // falls to the least-privileged answer. Under-claiming costs a hidden button;
  // over-claiming is the sentence this module exists to delete.
  return "member";
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
