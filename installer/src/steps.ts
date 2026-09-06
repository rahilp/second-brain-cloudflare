/**
 * The setup spine — what the left rail draws, and which of its steps a user is
 * allowed to click their way back into.
 *
 * Setup has never had a fixed number of screens: creating a brain, connecting
 * to one you already have, and pasting a team token are three different walks
 * through the same file, and half the screens in `main.ts` are transient (a
 * scan running), a question asked once (which Cloudflare account?), or a guard
 * that stopped before touching anything. A rail that counted screens would
 * therefore count something different for every user, and would jump backwards
 * every time a guard interrupted.
 *
 * So the rail counts *steps*, and every screen maps onto one. Transient
 * screens, pickers and guards resolve to the step they belong to and mark the
 * rail paused rather than adding a position of their own — which is why this
 * whole module is a pair of pure lookups over plain data, exported for
 * `test/unit/steps.test.ts` the same way `ridge.ts` and `rotation-state.ts`
 * export theirs. `main.ts` supplies the screen name and the path; nothing here
 * touches the DOM or the wizard's mutable state.
 */

/** A position on the rail. Not every path has every one of these. */
export type StepId =
  | "start"
  | "protect"
  | "signIn"
  | "find"
  | "connect"
  | "build"
  | "tools"
  | "details";

/**
 * Which walk through setup the user is on.
 *
 * `token` is the member/manual door: someone handed an address and a sign-in
 * token, who never signs in to Cloudflare and never scans for anything. It is
 * not derived from `connectionRole` — the brain only reports who is holding
 * the token on the *second to last* screen, and retroactively deleting the
 * steps someone just completed is worse than showing one step they skipped.
 * It is derived from the door they took instead, which is known immediately.
 */
export type PathId = "new" | "existing" | "token";

/**
 * The three spines, in the order `main.ts` actually walks them.
 *
 * Tools before Details on every path: `progressScreen` and `existingTeamScreen`
 * both hand off to `toolsScreen`, whose only forward control is "Continue to
 * connection details". A rail that listed them the other way round would count
 * down while the user moved forward.
 */
export const SPINES: Record<PathId, readonly StepId[]> = {
  new: ["start", "protect", "connect", "build", "tools", "details"],
  existing: ["start", "signIn", "find", "connect", "tools", "details"],
  token: ["start", "connect", "tools", "details"],
};

/** The i18n key each step's label lives under. */
export const STEP_LABEL_KEYS: Record<StepId, `steps.${string}`> = {
  start: "steps.start",
  protect: "steps.protect",
  signIn: "steps.signIn",
  find: "steps.find",
  connect: "steps.connect",
  build: "steps.build",
  tools: "steps.tools",
  details: "steps.details",
};

/**
 * Every screen in `main.ts` that renders through `show()`, named once here.
 *
 * `accountPickerScreen` and `manualEntryScreen` appear under more than one
 * name because they are the same render used for two different questions —
 * "which account do I scan?" is a Find, "which account do I build in?" is a
 * Connect — and the rail has to say which one is happening.
 */
export type ScreenName =
  // Creating a new brain.
  | "welcome"
  | "audience"
  | "password"
  | "cloudflare"
  | "cloudflareWaiting"
  | "accountPickerProvision"
  | "progress"
  | "progressFailed"
  | "existingBrainGuard"
  | "resourceConflictGuard"
  // Connecting to a brain that already exists.
  | "connectExisting"
  | "searching"
  | "accountPickerDiscover"
  | "brainPicker"
  | "unlockBrain"
  | "manualEntry"
  | "memberTokenHelp"
  | "existingTeam"
  // Shared close.
  | "tools"
  | "details"
  // Rail-less flows: management, not onboarding.
  | "workerUpdate"
  | "rotation"
  | "stalePassword";

interface ScreenMapping {
  step: StepId;
  /**
   * A screen the user cannot advance from by choosing — a scan running, a
   * sign-in being watched, a guard explaining why nothing happened. The rail
   * mutes and stops accepting clicks rather than moving.
   */
  paused?: boolean;
  /** The step is doing work right now: draw the spinner in place of a number. */
  running?: boolean;
}

/**
 * Screen to step. `null` means the rail does not belong on that screen at all.
 *
 * The three `null`s are all launch modes rather than onboarding: changing or
 * recovering a password (`rotation`), updating a deployed Worker
 * (`workerUpdate`), and re-entering a password this computer no longer has
 * (`stalePassword`). None of them starts at the welcome screen and none of
 * them ends at the tools list, so a six-step onboarding rail on any of them
 * would tick off steps that never ran.
 */
