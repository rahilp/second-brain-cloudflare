/**
 * The decisions the password-change flow makes about *which* screen to show and
 * *what may honestly be claimed on it* (#235 §4).
 *
 * Deliberately free of DOM, of `@tauri-apps/api`, and of every import: the rest
 * of `main.ts` cannot be loaded outside a webview, and these are the rules whose
 * being wrong costs a user their brain - "nothing was changed" on a run where
 * something was, a heading that contradicts its own body, a local write that
 * failed and was never mentioned. They belong somewhere a test can reach them.
 *
 * `main.ts` holds the rendering; this holds the reasoning.
 */

/** Which failure happened, and with it what may honestly be claimed. */
export type RotateStage =
  /** Nothing reached Cloudflare; the old password still works. */
  | "notSent"
  /** The secret was accepted; health never went green. It may already be live. */
  | "unconfirmed"
  /** The brain has the new password; a local write did not. */
  | "local"
  /** A rebuild started while the flow was open, so nothing was attempted. */
  | "blocked";

export interface RotateError {
  stage: RotateStage;
  /** Already localised by Rust; fills the failure screen's detail slot. */
  detail: string;
}

/** What `rotate_password` reports when the remote change succeeded. */
export interface RotateOutcome {
  /** OS secure storage. False here means this computer can no longer open the brain. */
  keychain: boolean;
  /** null when the CLI was never installed - that is not a failure. */
  cliConfig: boolean | null;
  /**
   * The already-open dashboard window. The password is injected when that window
   * is *created*, so an open one keeps serving the old value until it is told
   * otherwise. True when there was no window to tell.
   */
  dashboard: boolean;
}

export type RotationScreen = "done" | "failLocal" | "failNotSent" | "failUnsure" | "blocked";

const STAGES: RotateStage[] = ["notSent", "unconfirmed", "local", "blocked"];

/**
 * Reads whatever `rotate_password` rejected with.
 *
 * Anything unreadable is treated as "may already be live", deliberately.
 * Telling someone their old password still works when it may not is the one
 * mistake in this flow that ends with a brain nobody can open.
 */
export function rotateErrorOf(e: unknown): RotateError {
  if (typeof e === "object" && e !== null) {
    const { stage, detail } = e as { stage?: unknown; detail?: unknown };
    if (typeof stage === "string" && (STAGES as string[]).includes(stage)) {
      return { stage: stage as RotateStage, detail: typeof detail === "string" ? detail : "" };
    }
  }
  return { stage: "unconfirmed", detail: String(e) };
}

/**
 * A run that succeeded remotely still has three places on this computer that
 * can have missed the new password, and the done screen opens by claiming none
 * of them did.
 */
export function screenForOutcome(outcome: RotateOutcome): "done" | "failLocal" {
  if (!outcome.keychain) return "failLocal";
  if (outcome.cliConfig === false) return "failLocal";
  if (!outcome.dashboard) return "failLocal";
  return "done";
}

/**
 * Which failure screen a run lands on.
 *
 * `mayBeLive` is sticky across every attempt in this window, and that is the
 * whole point of it. One attempt can PUT the secret and time out waiting for
 * confirmation - correctly reported as "may already be live" - and the *next*
 * attempt can then fail before the PUT, on an expired sign-in or a transient
 * lookup, which taken on its own is honestly `notSent`. Rendering the `notSent`
 * screen there would tell someone whose old password is already dead that
 * "everything is exactly as it was".
 *
 * So once any attempt has reached `unconfirmed`, the stages allowed to overrule
 * it are exactly two:
 *
 * - `local`, which is the brain confirming the new password - the ambiguity
 *   resolving in the direction that ends the doubt.
 * - `blocked`, which is not a resolution but an *instruction*, and the only
 *   screen that carries it. `blocked` was split out of `notSent` because an
 *   abandoned rebuild ledger blocks every attempt forever, and the way out is
 *   in Advanced Settings - somewhere no user would think to look. Letting the
 *   sticky flag route this to `failUnsure` puts a "Try again" button on a run
 *   that can never succeed and hides the one paragraph that says why.
 *
 * The two facts are not in competition: the run is blocked *and* an earlier
 * attempt may already have landed. `blockedCopy` carries the second onto the
 * blocked screen rather than trading one truth for the other.
 */
export function screenForFailure(stage: RotateStage, mayBeLive: boolean): RotationScreen {
  if (stage === "local") return "failLocal";
  if (stage === "blocked") return "blocked";
  if (mayBeLive) return "failUnsure";
  if (stage === "unconfirmed") return "failUnsure";
  return "failNotSent";
}

/** What the blocked screen says, once an earlier attempt is in the picture. */
export interface BlockedCopy {
  /**
   * The may-already-be-live warning, or null on a run where nothing was ever
   * sent and the old password demonstrably still works.
   */
  liveNotice: ChangePasswordKey | null;
  /**
   * The password card's label. `failNotSentLabel` calls it "not in use", which
   * is only true while nothing has been sent - after an `unconfirmed` attempt
   * it may be the one key that opens the brain, and saying otherwise to someone
   * deciding whether to keep it is the mistake that costs them the brain.
   */
  passwordLabel: ChangePasswordKey;
  /**
   * Whether leaving needs the acknowledgement the other may-be-live screen
   * uses. This window holds the only copy of a password that may already be
   * live, and the blocked screen offers no way to settle it.
   */
  guardLeaving: boolean;
}