export const SCREEN_STEPS: Record<ScreenName, ScreenMapping | null> = {
  welcome: { step: "start" },
  audience: { step: "start" },
  password: { step: "protect" },
  cloudflare: { step: "connect" },
  cloudflareWaiting: { step: "connect", paused: true },
  accountPickerProvision: { step: "connect" },
  progress: { step: "build", running: true },
  progressFailed: { step: "build", paused: true },
  existingBrainGuard: { step: "build", paused: true },
  resourceConflictGuard: { step: "build", paused: true },
  connectExisting: { step: "signIn" },
  searching: { step: "find", paused: true },
  accountPickerDiscover: { step: "find" },
  brainPicker: { step: "find" },
  unlockBrain: { step: "connect" },
  manualEntry: { step: "connect" },
  memberTokenHelp: { step: "connect", paused: true },
  existingTeam: { step: "connect" },
  tools: { step: "tools" },
  details: { step: "details" },
  workerUpdate: null,
  rotation: null,
  stalePassword: null,
};

export interface RailStep {
  id: StepId;
  /** 1-based, for the compact "step 3 of 6" row and the numbered marks. */
  index: number;
  state: "done" | "current" | "todo";
}

export interface RailModel {
  path: PathId;
  steps: RailStep[];
  current: StepId;
  /** 1-based position of `current` in `steps`. */
  index: number;
  total: number;
  paused: boolean;
  running: boolean;
}

/** The rail for a screen, or `null` when the screen has no rail. */
export function railFor(screen: ScreenName, path: PathId): RailModel | null {
  const mapping = SCREEN_STEPS[screen];
  if (!mapping) return null;
  const spine = SPINES[path];
  const at = spine.indexOf(mapping.step);
  // A step that is not on this path's spine means `main.ts` set a screen and a
  // path that cannot co-occur. Drawing a rail with no current position would
  // be a lie about where the user is, so it draws nothing.
  if (at < 0) return null;
  return {
    path,
    steps: spine.map((id, i) => ({
      id,
      index: i + 1,
      state: i < at ? "done" : i === at ? "current" : "todo",
    })),
    current: mapping.step,
    index: at + 1,
    total: spine.length,
    paused: mapping.paused === true,
    running: mapping.running === true,
  };
}

/**
 * The steps a user can still walk back into.
 *
 * Everything from provisioning onward is history: `start_provisioning` writes
 * to a real Cloudflare account, `connect_existing` writes to the keychain, and
 * neither has an undo in this app. So the rail refuses to leave any step at or
 * past that line rather than inventing a reset that the Back buttons never
 * needed to have.
 */
export const POINT_OF_NO_RETURN: readonly StepId[] = ["build", "tools", "details"];

/**
 * Steps that have a screen function safe to re-enter from anywhere ahead of
 * them. Everything else is unreachable by design: `connect` is the sign-in and
 * the brain-unlock step, and re-entering either from further along would need
 * state resets that no existing Back button performs.
 */
const JUMPABLE: readonly StepId[] = ["start", "protect", "signIn", "find"];

export interface JumpContext {
  /** An await is in flight on the current screen (a connect, a check). */
  busy?: boolean;
  /** `connect_cloudflare` has already succeeded in this window. */
  signedIn?: boolean;
  /** A discovery result is still held, so the picker can be re-opened. */
  hasFound?: boolean;
}

export function allowedBackSteps(
  screen: ScreenName,
  path: PathId,
  ctx: JumpContext = {},
): StepId[] {
  const model = railFor(screen, path);
  if (!model) return [];
  // Nothing moves while a request is out, and nothing moves off a guard: a
  // guard screen exists to say what happened and offer the one way on.
  if (ctx.busy || model.paused) return [];
  if (POINT_OF_NO_RETURN.includes(model.current)) return [];
  return model.steps
    .filter((s) => s.state === "done")
    .map((s) => s.id)
    .filter((id) => {
      if (!JUMPABLE.includes(id)) return false;
      // The password step is only re-enterable while it is still only in
      // memory. Once Cloudflare has been signed in to, the way back to it is
      // two screens long and no single Back button makes that jump.
      if (id === "protect") return ctx.signedIn !== true;
      // "Back to Find" re-opens the picker the scan produced. With no scan
      // held there is nothing to re-open.
      if (id === "find") return ctx.hasFound === true;
      return true;
    });
}

export function canJumpBack(
  screen: ScreenName,
  path: PathId,
  target: StepId,
  ctx: JumpContext = {},
): boolean {
  return allowedBackSteps(screen, path, ctx).includes(target);
}