export function blockedCopy(mayBeLive: boolean): BlockedCopy {
  if (!mayBeLive) {
    return {
      liveNotice: null,
      passwordLabel: "changePassword.failNotSentLabel",
      guardLeaving: false,
    };
  }
  return {
    liveNotice: "changePassword.blockedMayBeLive",
    passwordLabel: "changePassword.passwordLabel",
    guardLeaving: true,
  };
}

/** What the three-way "Check again" probe found. */
export type RecheckResult =
  /** The brain answers to the new password. */
  | "confirmed"
  /** The brain answered, and not to the new password. */
  | "notLive"
  /** We could not ask, so nothing is settled either way. */
  | "unreachable";

/**
 * The copy the "changed, but not saved here" screen is built from.
 *
 * Returned as i18n keys rather than strings so the choice can be asserted
 * without a locale: the bug this replaces was a heading that stayed
 * unconditional while its body switched, so title and body contradicted each
 * other and the title was the false one.
 */
/**
 * A dotted key in the `changePassword` namespace. Spelled as a template type
 * rather than imported from the catalogue so this module keeps its one useful
 * property - no imports at all, and therefore loadable outside a webview.
 */
export type ChangePasswordKey = `changePassword.${string}`;

export interface LocalFailureCopy {
  title: ChangePasswordKey;
  /** The warning notice at the top. */
  notice: ChangePasswordKey;
  /** Further lines below it, in order, for the stores the notice did not name. */
  extra: ChangePasswordKey[];
  /**
   * True when secure storage is the store that failed, which is the only case
   * where this computer can no longer open the brain on its own - and so the
   * only case where "Open my Second Brain" would 401 instead of working.
   */
  reconnect: boolean;
}

export function localFailureCopy(outcome: RotateOutcome | null): LocalFailureCopy {
  // A null outcome is the `"local"` stage: `persist` could not run at all, so
  // nothing on this computer was written and secure storage is among the misses.
  const keychainFailed = outcome === null || !outcome.keychain;
  const cliFailed = outcome !== null && outcome.cliConfig === false;
  const dashboardFailed = outcome !== null && !outcome.dashboard;

  if (keychainFailed) {
    const extra: ChangePasswordKey[] = [];
    if (cliFailed) extra.push("changePassword.failLocalCli");
    if (dashboardFailed) extra.push("changePassword.failLocalDashboard");
    return {
      title: "changePassword.failLocalTitle",
      notice: "changePassword.failLocalBody",
      extra,
      reconnect: true,
    };
  }

  // Secure storage took it, so this computer is fine and the unconditional
  // heading would be untrue. Something else here still holds the old one.
  const notice = cliFailed
    ? "changePassword.failLocalCli"
    : "changePassword.failLocalDashboard";
  const extra: ChangePasswordKey[] =
    cliFailed && dashboardFailed ? ["changePassword.failLocalDashboard"] : [];
  return {
    title: "changePassword.failLocalTitlePartial",
    notice,
    extra,
    reconnect: false,
  };
}

/* ------------------------------------------------------------------------- *
 * What crosses the IPC boundary.
 *
 * Everything below is a string the Rust side also spells out, and every one of
 * them type-checks perfectly when it is wrong: a step id is a legal `StepId`
 * whichever of the seven it is, and an `invoke` argument bag is
 * `Record<string, unknown>`. Both halves compile, the build passes, and the only
 * symptom is at runtime. So they live here, where a test can read them without
 * a webview, rather than inline at the call site where nothing can.
 * ------------------------------------------------------------------------- */

/**
 * The three rows of the password-change checklist, in the order they run.
 *
 * These are the `step` values `rotate_password` emits on `setup-progress`, and
 * they must match the `Step` variants in
 * `installer/src-tauri/src/cf/provision.rs` - `Step::Secret`, `Step::Confirm`,
 * `Step::Local` - as serialised by that enum's `rename_all`. The Rust end of
 * the same contract is pinned by
 * `the_step_ids_on_the_wire_are_the_ones_the_screens_key_on` in that file; this
 * is the other end. Both are needed, because either half can be renamed on its
 * own and still compile, which is exactly how a rotation once shipped emitting
 * `"finish"` at a checklist keyed on `"secret"` - three static bullets for the
 * whole run, under copy reading "Leave this window open".
 */
export const ROTATION_STEP_IDS = ["secret", "confirm", "local"] as const;

export type RotationStepId = (typeof ROTATION_STEP_IDS)[number];

/**
 * Adds Door B's address to a command's arguments.
 *
 * Both `rotate_password` and `recheck_password` take `address: Option<String>`,
 * and a missing key deserialises to `None` - which resolves the setup *stored on
 * this computer*. Door B is by definition a computer with no stored setup, so an
 * omitted address there does not mean "use the default", it means "probe the
 * wrong brain, or none at all". One helper, both callers, so the two cannot
 * drift apart again.
 */
export function withAddress(
  args: Record<string, unknown>,
  address: string | null,
): Record<string, unknown> {
  return address ? { ...args, address } : { ...args };
}

/**
 * The argument bag for `invoke("rotate_password", …)`.
 *
 * Tauri matches these keys to the command's parameters by name, camelCase to
 * snake_case, and an unmatched key is not a compile error at either end - it is
 * a deserialisation failure at runtime. `newPassword` here is `new_password` in
 * `commands::rotate_password`; renaming either alone breaks the call silently.
 */
export function rotateArgs(newPassword: string, address: string | null): Record<string, unknown> {
  return withAddress({ newPassword }, address);
}

/** The same, for `commands::recheck_password(password, address)`. */
export function recheckArgs(password: string, address: string | null): Record<string, unknown> {
  return withAddress({ password }, address);
}
