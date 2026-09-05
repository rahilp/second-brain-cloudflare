// The first-run setup flow. Six screens, one action each; every technical
// resource is described in plain language only. All real work happens in the
// Rust core — this file renders state and forwards clicks.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ConnectionDetails,
  ToolStatus,
  copyBothButton,
  detailCards,
  emailButton,
  h,
  icon,
  type IconName,
  secretCard,
  teamCard,
  toolRows,
} from "./shared";
import { PROBE_TIMEOUT_MS, fetchRoleProbe, roleFromProbe, type ConnectionRole } from "./connection-role";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getLocale, initI18n, LOCALE_CHANGE_EVENT, t } from "./i18n";
import {
  blockedCopy,
  localFailureCopy,
  recheckArgs,
  rotateArgs,
  rotateErrorOf,
  screenForFailure,
  screenForOutcome,
  ROTATION_STEP_IDS,
  type ChangePasswordKey,
  type RecheckResult,
  type RotateOutcome,
  type RotationStepId,
} from "./rotation-state";
import { mount as mountRidge, ridgeSay, ridgeOnScreenChange, hasSeenLine, shouldFireReaction } from "./ridge";
import {
  allowedBackSteps,
  railFor,
  STEP_LABEL_KEYS,
  type PathId,
  type ScreenName,
  type StepId as RailStepId,
} from "./steps";
import { SOURCE_LABEL_KEYS, STAT_KEYS, quoteFor } from "./valuePanel";
import "./style.css";

interface Account {
  id: string;
  name: string;
}

// The password change's three steps (#235) come from `ROTATION_STEP_IDS`, not
// from a second list written out here. They are none of the four provisioning
// steps — labelling "waiting for your Second Brain to accept it" as `recall`
// would mislead the next person to read this — and spelling them twice is how
// one copy gets renamed and the other does not.
type StepId = "space" | "memory" | "recall" | "finish" | RotationStepId;
interface StepEvent {
  step: StepId;
  status: "running" | "done" | "error";
}

const app = document.querySelector<HTMLDivElement>("#app")!;
let accounts: Account[] = [];
let chosenAccount: Account | null = null;
let details: ConnectionDetails | null = null;

/**
 * The wizard's personal/team fork. Personal is today's flow verbatim; team
 * provisions identically and only decides what is recorded with the setup and
 * what the closing screens say. The "Already have a Second Brain?" path never
 * sets it — a connected brain's mode is unknown.
 */
let teamMode = false;

/**
 * Who is holding the token this window connected with (#4.7).
 *
 * "owner" until a team brain says otherwise, which is what the provisioning
 * path always is — the person who just created the brain owns it. Only
 * `existingTeamScreen` moves it, and only on a brain that reports members, so a
 * solo install never leaves this value and never pays for a second request.
 *
 * Derived per connect and deliberately not written to the keychain beside
 * `team-mode`: a member promoted to admin in the dashboard next month must not
 * be looking at a card this app wrote on the day they installed it.
 */
let connectionRole: ConnectionRole = "owner";

/** Which setup screen is visible — used to re-render on locale change. */
let currentScreen: (() => void) | null = null;

/** welcomeScreen's row 1 → row 1b sequencing (plan §4.4), cleared on every
 *  re-entry so a locale change mid-sequence cannot double the timers. */
let welcomeIntroTimer: number | undefined;
let welcomeGuardTimer: number | undefined;

// ── The step rail ───────────────────────────────────────────────────────────
//
// The shell's left column: what setup is going to ask for, where the user is,
// and the way back into the few steps that are genuinely re-enterable. The
// step model itself lives in `steps.ts` as pure data; everything below is the
// rendering and the wiring to the *existing* screen functions — the rail never
// invents a second way to navigate, so focus handling, Ridge's anchoring and
// every state reset stay exactly whatever the Back buttons already do.

/** Which screen is on, and which of the three walks it is part of. Set by each
 *  screen function beside `currentScreen`, for the same reason: a locale change
 *  re-renders through the same function and must draw the same rail. */
let railScreen: ScreenName = "welcome";
let railPath: PathId = "new";
/** An await is in flight on the current screen. Cleared by `setRail`, so it
 *  cannot outlive the screen that set it. */
let railBusy = false;
/**
 * The last discovery result. `unlockBrainScreen`'s own Back button returns to
 * the picker through a closure; the rail is outside every closure, so the list
 * it would re-open has to be reachable from here. Held rather than re-scanned:
 * re-running discovery would cost a second Cloudflare round trip to land on a
 * screen the user was already looking at.
 */
let lastFound: DiscoveredBrain[] = [];

function setRail(screen: ScreenName, path: PathId = railPath) {
  railScreen = screen;
  railPath = path;
  railBusy = false;
}

/// Each allowed jump is the screen function the matching Back button calls,
/// and nothing else. `steps.ts` decides whether a jump is offered at all; this
/// only says where it lands, and a step with no safe landing is not in
/// `steps.ts`'s jumpable set in the first place.
function jumpToStep(step: RailStepId) {
  if (step === "start") return welcomeScreen();
  if (step === "protect") return passwordScreen();
  if (step === "signIn") return connectExistingScreen();
  if (step === "find") return brainPickerScreen(lastFound);
}

function stepRail(): HTMLElement | null {
  const model = railFor(railScreen, railPath);
  if (!model) return null;
  const jumps = new Set(
    allowedBackSteps(railScreen, railPath, {
      busy: railBusy,
      signedIn: signedInToCloudflare(),
      hasFound: lastFound.length > 0,
    }),
  );

  const list = h("ol", { class: "steprail-list", role: "list" });
  for (const step of model.steps) {
    const label = t(STEP_LABEL_KEYS[step.id]);
    // The running step draws the shared CSS spinner, a finished one the shared
    // check; everything else is its position, which is the whole point of a
    // rail — it says how much is left.
    const mark = h("span", { class: "steprail-mark" }, [
      step.state === "done"
        ? icon("check", "icon icon--sm")
        : step.state === "current" && model.running
          ? h("span", { class: "spinner" })
          : String(step.index),
    ]);
    const text = h("span", { class: "steprail-label" }, [label]);

    let inner: HTMLElement;
    if (jumps.has(step.id)) {
      const btn = h("button", { class: "steprail-jump", type: "button" }, [mark, text]);
      // "Back to Password", not "Password": out of context a screen reader
      // reads the list item alone, and the label on its own says nothing about
      // what activating it does.
      btn.setAttribute("aria-label", t("steps.backTo", { step: label }));
      btn.addEventListener("click", () => jumpToStep(step.id));
      inner = btn;
    } else {
      inner = h("span", { class: "steprail-static" }, [mark, text]);
      // Tooltip-grade only: the reduced affordance (no button, no pointer, no
      // hover) is what actually communicates this, and the heading and buttons
      // on the screen already say where the user is.
      //
      // Not while a request is out: every step is unclickable then, and this
      // string says the step is permanently behind the user, which for a step
      // that will be a door again the moment the connect returns is a claim
      // the app cannot make.
      if (step.state === "done" && !railBusy) inner.setAttribute("title", t("steps.locked"));
    }

    const li = h("li", { class: `steprail-item is-${step.state}` }, [inner]);
    if (step.state === "current") li.setAttribute("aria-current", "step");
    list.append(li);
  }

  // The narrow-window form. Both are in the DOM and CSS shows exactly one;
  // `display: none` takes the other out of the accessibility tree too, so no
  // reader ever hears the position twice.
  const compact = h("p", { class: "steprail-compact" }, [
    h("span", { class: "steprail-compact-count" }, [
      t("steps.compact", { n: String(model.index), total: String(model.total) }),
    ]),
    h("span", { class: "steprail-compact-label" }, [t(STEP_LABEL_KEYS[model.current])]),
  ]);

  const nav = h("nav", { class: "steprail", "aria-label": t("steps.navLabel") }, [compact, list]);
  if (model.paused) nav.classList.add("is-paused");
  return nav;
}

/// Redraws the rail without redrawing the screen — for the two changes that
/// happen inside a screen rather than between screens: an await going out
/// (which suspends every jump) and provisioning failing (which has to stop the
/// spinner on the Build step).
function refreshStepRail() {
  const screen = app.querySelector<HTMLElement>(".screen");
  if (!screen) return;
  const existing = screen.querySelector(".steprail");
  const next = stepRail();
  document.body.classList.toggle("has-steprail", next !== null);
  if (existing && next) existing.replaceWith(next);
  else if (existing) existing.remove();
  else if (next) screen.prepend(next);
}

// ── The value panel ─────────────────────────────────────────────────────────
//
// The shell's right gutter, opposite the rail: one testimonial and the three
// facts a first-run user is weighing, on the screens where the gutter would
// otherwise be blank. Which quote a screen gets is pure data in
// `valuePanel.ts`; everything below is the render, and it is deliberately
// inert — no buttons, no links, nothing focusable, nothing that moves. It
// yields to Ridge in CSS rather than here, so a line arriving mid-screen
// never has to reach into this.

function valuePanel(): HTMLElement | null {
  const quote = quoteFor(railScreen);
  if (!quote) return null;

  const stats = h("p", { class: "value-stats" });
  for (const key of STAT_KEYS) {
    stats.append(h("span", { class: "value-stat" }, [t(key)]));
  }

  // `aria-hidden`, and not a region with a label: this is the same
  // marketing copy on every one of these screens, and a reader that met it
  // once has met it on all of them. It is ambient by construction — the
  // reason it can sit next to a password field at all is that it never asks
  // for the user's attention, and announcing it would be exactly that ask.
  const panel = h("aside", { class: "value-panel", "aria-hidden": "true" }, [
    h("p", { class: "value-heading" }, [icon("sparkles", "icon icon--sm"), t("value.heading")]),
    h("figure", { class: "value-card" }, [
      h("blockquote", { class: "value-quote" }, [quote.text]),
      h("figcaption", { class: "value-attrib" }, [
        h("span", { class: "value-author" }, [quote.author]),
        h("span", { class: "value-source" }, [t(SOURCE_LABEL_KEYS[quote.source])]),
      ]),
    ]),
    stats,
  ]);
  return panel;
}

function show(...nodes: (Node | string)[]) {
  // A screen change never has a line of its own queued yet — the incoming
  // screen's own `ridgeSay` call (if any) runs synchronously right after this
  // returns — so any bubble left over from the previous screen is cleared
  // immediately rather than lingering on an anchor that's about to be gone
  // (the two provisioning guards render no line of their own at all).
  ridgeOnScreenChange();
  const rail = stepRail();
  // The shell, not the screen: the rail is a class on `body` because the dark
  // canvas it stands on is drawn by `body::before`, and its width has to
  // change with it.
  document.body.classList.toggle("has-steprail", rail !== null);
  // The panel lives in the gutter the rail's layout opens on the right, so it
  // is drawn only where that gutter exists. Without the rail the column is
  // right-aligned against the window edge and there is no gutter to sit in —
  // a panel there would be over the screen rather than beside it. Both of the
  // ways that happens (a launch mode, or a screen and path that cannot
  // co-occur) already have no quote or no rail, so this costs nothing and
  // makes the geometry an invariant rather than a coincidence.
  const value = rail ? valuePanel() : null;
  const screen = h("div", { class: "screen", tabindex: "-1" }, [
    ...(rail ? [rail] : []),
    ...nodes,
    ...(value ? [value] : []),
  ]);
  app.replaceChildren(screen);
  // The rail comes before the heading in reading order, which is right for a
  // nav and wrong as a starting point: nobody wants to hear six step labels
  // before the question they were asked. Focus lands on the heading instead,
  // so the rail is behind the reader rather than in front of them, and is
  // still one shift-tab away. Screens with no heading keep the old behaviour.
  const heading = screen.querySelector("h1");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  } else {
    screen.focus({ preventScroll: true });
  }
}

function brand(): HTMLElement {
  return h("div", { class: "brand" }, [h("img", { src: "/brain.png", alt: "" })]);
}

function welcomeScreen() {
  currentScreen = welcomeScreen;
  // Re-entering the front door restarts the walk: the path the rail draws is
  // whichever door is taken next, not the one taken last time.
  setRail("welcome", "new");
  window.clearTimeout(welcomeIntroTimer);
  window.clearTimeout(welcomeGuardTimer);
  const start = h("button", { class: "btn-primary" }, [t("welcome.getStarted")]);
  start.addEventListener("click", audienceScreen);
  const existing = h("button", { class: "btn-ghost btn-stack" }, [
    t("welcome.alreadyHave"),
  ]);
  existing.addEventListener("click", () => connectExistingScreen());
  show(
    brand(),
    h("h1", {}, [t("welcome.title")]),
    h("p", { class: "lede" }, [t("welcome.lede")]),
    start,
    existing,
    h("p", { class: "footnote" }, [t("welcome.footnote")]),
  );

  // Row 1b is the safety line (plan §4.4) — it outranks the greeting and ships
  // every visit. Row 1 only plays the first time this device has ever seen it;
  // on every later visit 1b fires immediately, with no wait for a line that
  // has already been said.
  const showGuard = () =>
    ridgeSay({
      key: "mascot.welcome.guard",
      text: t("mascot.welcome.guard"),
      state: "talking",
      anchor: () => start,
      persist: "always",
    });
  if (hasSeenLine("mascot.welcome.intro")) {
    showGuard();
  } else {
    welcomeIntroTimer = window.setTimeout(() => {
      ridgeSay({
        key: "mascot.welcome.intro",
        text: t("mascot.welcome.intro"),
        state: "talking",
        anchor: () => start,
        persist: "once",
        dismissMs: 5200,
        hero: true,
      });
      welcomeGuardTimer = window.setTimeout(showGuard, 5400);
    }, 500);
  }
}

/** A Worker in the user's account that answered like a Second Brain. */
interface DiscoveredBrain {
  name: string;
  url: string;
}

/// Who the fresh brain is for. Both answers run the same provisioning; the
/// choice is recorded with the setup and shapes the closing copy. "Just me" is
/// the primary because it is the path almost everyone takes, mirroring how the
/// welcome screen ranks its own two doors.
function audienceScreen() {
  currentScreen = audienceScreen;
  setRail("audience", "new");
  // Two co-equal choice cards, not a primary button over a secondary link:
  // "just me" is not the default the other is a fallback from (user-requested
  // promotion). Row 2's own Ridge line is deliberately skipped here — the
  // `audience.lede` copy rewrite already covers the same gap (plan §4.4 note).
  const justMe = h("button", { class: "choice-card" }, [
    h("div", { class: "choice-card-title" }, [t("audience.justMe")]),
  ]);
  justMe.addEventListener("click", () => {
    teamMode = false;
    passwordScreen();
  });
  const aTeam = h("button", { class: "choice-card" }, [
    h("div", { class: "choice-card-title" }, [t("audience.aTeam")]),
  ]);
  aTeam.addEventListener("click", () => {
    teamMode = true;
    passwordScreen();
  });
  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", welcomeScreen);
  show(
    brand(),
    h("h1", {}, [t("audience.title")]),
    h("p", { class: "lede" }, [t("audience.lede")]),
    h("div", { class: "choice-cards" }, [justMe, aTeam]),
    back,
    h("p", { class: "footnote" }, [t("audience.footnote")]),
  );
}

/**
 * Asks the brain who this token belongs to. Only ever called on a brain that
 * has already reported members, so `team` is true by construction.
 *
 * Every way of not getting an answer — a Worker too old to serve /team/me, a
 * 401/403/404, a body that will not parse, a request that never lands — reduces
 * to `null`, and `roleFromProbe` turns `null` into "member". That is the point:
 * the failure this whole change exists to fix is the app telling a member they
 * are the owner-admin, so an unanswerable probe must claim less, not more.
 */
async function deriveConnectionRole(
  brainUrl: string,
  brainPassword: string,
): Promise<ConnectionRole> {
  // The brain is the only authority here. A Cloudflare sign-in used to count as
  // evidence of ownership and must never again: `signedInToCloudflare()` is
  // `accounts.length > 0`, which any successful `connect_cloudflare` in this
  // window sets and nothing clears — including the one the primary connect
  // button performs for a member whose brain lives in somebody else's account.
  // `fetchRoleProbe` bounds itself, so a brain that never answers reaches the
  // same "member" a refused one does instead of holding this screen open.
  return roleFromProbe({ team: true, ...(await fetchRoleProbe(fetch, brainUrl, brainPassword)) });
}

/**
 * `/health`, with the same bound as the probe above.
 *
 * A rejected fetch already fell through to the audience question; one that never
 * settles did not, and this screen awaits it. Two unbounded requests on the
 * first-connect path was one more than the change that added the second should
 * have shipped.
 */
async function brainReportsMembers(brainUrl: string, brainPassword: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${brainUrl}/health`, {
      headers: { Authorization: `Bearer ${brainPassword}` },
      signal: controller.signal,
    });
    return await res.json().then((d) => !!d.team).catch(() => false);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/// Same question as audienceScreen, asked AFTER an existing brain connects.
/// ONE-TIME by two independent locks, either of which settles it:
///   1. this machine already recorded a choice (keychain via details.teamMode);
///   2. the brain itself already has members (/health team:true — server truth;
///      going back to solo would mean destroying other people's memories, so
///      there is deliberately no downgrade path and no second question).
/// The question only ever runs on a solo brain whose mode was never recorded.
async function existingTeamScreen(brainUrl: string, brainPassword: string, back: () => void) {
  currentScreen = () => existingTeamScreen(brainUrl, brainPassword, back);
  setRail("existingTeam");
  if (details?.teamMode) {
    // A team brain this machine has already recorded. The mode is settled, but
    // the role is not — it is re-derived here rather than skipped, because the
    // token in hand may be a member's and this branch is exactly the one a
    // returning member takes.
    //
    // `teamMode` is set as well as the role, and that is not tidiness: it is
    // the only thing `detailsScreen` consults before rendering the team card
    // (`teamMode ? [teamCard(connectionRole)] : []`) and before choosing
    // between the team lede and the solo one. Without it this branch derived a
    // role nothing read, and a returning member — the person this branch
    // exists for — finished setup on the solo "all set" copy with no card at
    // all. The keychain already says this is a team brain; this is that fact
    // reaching the screen.
    teamMode = true;
    connectionRole = await deriveConnectionRole(brainUrl, brainPassword);
    return void toolsScreen();
  }
  if (await brainReportsMembers(brainUrl, brainPassword)) {
    teamMode = true;
    connectionRole = await deriveConnectionRole(brainUrl, brainPassword);
    await invoke("set_team_mode", { teamMode: true }).catch(() => {});
    return void toolsScreen();
  }
  // Below here the brain reported no members, so `roleFromProbe` would answer
  // "owner" whatever /team/me said. `connectionRole` is already "owner" and no
  // second request is made — a solo install pays nothing for any of this.

  const justMe = h("button", { class: "choice-card" }, [
    h("div", { class: "choice-card-title" }, [t("audience.justMe")]),
  ]);
  justMe.addEventListener("click", async () => {
    teamMode = false;
    await invoke("set_team_mode", { teamMode: false }).catch(() => {});
    void toolsScreen();
  });
  const aTeam = h("button", { class: "choice-card" }, [
    h("div", { class: "choice-card-title" }, [t("audience.aTeam")]),
  ]);
  aTeam.addEventListener("click", async () => {
    teamMode = true;
    await invoke("set_team_mode", { teamMode: true }).catch(() => {});
    void toolsScreen();
  });
  // Only forward buttons before this (#F4): quitting was the only way out.
  const backBtn = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  backBtn.addEventListener("click", back);
  const choiceCards = h("div", { class: "choice-cards" }, [justMe, aTeam]);
  show(
    brand(),
    h("h1", {}, [t("audience.existingTitle")]),
    h("p", { class: "lede" }, [t("audience.existingLede")]),
    choiceCards,
    backBtn,
    h("p", { class: "footnote" }, [t("audience.existingFootnote")]),
  );
  // Row F (plan §4.4): only this fallthrough branch reaches here — both
  // earlier branches in this function return before rendering anything.
  ridgeSay({
    key: "mascot.existingTeam.repeatQuestion",
    text: t("mascot.existingTeam.repeatQuestion"),
    state: "talking",
    anchor: () => choiceCards,
    persist: "once",
  });
}

function notice(message: string, tone: "error" | "info" = "error"): HTMLElement {
  return h("div", { class: `notice ${tone}` }, [
    icon(tone === "error" ? "alert" : "lightbulb"),
    h("span", {}, [message]),
  ]);
}

/**
 * The "write this down before you go any further" notice. Seven screens show
 * one, and they used to spell out the same three-node structure seven times —
 * which is how six of them ended up with a key emoji and the seventh with a
 * padlock.
 */
function keyNotice(message: string): HTMLElement {
  return h("div", { class: "notice" }, [icon("key"), h("span", {}, [message])]);
}

/**
 * The composition the three "we stopped, here is why" screens share — the two
 * provisioning guards and the member-token dead end.
 *
 * They are not errors and they are not questions: nothing was created, nothing
 * was touched, and there is exactly one sensible next move. So they get a panel
 * with a mark, one sentence at full-strength ink, and the way on underneath —
 * rather than the default lede-floating-above-two-buttons that a screen asking
 * a routine question uses. Being visibly a different kind of screen is the
 * point; that is what stops it reading as a failure.
 *
 * The mark is decoration and is hidden from assistive tech: the heading and the
 * message already say everything it gestures at.
 */
function guardPanel(mark: IconName, body: Node | string): HTMLElement {
  return h("div", { class: "guard" }, [
    h("div", { class: "guard-mark" }, [icon(mark, "icon icon--lg")]),
    body,
  ]);
}

/// Two ways in. Signing in to Cloudflare is offered first because it removes
/// the only genuinely hard step — finding the address — but manual entry is not
/// a fallback for failures alone: a custom domain, a brain in someone else's
/// account, or an unwillingness to grant scopes all need it, so it stays a
/// first-class choice.
function connectExistingScreen(errorMsg?: string) {
  currentScreen = () => connectExistingScreen(errorMsg);
  setRail("connectExisting", "existing");

  const signIn = h("button", { class: "btn-primary" }, [t("connectExisting.signInButton")]);
  signIn.addEventListener("click", () => void discoverScreen());

  const manual = h("button", { class: "btn-ghost btn-stack" }, [
    t("connectExisting.manualButton"),
  ]);
  // The manual door is the member/token walk: no Cloudflare sign-in, no scan.
  // Taking it here is the earliest moment the app can know that, which is why
  // the rail derives the path from the door rather than from the role the
  // brain reports two screens later.
  manual.addEventListener("click", () => {
    railPath = "token";
    manualEntryScreen();
  });

  const back = h("button", { class: "btn-ghost btn-stack" }, [t("common.back")]);
  back.addEventListener("click", welcomeScreen);

  show(
    brand(),
    h("h1", {}, [t("connectExisting.title")]),
    h("p", { class: "lede" }, [t("connectExisting.chooseLede")]),
    errorMsg ? notice(errorMsg) : "",
    signIn,
    h("p", { class: "footnote" }, [t("connectExisting.signInHint")]),
    manual,
    back,
    // Signing in to Cloudflare hands over real access, and the consent screen
    // that follows says so in Cloudflare's words. Say it in ours first.
    h("p", { class: "footnote" }, [t("connectExisting.signInFootnote")]),
  );
  // Row A (plan §4.4): no spotlight on purpose — either door is legitimate,
  // and lighting one up would bias the fork.
  ridgeSay({
    key: "mascot.connect.fork",
    text: t("mascot.connect.fork"),
    state: "talking",
    persist: "always",
  });
}

function searchingScreen() {
  show(
    brand(),
    h("h1", {}, [t("connectExisting.searchingTitle")]),
    h("p", { class: "lede" }, [t("connectExisting.searchingLede")]),
    h("div", { class: "searching-status", role: "status", "aria-live": "polite" }, [
      h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
      t("connectExisting.searchingStep"),
    ]),
  );
  // Row B (plan §4.4). Shared by the connect-existing scan and the "I don't
  // have my password" rediscovery — the searching UX is identical either way.
  ridgeSay({
    key: "mascot.discover.searching",
    text: t("mascot.discover.searching"),
    state: "idle",
    persist: "always",
    dismissMs: 8000,
  });
}

async function discoverScreen() {
  currentScreen = searchingScreen;
  setRail("searching", "existing");
  searchingScreen();
  try {
    accounts = await invoke<Account[]>("connect_cloudflare");
    if (accounts.length === 1) {
      chosenAccount = accounts[0];
      await runDiscovery();
    } else {
      // More than one account, so the user picks before we scan — scanning all
      // of them would be slower and would list brains they didn't ask about.
      accountPickerScreen(
        () => void runDiscovery(),
        t("connectExisting.accountPickerTitle"),
        t("connectExisting.accountPickerLede"),
        () => connectExistingScreen(),
      );
    }
  } catch (e) {
    connectExistingScreen(String(e));
  }
}

async function runDiscovery() {
  currentScreen = searchingScreen;
  setRail("searching", "existing");
  searchingScreen();
  try {
    const found = await invoke<DiscoveredBrain[]>("discover_brains", {
      accountId: chosenAccount?.id ?? "",
    });
    // Nothing found is not a failure — the brain may be on a custom domain or
    // in another account — so it lands on manual entry with an explanation
    // rather than a dead end.
    if (found.length === 0) {
      manualEntryScreen(t("connectExisting.noneFound"), undefined, "info");
      return;
    }
    brainPickerScreen(found);
  } catch (e) {
    manualEntryScreen(String(e), undefined, "error", true);
  }
}

function brainPickerScreen(found: DiscoveredBrain[]) {
  currentScreen = () => brainPickerScreen(found);
  setRail("brainPicker", "existing");
  lastFound = found;
  const list = h("ul", { class: "account-list", role: "list" });
  for (const brain of found) {
    // The address leads, not the name: this app deploys every brain under the
    // same script name, so the address is the only part that distinguishes one.
    const btn = h("button", {}, [brain.url.replace(/^https:\/\//, "")]);
    btn.addEventListener("click", () => unlockBrainScreen(brain, undefined, found));
    list.append(h("li", {}, [btn]));
  }
  const manual = h("button", { class: "btn-ghost btn-stack" }, [
    t("connectExisting.manualButton"),
  ]);
  manual.addEventListener("click", () => manualEntryScreen());

  const one = found.length === 1;
  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => connectExistingScreen());

  show(
    brand(),
    h("h1", {}, [t(one ? "connectExisting.pickTitleOne" : "connectExisting.pickTitleMany")]),
    h("p", { class: "lede" }, [
      t(one ? "connectExisting.pickLedeOne" : "connectExisting.pickLedeMany"),
    ]),
    list,
    manual,
    back,
  );
  // Rows C / C′ (plan §4.4).
  ridgeSay({
    key: one ? "mascot.brainPicker.one" : "mascot.brainPicker.many",
    text: t(one ? "mascot.brainPicker.one" : "mascot.brainPicker.many"),
    state: "talking",
    anchor: () => list,
    persist: "once",
  });
}

/**
 * Whether a `connect_existing` rejection is specifically the wrong-credential
 * error — a submitted password/token that Cloudflare rejected — rather than a
 * blank field, a bad address, an unreachable host, or anything else.
 *
 * `connect_existing` now rejects a bad credential with a structured
 * `{ errorKey, message }` shape (`commands.rs`'s `ConnectExistingError`:
 * `ErrorEmptyPassword` for a blank field, `ErrorWrongPassword` for a probe
 * that came back `WorkerProbe::WrongPassword`), same idea as
 * `start_provisioning`'s tagged errors below. Only `message` — the
 * already-localised prose, unwrapped by `connectExistingErrorMessage` below —
 * travels through this file's `errorMsg: string` render-chain parameter, so
 * this still matches against that text rather than the tag; per the locale
 * this window is already synced to (`i18n.ts`'s
 * `getLocale()`/`syncLocaleToRust`).
 *
 * Deliberately excludes `ErrorEmptyPassword`'s text: that fires before
 * anything is even sent to Cloudflare, so the member-recovery ghost action
 * would otherwise appear on a field the user simply hasn't filled in yet.
 */
const WRONG_CREDENTIAL_ERROR_TEXT: Record<"en" | "it", string> = {
  en: "That password or team sign-in token does not work for this Second Brain. Check the invitation or password and try again.",
  it: "Questa password o questo token di accesso del team non funziona per questo Second Brain. Controlla l'invito o la password e riprova.",
};

function isCredentialError(errorMsg: string | undefined): boolean {
  return !!errorMsg && errorMsg === WRONG_CREDENTIAL_ERROR_TEXT[getLocale()];
}

/**
 * The display text for a `connect_existing` rejection, whichever of its two
 * wire shapes it came back as. Precondition/network failures still reject
 * with a plain, already-localised string; a submitted-but-wrong credential
 * now rejects with `{ errorKey, message }` instead (`commands.rs`'s
 * `ConnectExistingError`), so its `message` has to be unwrapped explicitly —
 * `String(e)` on that object stringifies to `"[object Object]"` and would
 * both blank the error notice and starve `isCredentialError` of the text it
 * matches against.
 */
function connectExistingErrorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

/// Reached only from the new ghost action on a wrong-credential failure. States
/// plainly that a rotated/suspended/removed token cannot be repaired on this
/// computer — never routes a token holder into `lostPasswordIntroScreen`, which
/// is an owner-only Cloudflare recovery a member structurally cannot complete.
function memberTokenHelpScreen(back: () => void) {
  currentScreen = () => memberTokenHelpScreen(back);
  setRail("memberTokenHelp");
  // Promoted from ghost to primary: it is the only control on the screen, and
  // the one way back out of a dead end should not be styled as the quiet
  // alternative to something else. Same handler, same label, same back-chain.
  const ok = h("button", { class: "btn-primary" }, [t("common.back")]);
  ok.addEventListener("click", back);
  show(
    brand(),
    h("h1", {}, [t("connectExisting.memberTokenHelpTitle")]),
    guardPanel("key", h("p", { class: "lede" }, [t("connectExisting.memberTokenHelpLede")])),
    ok,
  );
}

/// The address is known by this point, so only the password is asked for.
/// Discovery cannot retrieve it: Cloudflare secrets are write-only, so an
/// existing AUTH_TOKEN can never be read back — only overwritten, which would
/// break every other client the user has connected.
function unlockBrainScreen(
  brain: DiscoveredBrain,
  errorMsg?: string,
  found: DiscoveredBrain[] = [brain],
) {
  currentScreen = () => unlockBrainScreen(brain, errorMsg, found);
  setRail("unlockBrain", "existing");
  lastFound = found;
  const passwordLabel = t("connectExisting.passwordPlaceholder");
  const password = h("input", {
    type: "password",
    placeholder: passwordLabel,
    "aria-label": passwordLabel,
  });
  const connect = h("button", { class: "btn-primary" }, [t("connectExisting.connect")]);
  const back = h("button", { class: "btn-ghost btn-stack" }, [t("common.back")]);
  // Back to the pick-list, not to the chooser: returning to the chooser would
  // discard the scan and cost another Cloudflare sign-in to get here again.
  back.addEventListener("click", () => brainPickerScreen(found));

  // Last element, below Back, and a ghost: it is the rarer path, and above the
  // password field it would invite people to take it before trying the password
  // they have. The brain is chosen and Cloudflare is signed in from discovery,
  // so this goes straight to the password step.
  const lost = h("button", { class: "btn-ghost btn-stack" }, [
    t("connectExisting.lostPassword"),
  ]);
  lost.addEventListener("click", () => {
    beginRotation();
    rotationExit = () => unlockBrainScreen(brain, undefined, found);
    lostPasswordIntroScreen(brain.url);
  });

  // A member whose token was rotated, suspended, or mistyped gets the same
  // wrong-credential message an owner with a bad password gets (#P0-2). Their
  // only correct recovery is structurally different — it does not run through
  // Cloudflare at all — so it is offered as its own action rather than folded
  // into "I don't have my password" above.
  const memberHelp = isCredentialError(errorMsg)
    ? (() => {
        const btn = h("button", { class: "btn-ghost btn-stack" }, [
          t("connectExisting.memberTokenHelp"),
        ]);
        btn.addEventListener("click", () =>
          memberTokenHelpScreen(() => unlockBrainScreen(brain, undefined, found)),
        );
        return btn;
      })()
    : "";

  connect.addEventListener("click", async () => {
    connect.disabled = true;
    connect.textContent = t("common.checking");
    railBusy = true;
    refreshStepRail();
    try {
      details = await invoke<ConnectionDetails>("connect_existing", {
        address: brain.url,
        password: password.value,
      });
      await existingTeamScreen(brain.url, password.value, () =>
        unlockBrainScreen(brain, undefined, found),
      );
    } catch (e) {
      unlockBrainScreen(brain, connectExistingErrorMessage(e), found);
    }
  });

  show(
    brand(),
    h("h1", {}, [t("connectExisting.unlockTitle")]),
    h("p", { class: "lede" }, [t("connectExisting.unlockLede")]),
    errorMsg ? notice(errorMsg) : "",
    h("div", { class: "field-stack" }, [password]),
    connect,
    back,
    lost,
    memberHelp,
  );
  // Row D, or the member-aware wrong-credential error (plan §4.4/§4.5) — never
  // both: a member steered toward their admin should not also be told where
  // the token goes, which they have already found.
  if (isCredentialError(errorMsg)) {
    ridgeSay({
      key: "mascot.error.wrongCredentialMemberAware",
      text: t("mascot.error.wrongCredentialMemberAware"),
      state: "alarmed",
      anchor: () => password,
      persist: "always",
    });
  } else {
    ridgeSay({
      key: "mascot.unlock.hint",
      text: t("mascot.unlock.hint"),
      state: "talking",
      anchor: () => password,
      persist: "once",
    });
  }
  password.focus();
}

/// Unchanged from before discovery existed, deliberately: this path must keep
/// working for anyone whose brain cannot be found automatically.
function manualEntryScreen(
  errorMsg?: string,
  prefillAddress?: string,
  tone: "error" | "info" = "error",
  /** Set only by runDiscovery's catch: the scan itself failed, rather than
   *  simply finding nothing (plan §4.5's discoverFailed vs. plan §4.4's row E). */
  discoveryFailed = false,
) {
  currentScreen = () => manualEntryScreen(errorMsg, prefillAddress, tone, discoveryFailed);
  // Path deliberately inherited, not set: this same screen is the token door
  // (reached from the connect fork or the existing-brain guard) and the
  // fallback for a scan that came up empty, which is still the discover walk.
  setRail("manualEntry");
  const addressLabel = t("connectExisting.addressPlaceholder");
  const address = h("input", {
    type: "text",
    placeholder: addressLabel,
    "aria-label": addressLabel,
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  if (prefillAddress) address.value = prefillAddress;
  // Row E″ (plan §4.4/§4.5): a soft, pre-submit hint only — `connect_existing`
  // already rejects http:// server-side, so this is advisory, not the safety
  // net.
  address.addEventListener("blur", () => {
    if (/^http:\/\//i.test(address.value.trim())) {
      // Insecure, not merely a wrong guess (#hardening's mapping: a security
      // concern gets the alarmed face, not the milder concerned one).
      ridgeSay({
        key: "mascot.manualEntry.insecureHttp",
        text: t("mascot.manualEntry.insecureHttp"),
        state: "alarmed",
        anchor: () => address,
        kind: "reaction",
      });
    }
  });
  const passwordLabel = t("connectExisting.passwordPlaceholder");
  const password = h("input", {
    type: "password",
    placeholder: passwordLabel,
    "aria-label": passwordLabel,
  });
  const connect = h("button", { class: "btn-primary" }, [t("connectExisting.connect")]);
  const back = h("button", { class: "btn-ghost btn-stack" }, [t("common.back")]);
  back.addEventListener("click", () => connectExistingScreen());

  // No Cloudflare session here, so this door routes through sign-in and
  // discovery first. Anything already typed is carried over as the fallback
  // address, for the brain a scan can't see — a custom domain, another account.
  const lost = h("button", { class: "btn-ghost btn-stack" }, [
    t("connectExisting.lostPassword"),
  ]);
  lost.addEventListener("click", () => {
    beginRotation();
    rotationExit = () => manualEntryScreen(errorMsg, address.value, tone);
    rotationTypedAddress = address.value.trim();
    lostPasswordIntroScreen(null);
  });

  // Same wrong-credential branch as `unlockBrainScreen` (#P0-2): a member's
  // rotated/suspended/mistyped token reads identically to a bad password here,
  // and this is the screen the member persona is most likely to actually reach.
  const memberHelp = isCredentialError(errorMsg)
    ? (() => {
        const btn = h("button", { class: "btn-ghost btn-stack" }, [
          t("connectExisting.memberTokenHelp"),
        ]);
        btn.addEventListener("click", () =>
          memberTokenHelpScreen(() => manualEntryScreen(undefined, address.value, tone)),
        );
        return btn;
      })()
    : "";

  connect.addEventListener("click", async () => {
    connect.disabled = true;
    connect.textContent = t("common.checking");
    railBusy = true;
    refreshStepRail();
    try {
      details = await invoke<ConnectionDetails>("connect_existing", {
        address: address.value,
        password: password.value,
      });
      await existingTeamScreen(address.value.trim(), password.value, () =>
        manualEntryScreen(undefined, address.value, tone),
      );
    } catch (e) {
      manualEntryScreen(connectExistingErrorMessage(e), address.value);
    }
  });

  show(
    brand(),
    h("h1", {}, [t("connectExisting.title")]),
    h("p", { class: "lede" }, [t("connectExisting.lede")]),
    errorMsg ? notice(errorMsg, tone) : "",
    h("div", { class: "field-stack" }, [address, password]),
    connect,
    back,
    h("p", { class: "footnote" }, [t("connectExisting.footnote")]),
    lost,
    memberHelp,
  );
  if (isCredentialError(errorMsg)) {
    ridgeSay({
      key: "mascot.error.wrongCredentialMemberAware",
      text: t("mascot.error.wrongCredentialMemberAware"),
      state: "alarmed",
      anchor: () => password,
      persist: "always",
    });
  } else if (discoveryFailed) {
    // Row error.discoverFailed (plan §4.5/#hardening): the scan itself broke,
    // not merely came up empty — concerned, anchored at the box that still
    // works.
    ridgeSay({
      key: "mascot.error.discoverFailed",
      text: t("mascot.error.discoverFailed"),
      state: "alarmed",
      anchor: () => address,
      persist: "always",
    });
  } else {
    ridgeSay({
      key: "mascot.manualEntry.combined",
      text: t("mascot.manualEntry.combined"),
      state: "talking",
      anchor: () => address,
      persist: "once",
    });
  }
  address.focus();
}

interface PasswordCheck {
  breached: boolean;
  count: number;
  score: number;
  online: boolean;
}

function meterFor(pw: string, check: PasswordCheck | null): {
  pct: number;
  label: string;
  color: string;
} {
  if (pw.length === 0) return { pct: 0, label: "", color: "var(--danger)" };
  if (pw.trim().length < 12)
    return { pct: 20, label: t("password.tooShort"), color: "var(--danger)" };
  if (check === null)
    return { pct: 45, label: t("password.checking"), color: "var(--accent-btn)" };
  if (check.breached)
    return { pct: 30, label: t("password.foundInBreaches"), color: "var(--danger)" };
  if (check.score >= 4) return { pct: 100, label: t("password.strong"), color: "var(--ok)" };
  if (check.score === 3) return { pct: 70, label: t("password.good"), color: "var(--ok)" };
  return { pct: 45, label: t("password.easyToGuess"), color: "var(--accent-btn)" };
}

function passwordScreen() {
  currentScreen = passwordScreen;
  setRail("password", "new");
  const pw = h("input", {
    type: "password",
    placeholder: t("password.placeholder"),
    "aria-label": t("password.placeholder"),
  });
  const confirm = h("input", {
    type: "password",
    placeholder: t("password.confirmPlaceholder"),
    "aria-label": t("password.confirmPlaceholder"),
  });
  const fill = h("div", { class: "strength-fill" });
  const label = h("span", { class: "strength-label" });
  const hint = h("p", { class: "hint" }, [""]);
  const generate = h("button", {
    class: "input-action",
    title: t("password.generateTitle"),
    "aria-label": t("password.generateTitle"),
  });
  generate.append(icon("sparkles", "icon icon--sm"));
  const next = h("button", { class: "btn-primary", disabled: "" }, [t("common.continueToCloudflare")]);

  let check: PasswordCheck | null = null;
  let debounce: number | undefined;

  // Ridge's face responds to the password itself, not the keystrokes —
  // throttled (`shouldFireReaction`) to fire once per state change, so typing
  // through ten "weak" keystrokes shows the concerned face once, not ten
  // times. `kind: "reaction"` deliberately bypasses both the typing() focus
  // gate (he must react while the field is still focused) and the seen-set
  // (unlike the once-ever arrival greeting below, which shares the same key).
  type PasswordReactionBucket = "weak" | "breached";
  let lastPasswordReaction: PasswordReactionBucket | null = null;

  const render = () => {
    const s = meterFor(pw.value, check);
    fill.style.width = `${s.pct}%`;
    fill.style.background = s.color;
    label.textContent = s.label;
    const longEnough = pw.value.trim().length >= 12;
    const match = pw.value === confirm.value;
    const breached = check?.breached ?? false;
    if (breached) {
      hint.textContent = t("password.breachHint");
      hint.className = "hint error";
    } else if (pw.value && confirm.value && !match) {
      hint.textContent = t("password.mismatch");
      hint.className = "hint error";
    } else {
      hint.textContent = "";
      hint.className = "hint";
    }
    if (longEnough && match && check !== null && !breached) {
      next.removeAttribute("disabled");
    } else {
      next.setAttribute("disabled", "");
    }

    const reaction: PasswordReactionBucket | null = breached
      ? "breached"
      : pw.value.length > 0 && !longEnough
        ? "weak"
        : null;
    if (shouldFireReaction(lastPasswordReaction, reaction)) {
      lastPasswordReaction = reaction;
      if (reaction === "breached") {
        ridgeSay({
          key: "mascot.password.breached",
          text: t("mascot.password.breached"),
          state: "alarmed",
          anchor: () => pw,
          kind: "reaction",
        });
      } else {
        ridgeSay({
          key: "mascot.password.intro",
          text: t("mascot.password.intro"),
          state: "talking",
          anchor: () => pw,
          kind: "reaction",
        });
      }
    } else if (!reaction) {
      lastPasswordReaction = null;
    }
  };

  const runCheck = () => {
    const value = pw.value.trim();
    if (value.length < 12) return;
    invoke<PasswordCheck>("check_password", { password: pw.value })
      .then((result) => {
        if (pw.value.trim() !== value) return;
        check = result;
        render();
      })
      .catch(() => {
        check = { breached: false, count: 0, score: 3, online: false };
        render();
      });
  };

  pw.addEventListener("input", () => {
    check = null;
    render();
    window.clearTimeout(debounce);
    debounce = window.setTimeout(runCheck, 450);
  });
  confirm.addEventListener("input", render);

  generate.addEventListener("click", async () => {
    const generated = await invoke<string>("generate_password");
    pw.value = generated;
    confirm.value = generated;
    pw.setAttribute("type", "text");
    confirm.setAttribute("type", "text");
    check = null;
    render();
    runCheck();
  });

  next.addEventListener("click", async () => {
    railBusy = true;
    refreshStepRail();
    try {
      await invoke("submit_password", { password: pw.value });
      connectScreen();
    } catch (e) {
      railBusy = false;
      refreshStepRail();
      hint.textContent = String(e);
      hint.className = "hint error";
    }
  });

  // Nothing is written remotely yet at this point (#F3): `submit_password`
  // only holds the choice in memory (`commands.rs:156-172`), so leaving is free.
  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => audienceScreen());

  show(
    brand(),
    h("h1", {}, [t("password.title")]),
    h("p", { class: "lede" }, [t("password.lede")]),
    h("div", { class: "field-stack" }, [
      h("div", { class: "input-wrap" }, [pw, generate]),
      h("div", { class: "strength" }, [h("div", { class: "strength-track" }, [fill]), label]),
      confirm,
      hint,
    ]),
    keyNotice(t("password.notice")),
    next,
    back,
    h("p", { class: "footnote" }, [t("password.footnote")]),
  );
  // Row 3 (plan §4.4): the arrival greeting, once ever. The same key is
  // reused above as the live "too short" reaction (#hardening) — that call
  // never sets `persist`, so it is never suppressed by this one having
  // already marked the key seen.
  ridgeSay({
    key: "mascot.password.intro",
    text: t("mascot.password.intro"),
    state: "talking",
    anchor: () => pw,
    persist: "once",
  });
  pw.focus();
}

function connectScreen(errorMsg?: string) {
  currentScreen = () => connectScreen(errorMsg);
  setRail("cloudflare", "new");
  const signIn = h("button", { class: "btn-primary" }, [t("cloudflare.signIn")]);
  const error = errorMsg ? notice(errorMsg) : "";
  // The password chosen a screen back is still only in memory (#F3), same as
  // `passwordScreen`'s own Back — nothing here has been sent to Cloudflare yet.
  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => passwordScreen());

  signIn.addEventListener("click", async () => {
    // Watching a browser tab: the step has not moved, and nothing on the rail
    // is clickable while it is out.
    setRail("cloudflareWaiting", "new");
    show(
      brand(),
      h("h1", {}, [t("cloudflare.waitingTitle")]),
      h("p", { class: "lede" }, [t("cloudflare.waitingLede")]),
      h("div", { class: "checklist", role: "status", "aria-live": "polite" }, [
        h("li", { class: "running" }, [
          h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
          t("cloudflare.watchingSignIn"),
        ]),
      ]),
    );
    // Row 4b (plan §4.4).
    ridgeSay({
      key: "mascot.cloudflare.waiting",
      text: t("mascot.cloudflare.waiting"),
      state: "idle",
      persist: "always",
      dismissMs: 6000,
    });
    try {
      accounts = await invoke<Account[]>("connect_cloudflare");
      if (accounts.length === 1) {
        chosenAccount = accounts[0];
        progressScreen();
      } else {
        // Without a back closure here the screen was a dead end for anyone who
        // signed in with the wrong Cloudflare login (#F1) — the other two
        // `accountPickerScreen` call sites already wire one.
        accountPickerScreen(progressScreen, undefined, undefined, () => connectScreen());
      }
    } catch (e) {
      connectScreen(String(e));
    }
  });

  show(
    brand(),
    h("h1", {}, [t("cloudflare.title")]),
    h("p", { class: "lede" }, [t("cloudflare.lede")]),
    error,
    signIn,
    back,
    h("p", { class: "footnote" }, [t("cloudflare.footnote")]),
  );
  // Row 4, or the CF sign-in error (plan §4.4/§4.5) when this render is a
  // retry after a failed sign-in.
  if (errorMsg) {
    ridgeSay({
      key: "mascot.error.cfSignIn",
      text: t("mascot.error.cfSignIn"),
      state: "alarmed",
      anchor: () => signIn,
      persist: "always",
    });
  } else {
    ridgeSay({
      key: "mascot.cloudflare.why",
      text: t("mascot.cloudflare.why"),
      state: "talking",
      anchor: () => signIn,
      persist: "once",
    });
  }
}

/// `next` is what runs once an account is chosen. Provisioning goes straight to
/// the progress screen; brain discovery scans the chosen account instead.
function accountPickerScreen(
  next: () => void = progressScreen,
  title = t("cloudflare.pickerTitle"),
  lede = t("cloudflare.pickerLede"),
  back?: () => void,
) {
  currentScreen = () => accountPickerScreen(next, title, lede, back);
  // Three callers, three meanings. "Which account do I build in?" is the
  // Connect step; "which account do I scan?" is Find. The third is the
  // lost-password rediscovery, which has no rail at all — so the rail is only
  // moved when there is one, rather than by testing for the rotation flow a
  // second way here.
  if (railFor(railScreen, railPath)) {
    setRail(next === progressScreen ? "accountPickerProvision" : "accountPickerDiscover");
  }
  const list = h("ul", { class: "account-list", role: "list" });
  for (const account of accounts) {
    const btn = h("button", {}, [account.name]);
    btn.addEventListener("click", () => {
      chosenAccount = account;
      next();
    });
    list.append(h("li", {}, [btn]));
  }
  // Without this the screen is a dead end: a user who signed in with the wrong
  // Cloudflare login, or who recognises none of the names, could only quit.
  const backBtn = back
    ? h("button", { class: "btn-ghost btn-stack" }, [t("common.back")])
    : "";
  if (back && backBtn instanceof HTMLElement) backBtn.addEventListener("click", back);

  show(
    brand(),
    h("h1", {}, [title]),
    h("p", { class: "lede" }, [lede]),
    list,
    backBtn,
  );
  // Row 4c (plan §4.4): only the provisioning path's picker (`next` defaults
  // to, or is explicitly, `progressScreen`) — the discovery/lost-password
  // pickers ask the same visual question for a reason Ridge must not warn
  // about ("this starts building for real"), since nothing is being built.
  if (next === progressScreen && accounts.length > 1) {
    ridgeSay({
      key: "mascot.cloudflare.pickerWhy",
      text: t("mascot.cloudflare.pickerWhy"),
      state: "talking",
      anchor: () => list,
      persist: "always",
    });
  }
}

function progressSteps(): { id: StepId; label: string }[] {
  return [
    { id: "space", label: t("progress.stepSpace") },
    { id: "memory", label: t("progress.stepMemory") },
    { id: "recall", label: t("progress.stepRecall") },
    { id: "finish", label: t("progress.stepFinish") },
  ];
}

/**
 * What goes inside a checklist row's `.check-icon` for a given step state.
 *
 * One function for all three checklists, so a state cannot end up drawn one way
 * on the setup screen and another on the password-change screen — which is
 * exactly what happened while each of them spelled its own glyph chain out.
 *
 * "running" is the CSS spinner rather than an icon: it is the only one of the
 * four that has to move.
 */
function stepMark(status: StepEvent["status"] | "pending"): Node {
  if (status === "running") return h("span", { class: "spinner" });
  if (status === "done") return icon("check", "icon icon--sm");
  if (status === "error") return icon("x", "icon icon--sm");
  return icon("dot", "icon icon--sm");
}

/** Supplements the icon swap for a screen reader; the mark alone (a
 *  dot/spinner/check/cross) conveys nothing to VoiceOver (#P0-7). */
function statusWord(status: StepEvent["status"]): string {
  if (status === "running") return t("progress.stepInProgress");
  if (status === "done") return t("progress.stepDone");
  return t("progress.stepFailed");
}

/**
 * A text node that is announced by an `aria-live` ancestor but takes no space
 * on screen (#P0-7 follow-up). The checklists' only other DOM change on a step
 * update is `.check-icon`'s glyph swap or an `aria-label` attribute — neither
 * is a live-region trigger in VoiceOver/NVDA, so the running/done/failed
 * sentence needs its own text node.
 */
function srOnly(text = ""): HTMLElement {
  return h("span", { class: "sr-only" }, [text]);
}

/** The tagged half of `start_provisioning`'s error contract (RUST-1): a plain
 *  string is the legacy shape and falls through to the generic retry screen
 *  below unchanged. */
interface GuardExistingBrainError {
  kind: "existingBrainFound";
  errorKey: "GuardExistingBrain";
  message: string;
  url: string;
}
interface GuardNameConflictError {
  kind: "resourceNameConflict";
  errorKey: "GuardNameConflict";
  message: string;
  resourceKind: "memoryStorage" | "smartSearch" | "webApp";
}
interface ProvisioningFailedError {
  kind: "provisioningFailed";
  errorKey: "ErrorProvisioningDetail";
  message: string;
}
type StructuredProvisioningError =
  | GuardExistingBrainError
  | GuardNameConflictError
  | ProvisioningFailedError;

function structuredProvisioningError(e: unknown): StructuredProvisioningError | null {
  if (typeof e !== "object" || e === null) return null;
  const kind = (e as { kind?: unknown }).kind;
  if (kind === "existingBrainFound" || kind === "resourceNameConflict" || kind === "provisioningFailed") {
    return e as StructuredProvisioningError;
  }
  return null;
}

/// P0-1's render half: a proven Second Brain was found on the chosen account,
/// so provisioning never ran and nothing was touched. Routes to the same
/// manual-entry screen the "Already have one?" door uses, prefilled with the
/// address the preflight already resolved — there is no discovery scan to
/// reuse here, since this account was never scanned.
function existingBrainGuardScreen(err: GuardExistingBrainError) {
  currentScreen = () => existingBrainGuardScreen(err);
  setRail("existingBrainGuard", "new");
  const connectToIt = h("button", { class: "btn-primary" }, [t("guard.existingBrainConnect")]);
  connectToIt.addEventListener("click", () => {
    railPath = "token";
    manualEntryScreen(undefined, err.url);
  });
  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => welcomeScreen());
  show(
    brand(),
    h("h1", {}, [t("guard.existingBrainTitle")]),
    // A brain, because one was found — this screen is good news wearing the
    // shape of an interruption, and the mark is the first thing that says so.
    guardPanel("brain", h("p", { class: "lede" }, [err.message])),
    connectToIt,
    back,
  );
}

/// P0-1's other guard outcome: a fixed name is already taken on this account
/// but nothing proved it is a Second Brain, so nothing was created or
/// overwritten. `err.message` already names the resource category in plain
/// language (`resource_kind_label` in `commands.rs`) — this screen does not
/// re-derive it from `resourceKind`, which exists on the payload for callers
/// that need to branch on it rather than just display it.
function resourceConflictGuardScreen(err: GuardNameConflictError) {
  currentScreen = () => resourceConflictGuardScreen(err);
  setRail("resourceConflictGuard", "new");
  // Routing "choose another account" through `connectScreen` would re-run
  // `connect_cloudflare`, whose sign-in handler short-circuits straight back to
  // this same account when the login only has one (`main.ts:782-784`) —
  // reproducing this exact conflict and looping forever for the common
  // single-account login. With more than one account, the list already fetched
  // this session is reused instead, so picking a different one never re-runs
  // the OAuth grant.
  const canChooseAnother = accounts.length > 1;
  const chooseAnother = canChooseAnother
    ? h("button", { class: "btn-primary" }, [t("guard.conflictChooseAnother")])
    : "";
  if (chooseAnother instanceof HTMLElement) {
    chooseAnother.addEventListener("click", () =>
      accountPickerScreen(progressScreen, undefined, undefined, () =>
        resourceConflictGuardScreen(err),
      ),
    );
  }
  const back = canChooseAnother
    ? h("button", { class: "btn-ghost btn-stack" }, [t("common.back")])
    : h("button", { class: "btn-primary" }, [t("common.back")]);
  back.addEventListener("click", () => welcomeScreen());
  show(
    brand(),
    h("h1", {}, [t("guard.conflictTitle")]),
    // Roadworks, not a warning triangle: a taken name is an obstruction to go
    // around, and nothing on this account was created or overwritten.
    guardPanel("construction", h("p", { class: "lede" }, [err.message])),
    chooseAnother,
    back,
  );
}

function progressScreen() {
  currentScreen = progressScreen;
  setRail("progress", "new");
  const rows = new Map<StepId, HTMLLIElement>();
  const labels = new Map<StepId, string>();
  const statusEls = new Map<StepId, HTMLElement>();
  const list = h("ul", {
    class: "checklist",
    role: "list",
    "aria-live": "polite",
    "aria-atomic": "false",
  });
  for (const step of progressSteps()) {
    const status = srOnly();
    const li = h("li", {}, [
      h("span", { class: "check-icon" }, [stepMark("pending")]),
      step.label,
      status,
    ]);
    rows.set(step.id, li);
    labels.set(step.id, step.label);
    statusEls.set(step.id, status);
    list.append(li);
  }
  const errorBox = h("div", { role: "alert" });
  show(
    brand(),
    h("h1", {}, [t("progress.title")]),
    h("p", { class: "lede" }, [t("progress.lede")]),
    h("div", { class: "card" }, [list]),
    errorBox,
  );
  // Row 5 (plan §4.4). No spotlight while things are progressing normally —
  // the "Try again" target only exists once a failure has actually happened.
  ridgeSay({
    key: "mascot.progress.intro",
    text: t("mascot.progress.intro"),
    state: "idle",
    persist: "always",
    dismissMs: 6000,
  });

  const applyEvent = (ev: StepEvent) => {
    const li = rows.get(ev.step);
    if (!li) return;
    li.className = ev.status;
    const sentence = `${labels.get(ev.step)}: ${statusWord(ev.status)}`;
    li.setAttribute("aria-label", sentence);
    // The live region only ever mutates `.check-icon`'s mark and this text
    // node — an attribute change alone (the `aria-label` above) does not
    // trigger VoiceOver/NVDA (#P0-7).
    statusEls.get(ev.step)!.textContent = sentence;
    const mark = li.querySelector<HTMLSpanElement>(".check-icon")!;
    mark.replaceChildren(stepMark(ev.status));
  };

  let unlisten: (() => void) | null = null;
  const start = async () => {
    setRail("progress", "new");
    refreshStepRail();
    for (const [id, li] of rows) {
      li.className = "";
      li.removeAttribute("aria-label");
      li.querySelector(".check-icon")!.replaceChildren(stepMark("pending"));
      statusEls.get(id)!.textContent = "";
    }
    errorBox.replaceChildren();
    if (!unlisten) unlisten = await listen<StepEvent>("setup-progress", (e) => applyEvent(e.payload));
    try {
      details = await invoke<ConnectionDetails>("start_provisioning", {
        accountId: chosenAccount!.id,
        teamMode,
      });
      unlisten?.();
      toolsScreen();
    } catch (e) {
      const structured = structuredProvisioningError(e);
      if (structured?.kind === "existingBrainFound") {
        unlisten?.();
        existingBrainGuardScreen(structured);
        return;
      }
      if (structured?.kind === "resourceNameConflict") {
        unlisten?.();
        resourceConflictGuardScreen(structured);
        return;
      }
      // The rail is redrawn rather than left alone: the Build step is showing a
      // spinner, and a spinner that keeps turning next to the words "setup
      // failed" is the app disagreeing with itself.
      setRail("progressFailed", "new");
      refreshStepRail();
      const message = structured ? structured.message : String(e);
      const retry = h("button", { class: "btn-primary" }, [t("common.trySetupAgain")]);
      retry.addEventListener("click", () => void start());
      errorBox.replaceChildren(
        notice(message),
        retry,
      );
      // `errorBox` is mutated in place rather than re-rendered through `show()`
      // (#P0-3/#P0-7): without this, the button the user just activated on the
      // previous attempt is destroyed by the `replaceChildren()` above and
      // focus falls back to `<body>`.
      retry.focus();
      // plan §4.5's provisioningHonest, replacing row 5's optimistic line —
      // stops short of endorsing unlimited retries. Softened from the
      // original spec text: wave 1 dropped the "nothing is lost" claim and
      // the fix wave added in-session retry recovery, so this no longer
      // frames the app as contradicting its own "failed" message.
      ridgeSay({
        key: "mascot.error.provisioningHonest",
        text: t("mascot.error.provisioningHonest"),
        state: "alarmed",
        anchor: () => retry,
        persist: "always",
      });
    }
  };
  void start();
}

async function toolsScreen() {
  currentScreen = () => void toolsScreen();
  setRail("tools");
  const tools = await invoke<ToolStatus>("detect_tools");
  const next = h("button", { class: "btn-primary" }, [t("common.continueToConnectionDetails")]);
  next.addEventListener("click", detailsScreen);
  const rows = toolRows(details!, tools);
  show(
    brand(),
    h("h1", {}, [t("tools.title")]),
    h("p", { class: "lede" }, [t("tools.lede")]),
    rows,
    next,
  );
  // Row 6 (plan §4.4). Spotlights the whole card rather than surgically the
  // first ready row — `toolRows` (shared.ts) doesn't expose individual rows,
  // and this wave's file ownership doesn't extend to changing it.
  ridgeSay({
    key: "mascot.tools.intro",
    text: t("mascot.tools.intro"),
    state: "talking",
    anchor: () => rows,
    persist: "once",
  });
}

function detailsScreen() {
  currentScreen = detailsScreen;
  setRail("details");
  const done = h("button", { class: "btn-primary" }, [t("details.openDashboard")]);
  done.addEventListener("click", () => void invoke("open_dashboard"));
  const cards = h("div", {}, detailCards(details!));
  const team = teamMode ? teamCard(connectionRole) : null;
  show(
    brand(),
    h("h1", {}, [t("details.allSetTitle")]),
    h("p", { class: "lede" }, [t(teamMode ? "details.allSetTeamLede" : "details.allSetLede")]),
    // Before the URL cards: it is the one thing a team owner is expected to do
    // next, and the links below it are for keeping, not acting on.
    ...(team ? [team] : []),
    cards,
    h("div", { class: "actions-spread" }, [copyBothButton(details!), emailButton(details!)]),
    h("div", { class: "spacer" }),
    done,
  );
  // Rows 7 / 7b / 7c (plan §4.4). 7c (member) is talking, deliberately NOT
  // celebrating — the clearest opposite-behaviour case: an owner built
  // something, a member joined something.
  if (!teamMode) {
    ridgeSay({
      key: "mascot.details.allSetSolo",
      text: t("mascot.details.allSetSolo"),
      state: "celebrating",
      anchor: () => cards,
      persist: "once",
      hero: true,
    });
  } else if (connectionRole === "member") {
    // Calm spoken delivery, not a celebration and not the empathy frown —
    // the user read that frown as angry, and joining a team is good news:
    // an owner built something, a member joined something. "talking" keeps
    // it warm and chatty; the line's wording (not the face) carries the
    // no-party restraint.
    ridgeSay({
      key: "mascot.details.allSetMember",
      text: t("mascot.details.allSetMember"),
      state: "talking",
      anchor: () => team,
      persist: "once",
    });
  } else {
    ridgeSay({
      key: "mascot.details.allSetTeam",
      text: t("mascot.details.allSetTeam"),
      state: "celebrating",
      anchor: () => team,
      persist: "once",
      hero: true,
    });
  }
}

interface WorkerUpdateInfo {
  deployedVersion: string | null;
  availableVersion: string;
}

function updateProgressSteps(): { id: StepId; label: string }[] {
  return [
    { id: "memory", label: t("workerUpdate.stepMemory") },
    { id: "recall", label: t("workerUpdate.stepRecall") },
    { id: "finish", label: t("workerUpdate.stepFinish") },
  ];
}

async function workerUpdateScreen() {
  currentScreen = () => void workerUpdateScreen();
  setRail("workerUpdate");
  const info = await invoke<WorkerUpdateInfo | null>("worker_update_available").catch(() => null);
  const versionLine = info
    ? t("workerUpdate.ledeWithVersion", { version: info.availableVersion })
    : t("workerUpdate.ledeGeneric");
  const start = h("button", { class: "btn-primary" }, [t("workerUpdate.signInUpdate")]);
  start.addEventListener("click", () => void runWorkerUpdate());
  const notNow = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.skipUpdateForNow"),
  ]);
  notNow.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, [t("workerUpdate.title")]),
    h("p", { class: "lede" }, [versionLine]),
    h("div", { class: "notice" }, [icon("shieldCheck"), h("span", {}, [t("workerUpdate.notice")])]),
    start,
    notNow,
  );
}

async function runWorkerUpdate(errorMsg?: string) {
  currentScreen = () => void runWorkerUpdate(errorMsg);
  setRail("workerUpdate");
  if (errorMsg) {
    const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
    retry.addEventListener("click", () => void runWorkerUpdate());
    const back = h("button", { class: "btn-ghost btn-stack" }, [
      t("common.skipUpdateForNow"),
    ]);
    back.addEventListener("click", () => void invoke("open_dashboard"));
    show(
      brand(),
      h("h1", {}, [t("workerUpdate.title")]),
      notice(errorMsg),
      retry,
      back,
    );
    return;
  }

  show(
    brand(),
    h("h1", {}, [t("cloudflare.waitingTitle")]),
    h("p", { class: "lede" }, [t("workerUpdate.waitingLede")]),
    h("div", { class: "checklist", role: "status", "aria-live": "polite" }, [
      h("li", { class: "running" }, [
        h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
        t("cloudflare.watchingSignIn"),
      ]),
    ]),
  );
  try {
    await invoke<Account[]>("connect_cloudflare");
  } catch (e) {
    return void runWorkerUpdate(String(e));
  }

  const rows = new Map<StepId, HTMLLIElement>();
  const labels = new Map<StepId, string>();
  const statusEls = new Map<StepId, HTMLElement>();
  const list = h("ul", {
    class: "checklist",
    role: "list",
    "aria-live": "polite",
    "aria-atomic": "false",
  });
  for (const step of updateProgressSteps()) {
    const status = srOnly();
    const li = h("li", {}, [
      h("span", { class: "check-icon" }, [stepMark("pending")]),
      step.label,
      status,
    ]);
    rows.set(step.id, li);
    labels.set(step.id, step.label);
    statusEls.set(step.id, status);
    list.append(li);
  }
  show(
    brand(),
    h("h1", {}, [t("workerUpdate.updatingTitle")]),
    h("p", { class: "lede" }, [t("workerUpdate.updatingLede")]),
    h("div", { class: "card" }, [list]),
  );
  const unlisten = await listen<StepEvent>("setup-progress", (e) => {
    const li = rows.get(e.payload.step);
    if (!li) return;
    li.className = e.payload.status;
    const sentence = `${labels.get(e.payload.step)}: ${statusWord(e.payload.status)}`;
    li.setAttribute("aria-label", sentence);
    statusEls.get(e.payload.step)!.textContent = sentence;
    li.querySelector<HTMLSpanElement>(".check-icon")!.replaceChildren(stepMark(e.payload.status));
  });
  try {
    details = await invoke<ConnectionDetails>("start_worker_update");
    unlisten();
    workerUpdateDoneScreen();
  } catch (e) {
    unlisten();
    runWorkerUpdate(String(e));
  }
}

function workerUpdateDoneScreen() {
  currentScreen = workerUpdateDoneScreen;
  setRail("workerUpdate");
  const done = h("button", { class: "btn-primary" }, [t("details.openDashboard")]);
  done.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, [t("workerUpdate.doneTitle")]),
    h("p", { class: "lede" }, [t("workerUpdate.doneLede")]),
    done,
  );
}

// ── Changing your password (#235) ────────────────────────────────────────────
//
// Two doors, one sequence. Door A is a voluntary change from the Connection
// pane; Door B is "I don't have my password" on the connect screens. Neither
// needs the current password — Cloudflare account access is the authority
// either way — so they differ only in where they start and what they say.
//
// The rule this whole section is written around: after the change lands, the
// new password cannot be read back by anything, so it stays on screen in every
// state that follows the save gate, including all three failures, and behind a
// reveal on the done screen.

/** Which door this run came through. Selects the intro and the done heading. */
let rotationDoor: "change" | "lost" = "change";

/**
 * The brain being changed. Door A leaves it null — the address is whatever this
 * computer already has stored. Door B has no stored setup, so the address the
 * user picked or typed has to travel with the call.
 */
let rotationAddress: string | null = null;

/** An address typed on the connect screen before taking Door B, kept as the
 *  prefill for lost-mode address entry when a scan turns up nothing. */
let rotationTypedAddress = "";

/**
 * The chosen password, held here rather than read out of the field, so a
 * locale change re-renders a screen without discarding a password the user may
 * already have written down.
 */
let rotationPassword = "";
/** True while the field still holds what `generate_password` produced. */
let rotationGenerated = false;

/**
 * True once *any* attempt in this window has reached the "may already be live"
 * state, and never cleared until a change is confirmed.
 *
 * The reason it is sticky rather than per-attempt: attempt one can PUT the
 * secret and then time out waiting for the brain to confirm it, and attempt two
 * can fail before the PUT — an expired sign-in, a transient account lookup —
 * which on its own is honestly "nothing was changed". Rendering that screen
 * would tell someone whose old password is already dead that everything is
 * exactly as it was, which is the one message in this flow that ends with a
 * brain nobody can open.
 */
let rotationMayBeLive = false;

/**
 * Entering the flow from outside — Door A at launch, or the ghost link on any
 * of the three connect screens. Deliberately not called by the Back paths,
 * which are inside a flow that is still choosing its password.
 *
 * `rotationMayBeLive` is *not* reset here: a second run with a second password
 * does not undo a first run that may already have taken effect, so the doubt
 * outlives the flow that created it and only a confirmed change clears it.
 */
function beginRotation() {
  rotationPassword = "";
  rotationGenerated = false;
  // Every screen from here to the done screen is a management flow launched
  // from Details or from a connect screen, not a step of setup. One call
  // covers the whole flow: `setRail` is re-asserted on each of its screens
  // below, and nothing inside it ever sets a setup screen.
  setRail("rotation");
}

/** Where the password step's Back leads. Usually the intro; the discovery paths
 *  set it to the picker they came from, because the intro would mean signing in
 *  to Cloudflare a second time to get back here. */
let rotationBack: () => void = () => changePasswordIntroScreen();

/** Where Door B leads out — the screen the ghost link was clicked on. */
let rotationExit: () => void = () => connectExistingScreen();

/**
 * True once `connect_cloudflare` has succeeded in this window. The account list
 * is only ever set from its result, and that result is never empty — a login
 * with no usable account is an error, not a success.
 */
function signedInToCloudflare(): boolean {
  return accounts.length > 0;
}

/** Leaves the flow without changing anything. Door A has a dashboard to go back
 *  to; Door B does not, so it returns to the screen the link was taken from. */
function leaveRotation() {
  if (rotationDoor === "lost") rotationExit();
  else void invoke("open_dashboard");
}

/**
 * An exit from a screen that may be holding the only password that opens the
 * brain.
 *
 * The save gate has a deliberate "I've saved it" confirmation for a password
 * that is merely *proposed*. Past that point the same password may already be
 * the live one and this window the only place it exists, so walking away from
 * it gets the same acknowledgement rather than a single click on a ghost.
 *
 * Not used on the "nothing was changed" screen: that screen renders only when
 * no attempt in this window has ever reached the brain, so the password on it
 * is by the app's own account not in use, and its copy says so.
 *
 * The two-step shape matches the Disconnect and Log out controls in the
 * Connections window, so the pattern is already familiar where it matters most.
 */
function guardedExit(label: string, leave: () => void): HTMLElement {
  const host = h("div", {});
  const render = (confirming: boolean) => {
    if (!confirming) {
      const go = h("button", { class: "btn-ghost btn-stack" }, [label]);
      go.addEventListener("click", () => render(true));
      host.replaceChildren(go);
      return;
    }
    const confirm = h("button", { class: "btn-danger" }, [t("changePassword.leaveConfirm")]);
    confirm.addEventListener("click", leave);
    const stay = h("button", { class: "btn-ghost" }, [t("changePassword.leaveKeep")]);
    stay.addEventListener("click", () => render(false));
    host.replaceChildren(
      keyNotice(t("changePassword.leaveWarn")),
      h("div", { class: "row-actions" }, [confirm, stay]),
    );
  };
  render(false);
  return host;
}

function cloudflareWaitingScreen(lede: string) {
  show(
    brand(),
    h("h1", {}, [t("cloudflare.waitingTitle")]),
    h("p", { class: "lede" }, [lede]),
    h("div", { class: "checklist", role: "status", "aria-live": "polite" }, [
      h("li", { class: "running" }, [
        h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
        t("cloudflare.watchingSignIn"),
      ]),
    ]),
  );
}

async function rotationSignIn(onError: (msg: string) => void, next: () => void) {
  currentScreen = () => cloudflareWaitingScreen(t("changePassword.waitingLede"));
  setRail("rotation");
  cloudflareWaitingScreen(t("changePassword.waitingLede"));
  try {
    accounts = await invoke<Account[]>("connect_cloudflare");
    next();
  } catch (e) {
    onError(String(e));
  }
}

/// Door A. Sign-in comes before the password because it is the step most likely
/// to fail, and failing before the user has committed to anything is cleaner.
/// There is no account picker: the account is derived from the address, so a
/// login that does not hold it is a wrong answer rather than a choice.
function changePasswordIntroScreen(errorMsg?: string) {
  currentScreen = () => changePasswordIntroScreen(errorMsg);
  setRail("rotation");
  rotationDoor = "change";
  rotationAddress = null;
  rotationBack = () => changePasswordIntroScreen();

  const signIn = h("button", { class: "btn-primary" }, [t("changePassword.signInButton")]);
  signIn.addEventListener("click", () =>
    void rotationSignIn(
      (msg) => changePasswordIntroScreen(msg),
      () => choosePasswordScreen(),
    ),
  );
  const notNow = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.notNow"),
  ]);
  notNow.addEventListener("click", () => void invoke("open_dashboard"));

  show(
    brand(),
    h("h1", {}, [t("changePassword.title")]),
    h("p", { class: "lede" }, [t("changePassword.lede")]),
    keyNotice(t("changePassword.notice")),
    errorMsg ? notice(errorMsg) : "",
    signIn,
    notNow,
    h("p", { class: "footnote" }, [t("changePassword.signInFootnote")]),
  );
}

/// Door B. One screen, two variants — the heading does the reassurance on its
/// own, because the heading is what a frightened person reads before anything
/// else. `address` is null when the brain still has to be found.
function lostPasswordIntroScreen(address: string | null, errorMsg?: string) {
  currentScreen = () => lostPasswordIntroScreen(address, errorMsg);
  setRail("rotation");
  rotationDoor = "lost";
  rotationAddress = address;
  rotationBack = () => lostPasswordIntroScreen(address);

  const signedIn = signedInToCloudflare();
  // With the brain already known there is nothing left to look for; otherwise
  // the scan runs first and the picker chooses.
  const proceed = () => (address ? choosePasswordScreen() : void lostDiscovery());

  const primary = h("button", { class: "btn-primary" }, [
    t(signedIn ? "changePassword.lostContinueButton" : "changePassword.lostSignInButton"),
  ]);
  primary.addEventListener("click", () => {
    if (signedIn) return proceed();
    void rotationSignIn((msg) => lostPasswordIntroScreen(address, msg), proceed);
  });

  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => rotationExit());

  show(
    brand(),
    h("h1", {}, [t("changePassword.lostTitle")]),
    h("p", { class: "lede" }, [t("changePassword.lostLede")]),
    h("p", { class: "lede" }, [
      t(signedIn ? "changePassword.lostBodySignedIn" : "changePassword.lostBodySignIn"),
    ]),
    keyNotice(t("changePassword.lostNotice")),
    errorMsg ? notice(errorMsg) : "",
    primary,
    back,
    // What granting Cloudflare access means, unchanged: nothing about changing
    // a password alters that bargain.
    signedIn ? "" : h("p", { class: "footnote" }, [t("connectExisting.signInFootnote")]),
  );
  // Row G (plan §4.4): one line, then silent — no other screen in this flow
  // calls ridgeSay, by design (plan §4.7's delight budget: rotation gets less
  // Ridge, not more).
  ridgeSay({
    key: "mascot.rotation.intro",
    text: t("mascot.rotation.intro"),
    state: "idle",
    persist: "once",
  });
}

async function lostDiscovery() {
  if (accounts.length === 1) {
    chosenAccount = accounts[0];
    await runLostDiscovery();
    return;
  }
  accountPickerScreen(
    () => void runLostDiscovery(),
    t("connectExisting.accountPickerTitle"),
    t("connectExisting.accountPickerLede"),
    () => lostPasswordIntroScreen(null),
  );
}

async function runLostDiscovery() {
  currentScreen = searchingScreen;
  setRail("rotation");
  searchingScreen();
  try {
    const found = await invoke<DiscoveredBrain[]>("discover_brains", {
      accountId: chosenAccount?.id ?? "",
    });
    if (found.length === 0) {
      lostAddressScreen([]);
      return;
    }
    lostBrainPickerScreen(found);
  } catch (e) {
    // A scan that fails is not a dead end for someone already locked out: the
    // address can be typed, and the change works the same way from there.
    lostAddressScreen([], String(e));
  }
}

/// The existing picker's headings still read correctly; its ledes do not —
/// "Connect to it" is wrong when there is nothing to connect with yet.
function lostBrainPickerScreen(found: DiscoveredBrain[]) {
  currentScreen = () => lostBrainPickerScreen(found);
  setRail("rotation");
  const list = h("ul", { class: "account-list", role: "list" });
  for (const brain of found) {
    const btn = h("button", {}, [brain.url.replace(/^https:\/\//, "")]);
    btn.addEventListener("click", () => {
      rotationAddress = brain.url;
      rotationBack = () => lostBrainPickerScreen(found);
      choosePasswordScreen();
    });
    list.append(h("li", {}, [btn]));
  }
  // Same slot as on the connect picker, different destination: the screen it
  // used to open has a password field, which is the one thing this user hasn't
  // got.
  const manual = h("button", { class: "btn-ghost btn-stack" }, [
    t("connectExisting.manualButton"),
  ]);
  manual.addEventListener("click", () => lostAddressScreen(found, undefined, true));

  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => lostPasswordIntroScreen(null));

  const one = found.length === 1;
  show(
    brand(),
    h("h1", {}, [t(one ? "connectExisting.pickTitleOne" : "connectExisting.pickTitleMany")]),
    h("p", { class: "lede" }, [
      t(one ? "changePassword.pickBrainLedeOne" : "changePassword.pickBrainLedeMany"),
    ]),
    list,
    manual,
    back,
  );
}

/// Discovery finding nothing is not a failure — custom domains and second
/// accounts exist — and without this the only fallback is a screen asking for
/// the password the user came here without.
function lostAddressScreen(
  found: DiscoveredBrain[],
  errorMsg?: string,
  fromPicker = false,
  prefill = rotationTypedAddress,
) {
  currentScreen = () => lostAddressScreen(found, errorMsg, fromPicker, prefill);
  setRail("rotation");
  const address = h("input", {
    type: "text",
    placeholder: t("connectExisting.addressPlaceholder"),
    "aria-label": t("connectExisting.addressPlaceholder"),
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  address.value = prefill;

  const next = h("button", { class: "btn-primary" }, [t("common.continue")]);
  const sync = () => {
    if (address.value.trim()) next.removeAttribute("disabled");
    else next.setAttribute("disabled", "");
  };
  address.addEventListener("input", sync);
  // Checked here rather than at the far end of the flow. `validate_brain_address`
  // runs exactly the checks `rotate_password` runs on an explicit address, so a
  // typo is reported in the field it was typed in — not after the save gate, a
  // progress screen and a failure screen that has to hedge about what happened.
  next.addEventListener("click", async () => {
    const typed = address.value.trim();
    next.disabled = true;
    next.textContent = t("common.checking");
    try {
      await invoke("validate_brain_address", { address: typed });
    } catch (e) {
      lostAddressScreen(found, String(e), fromPicker, typed);
      return;
    }
    rotationAddress = typed;
    rotationTypedAddress = typed;
    rotationBack = () => lostAddressScreen(found, undefined, fromPicker, rotationTypedAddress);
    choosePasswordScreen();
  });

  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  // Back to the picker when there was one. With no picker there is nothing
  // behind this screen but the sign-in that reached it, so Back leaves.
  back.addEventListener("click", () =>
    found.length ? lostBrainPickerScreen(found) : rotationExit(),
  );

  show(
    brand(),
    h("h1", {}, [t("changePassword.addressTitle")]),
    h("p", { class: "lede" }, [
      t(fromPicker ? "changePassword.addressLedeManual" : "changePassword.addressLede"),
    ]),
    errorMsg ? notice(errorMsg) : "",
    h("div", { class: "field-stack" }, [address]),
    next,
    back,
  );
  sync();
  address.focus();
}

/// Setup's password mechanics exactly — same meter, same debounced
/// `check_password`, same generate button — with two differences: the field
/// arrives pre-filled from `generate_password`, and it stays readable. Rotation
/// replaces a string that lives in a password manager and gets pasted into a
/// handful of devices once each, so memorability buys nothing and the fastest
/// way through is also the strongest. Typing over it brings the meter and the
/// breach check back exactly as at setup.
function choosePasswordScreen() {
  currentScreen = choosePasswordScreen;
  setRail("rotation");
  const pw = h("input", {
    type: "text",
    placeholder: t("password.placeholder"),
    "aria-label": t("password.placeholder"),
  });
  const confirm = h("input", {
    type: "text",
    placeholder: t("password.confirmPlaceholder"),
    "aria-label": t("password.confirmPlaceholder"),
  });
  pw.value = rotationPassword;
  confirm.value = rotationPassword;
  const fill = h("div", { class: "strength-fill" });
  const label = h("span", { class: "strength-label" });
  const hint = h("p", { class: "hint" }, [""]);
  const generatedNote = h("p", { class: "hint" }, [""]);
  const generate = h("button", {
    class: "input-action",
    title: t("password.generateTitle"),
    "aria-label": t("password.generateTitle"),
  });
  generate.append(icon("sparkles", "icon icon--sm"));
  const next = h("button", { class: "btn-primary", disabled: "" }, [t("common.continue")]);

  let check: PasswordCheck | null = null;
  let debounce: number | undefined;

  const render = () => {
    const s = meterFor(pw.value, check);
    fill.style.width = `${s.pct}%`;
    fill.style.background = s.color;
    label.textContent = s.label;
    generatedNote.textContent = rotationGenerated ? t("changePassword.generatedNote") : "";
    const longEnough = pw.value.trim().length >= 12;
    const match = pw.value === confirm.value;
    const breached = check?.breached ?? false;
    if (breached) {
      hint.textContent = t("password.breachHint");
      hint.className = "hint error";
    } else if (pw.value && confirm.value && !match) {
      hint.textContent = t("password.mismatch");
      hint.className = "hint error";
    } else {
      hint.textContent = "";
      hint.className = "hint";
    }
    if (longEnough && match && check !== null && !breached) {
      next.removeAttribute("disabled");
    } else {
      next.setAttribute("disabled", "");
    }
  };

  const runCheck = () => {
    const value = pw.value.trim();
    if (value.length < 12) return;
    invoke<PasswordCheck>("check_password", { password: pw.value })
      .then((result) => {
        if (pw.value.trim() !== value) return;
        check = result;
        render();
      })
      .catch(() => {
        // Fails open, exactly as at setup: a change must not be blocked by an
        // offline third party, least of all on the door for someone locked out.
        check = { breached: false, count: 0, score: 3, online: false };
        render();
      });
  };

  const useGenerated = (generated: string) => {
    pw.value = generated;
    confirm.value = generated;
    rotationPassword = generated;
    rotationGenerated = true;
    check = null;
    render();
    runCheck();
  };

  pw.addEventListener("input", () => {
    rotationPassword = pw.value;
    rotationGenerated = false;
    check = null;
    render();
    window.clearTimeout(debounce);
    debounce = window.setTimeout(runCheck, 450);
  });
  confirm.addEventListener("input", render);

  generate.addEventListener("click", () => {
    void invoke<string>("generate_password").then(useGenerated);
  });

  next.addEventListener("click", () => {
    rotationPassword = pw.value;
    savePasswordScreen();
  });

  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", () => rotationBack());

  show(
    brand(),
    h("h1", {}, [t("changePassword.pickTitle")]),
    h("p", { class: "lede" }, [t("changePassword.pickLede")]),
    h("div", { class: "field-stack" }, [
      h("div", { class: "input-wrap" }, [pw, generate]),
      h("div", { class: "strength" }, [h("div", { class: "strength-track" }, [fill]), label]),
      confirm,
      hint,
      generatedNote,
    ]),
    keyNotice(t("changePassword.pickNotice")),
    next,
    back,
    h("p", { class: "footnote" }, [t("password.footnote")]),
  );

  if (rotationPassword) {
    render();
    runCheck();
  } else {
    // Pre-filled on arrival, not on a click. If that ever fails the screen is
    // still usable: an empty field the user types into, exactly as at setup.
    void invoke<string>("generate_password").then(useGenerated, render);
  }
}

/// The gate. One screen, one job. No email button: the address and the
/// connection link are not secrets and this is, and a button is advice.
function savePasswordScreen() {
  currentScreen = savePasswordScreen;
  setRail("rotation");
  // btn-danger is a small pill everywhere else in the app; here it is the
  // screen's primary, so it borrows the setup buttons' metrics. Its label is
  // itself the acknowledgement, matching the one other place in the app where
  // that is true (freeing the old search index).
  const confirm = h("button", { class: "btn-primary btn-danger" }, [
    t("changePassword.saveConfirm"),
  ]);
  confirm.addEventListener("click", () => void runRotation());
  const back = h("button", { class: "btn-ghost btn-stack" }, [
    t("changePassword.saveBack"),
  ]);
  back.addEventListener("click", () => choosePasswordScreen());

  show(
    brand(),
    h("h1", {}, [t("changePassword.saveTitle")]),
    h("p", { class: "lede" }, [t("changePassword.saveLede")]),
    secretCard(t("changePassword.passwordLabel"), rotationPassword),
    h("p", { class: "footnote" }, [t("changePassword.saveAdvice")]),
    confirm,
    back,
  );
}

/// The ids are `ROTATION_STEP_IDS`, which is where the wire contract with the
/// Rust `Step` enum is stated and tested; this only decides what each one is
/// called on screen. Keyed by id rather than listed alongside them so a label
/// cannot be attached to a step that does not exist, or a step left unlabelled.
const ROTATION_STEP_LABELS: Record<RotationStepId, ChangePasswordKey> = {
  secret: "changePassword.stepSend",
  confirm: "changePassword.stepConfirm",
  local: "changePassword.stepLocal",
};

function rotationSteps(): { id: StepId; label: string }[] {
  return ROTATION_STEP_IDS.map((id) => ({ id, label: t(ROTATION_STEP_LABELS[id]) }));
}

/** Step state lives outside the render so a locale change redraws the checklist
 *  instead of starting a second change. */
const rotationStepStatus = new Map<StepId, StepEvent["status"]>();

/// No Cancel: between the change going out and the brain confirming it there is
/// no state to return to, and a button that abandons the flow at that exact
/// moment would manufacture the "may already be live" case on purpose.
function rotationProgressScreen() {
  currentScreen = rotationProgressScreen;
  setRail("rotation");
  const list = h("ul", {
    class: "checklist",
    role: "list",
    "aria-live": "polite",
    "aria-atomic": "false",
  });
  for (const step of rotationSteps()) {
    const status = rotationStepStatus.get(step.id);
    const li = h("li", status ? { class: status } : {}, [
      h("span", { class: "check-icon" }, [stepMark(status ?? "pending")]),
      step.label,
      // A real text node, not just the `aria-label` below: an attribute change
      // is not a live-region trigger in VoiceOver/NVDA (#P0-7).
      srOnly(status ? `${step.label}: ${statusWord(status)}` : ""),
    ]);
    if (status) li.setAttribute("aria-label", `${step.label}: ${statusWord(status)}`);
    list.append(li);
  }
  show(
    brand(),
    h("h1", {}, [t("changePassword.progressTitle")]),
    h("p", { class: "lede" }, [t("changePassword.progressLede")]),
    h("div", { class: "card" }, [list]),
  );
}

async function runRotation() {
  rotationStepStatus.clear();
  rotationProgressScreen();
  const unlisten = await listen<StepEvent>("setup-progress", (e) => {
    rotationStepStatus.set(e.payload.step, e.payload.status);
    rotationProgressScreen();
  });
  try {
    // Door B has no stored setup, so the brain it picked travels with the call.
    // Door A omits it and the command uses the address this computer holds.
    const outcome = await invoke<RotateOutcome>(
      "rotate_password",
      rotateArgs(rotationPassword, rotationAddress),
    );
    unlisten();
    // The brain confirmed the new password, so there is no ambiguity left for a
    // later attempt to inherit.
    rotationMayBeLive = false;
    // The done screen opens by claiming this computer already uses the new
    // password, so it only gets shown when every local write says so.
    if (screenForOutcome(outcome) === "failLocal") rotateFailLocalScreen(outcome);
    else rotateDoneScreen();
  } catch (e) {
    unlisten();
    const failure = rotateErrorOf(e);
    if (failure.stage === "unconfirmed") rotationMayBeLive = true;
    switch (screenForFailure(failure.stage, rotationMayBeLive)) {
      case "failLocal":
        rotateFailLocalScreen(null, failure.detail);
        break;
      case "failUnsure":
        rotateFailUnsureScreen(failure.detail);
        break;
      case "blocked":
        rotateBlockedScreen(failure.detail);
        break;
      default:
        rotateFailNotSentScreen(failure.detail);
    }
  }
}

/// A rebuild started while this flow was open, so nothing was attempted. The
/// same three strings the Connection pane shows in place of the door, including
/// the escape — an abandoned rebuild would otherwise leave this screen as a dead
/// end with the reason relegated to a footnote under "Try again".
///
/// This screen renders whenever the stage is `blocked`, including after an
/// earlier attempt that may already have changed the password. It is the only
/// place the escape route is named, and a run that is blocked stays blocked, so
/// routing that case to "may already be live" would leave a "Try again" button
/// on a run that cannot succeed and no way to reach the thing that unsticks it.
/// The other truth is not dropped: `blockedCopy` puts it on this screen.
function rotateBlockedScreen(detail: string) {
  currentScreen = () => rotateBlockedScreen(detail);
  setRail("rotation");
  const copy = blockedCopy(rotationMayBeLive);
  const settings = h("button", { class: "btn-primary" }, [t("changePassword.blockedButton")]);
  settings.addEventListener("click", () => void invoke("open_settings_window"));
  // Leaving is a click when nothing was sent and the old password still works,
  // and a decision when this window holds the only copy of one that may already
  // be live — the same acknowledgement the other may-be-live screen asks for.
  const leave = copy.guardLeaving
    ? guardedExit(t("changePassword.failUnsureLeave"), leaveRotation)
    : (() => {
        const go = h("button", { class: "btn-ghost btn-stack" }, [
          t("common.notNow"),
        ]);
        go.addEventListener("click", leaveRotation);
        return go;
      })();

  show(
    brand(),
    h("h1", {}, [t("changePassword.blockedTitle")]),
    notice(t("changePassword.blockedBody")),
    h("p", { class: "lede" }, [t("changePassword.blockedEscape")]),
    // Above the password card, because it is the reason to keep what is in it.
    copy.liveNotice ? notice(t(copy.liveNotice)) : "",
    failDetailLine(detail),
    // "The password you chose — not in use" while nothing has been sent, and
    // "Your new password" once an attempt may have landed. Calling it not in
    // use on that second path would tell someone deciding whether to keep it
    // that they can safely throw away the only key to their brain.
    secretCard(t(copy.passwordLabel), rotationPassword),
    settings,
    leave,
  );
  ridgeSay({
    key: "mascot.error.rotateBlocked",
    text: t("mascot.error.rotateBlocked"),
    state: "alarmed",
    anchor: () => settings,
    persist: "always",
  });
}

function failDetailLine(detail: string): HTMLElement | string {
  return detail ? h("p", { class: "footnote" }, [t("changePassword.failDetail", { detail })]) : "";
}

/// Nothing reached the brain, so the old password still works. This is the one
/// screen in the feature where the word "failed" belongs, and the password is
/// labelled by what it actually is here: chosen, and not in use.
function rotateFailNotSentScreen(detail: string) {
  currentScreen = () => rotateFailNotSentScreen(detail);
  setRail("rotation");
  const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
  retry.addEventListener("click", () => void runRotation());
  const leave = h("button", { class: "btn-ghost btn-stack" }, [
    t("common.notNow"),
  ]);
  leave.addEventListener("click", leaveRotation);

  show(
    brand(),
    h("h1", {}, [t("changePassword.failNotSentTitle")]),
    notice(t("changePassword.failNotSentBody")),
    failDetailLine(detail),
    secretCard(t("changePassword.failNotSentLabel"), rotationPassword),
    retry,
    leave,
  );
  ridgeSay({
    key: "mascot.error.rotateNotSent",
    text: t("mascot.error.rotateNotSent"),
    state: "alarmed",
    anchor: () => retry,
    persist: "always",
  });
}

/// The change went out and never confirmed. Never says "failed": the heading is
/// a statement about the password, which is the only fact the app has. Retry is
/// the escape and the copy says why — setting the same password twice confirms
/// what landed or completes what did not.
function rotateFailUnsureScreen(detail: string, recheck?: RecheckResult) {
  currentScreen = () => rotateFailUnsureScreen(detail, recheck);
  setRail("rotation");
  const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
  retry.addEventListener("click", () => void runRotation());

  // Read-only: a /health probe with the new password, no write. It is safe to
  // offer on the one screen where the user does not know what happened.
  const check = h("button", { class: "btn-ghost btn-stack" }, [
    t("changePassword.recheckButton"),
  ]);
  check.addEventListener("click", async () => {
    check.disabled = true;
    check.textContent = t("common.checking");
    // Three answers, not two. The command deliberately separates "the brain
    // answered, and not to this password" from "we could not ask it": reporting
    // the second as the first turns a question that was never put into an answer
    // of no, on the one screen where the user is deciding what to believe.
    //
    // The address travels with the call for the same reason it does with the
    // change itself — Door B is a computer with no stored setup, so a missing
    // address resolves to nothing rather than to the brain being asked about.
    let result: RecheckResult;
    try {
      const live = await invoke<boolean>(
        "recheck_password",
        recheckArgs(rotationPassword, rotationAddress),
      );
      result = live ? "confirmed" : "notLive";
    } catch {
      result = "unreachable";
    }
    rotateFailUnsureScreen(detail, result);
  });

  const recheckKey: Record<RecheckResult, ChangePasswordKey> = {
    confirmed: "changePassword.recheckConfirmed",
    notLive: "changePassword.recheckUnconfirmed",
    unreachable: "changePassword.recheckUnreachable",
  };

  const secret = secretCard(t("changePassword.passwordLabel"), rotationPassword);
  show(
    brand(),
    h("h1", {}, [t("changePassword.failUnsureTitle")]),
    notice(t("changePassword.failUnsureBody")),
    secret,
    recheck ? notice(t(recheckKey[recheck]), "info") : "",
    h("p", { class: "lede" }, [t("changePassword.failUnsureRetry")]),
    failDetailLine(detail),
    retry,
    check,
    // This window may hold the only password that opens the brain, so leaving
    // it is a decision rather than a click.
    guardedExit(t("changePassword.failUnsureLeave"), leaveRotation),
    // Not decoration: nothing local was written, so this machine still holds a
    // password that may now be dead, and the window with the live one is about
    // to be closed.
    h("p", { class: "footnote" }, [t("changePassword.failUnsureFootnote")]),
  );
  // Spotlights the password card first, per plan §4.5 — the line's own text
  // says to save it before anything else, so the ring goes where the text
  // points rather than at "Try again".
  ridgeSay({
    key: "mascot.error.rotateUnsure",
    text: t("mascot.error.rotateUnsure"),
    state: "alarmed",
    anchor: () => secret,
    persist: "always",
  });
}

/// The brain has the new password; something local did not get it. No "try
/// again" — the change is done, and re-running the flow to fix a keychain write
/// would change the password a second time.
function rotateFailLocalScreen(outcome: RotateOutcome | null, detail = "") {
  currentScreen = () => rotateFailLocalScreen(outcome, detail);
  setRail("rotation");
  // Heading and body are chosen together. They used to disagree: the body
  // switched to the CLI-specific message when secure storage had in fact
  // succeeded, while the heading went on saying the password was "not saved on
  // this computer" — and the heading was the false one.
  const copy = localFailureCopy(outcome);

  // When secure storage took the new password this computer can open its own
  // brain, so the dashboard button is the right exit. When it did not, that
  // button opens a window that silently 401s — on Door B it rejects outright,
  // leaving the screen's only control visibly doing nothing, forever. The
  // honest offer there is to connect this computer again with the password on
  // screen, and it is guarded, because taking it means leaving this screen.
  const exit = copy.reconnect
    ? guardedExit(t("changePassword.failLocalReconnect"), () => connectExistingScreen())
    : (() => {
        const open = h("button", { class: "btn-primary" }, [t("details.openDashboard")]);
        open.addEventListener("click", () => void invoke("open_dashboard"));
        return open;
      })();

  show(
    brand(),
    h("h1", {}, [t(copy.title)]),
    notice(t(copy.notice)),
    ...copy.extra.map((key) => h("p", { class: "lede" }, [t(key)])),
    secretCard(t("changePassword.passwordLabel"), rotationPassword),
    failDetailLine(detail),
    exit,
  );
  ridgeSay({
    key: "mascot.error.rotateLocal",
    text: t("mascot.error.rotateLocal"),
    state: "alarmed",
    anchor: () => exit,
    persist: "always",
  });
}

/// Read correctly by two people: someone doing routine hygiene, who is
/// finished, and someone who has just had a leak, who is not. What will ask for
/// the new password comes first because it is true for everyone; the OAuth
/// explanation is context, and the leak sentence is a condition rather than a
/// warning, so a hygiene user dismisses it in one beat.
function rotateDoneScreen(revealed = false) {
  currentScreen = () => rotateDoneScreen(revealed);
  setRail("rotation");
  // Four items, not three. A change writes to secure storage, the brain
  // command's config and the open dashboard window — so the extension and the
  // Obsidian plugin hold the old password on *this* computer too, which is what
  // Door B's notice has always told people and this list used to deny.
  const needs = h("ul", { class: "bullet-list" }, [
    h("li", {}, [t("changePassword.doneNeeds1")]),
    h("li", {}, [t("changePassword.doneNeeds2")]),
    h("li", {}, [t("changePassword.doneNeeds3")]),
    h("li", {}, [t("changePassword.doneNeeds4")]),
  ]);
  const disconnect = h("button", { class: "btn-secondary" }, [
    t("changePassword.doneDisconnectButton"),
  ]);
  // Opens the pane the control lives in; it disconnects nothing on click.
  disconnect.addEventListener("click", () => void invoke("open_details_window"));

  const reveal = h("button", { class: "btn-ghost btn-stack" }, [
    t(revealed ? "changePassword.doneHide" : "changePassword.doneShow"),
  ]);
  reveal.addEventListener("click", () => rotateDoneScreen(!revealed));

  const open = h("button", { class: "btn-primary" }, [t("details.openDashboard")]);
  open.addEventListener("click", () => void invoke("open_dashboard"));

  show(
    brand(),
    h("h1", {}, [
      t(rotationDoor === "lost" ? "changePassword.doneTitleLost" : "changePassword.doneTitle"),
    ]),
    h("p", { class: "lede" }, [t("changePassword.doneLede")]),
    h("div", { class: "card" }, [
      h("div", { class: "url-label" }, [t("changePassword.doneNeedsHead")]),
      needs,
    ]),
    h("div", { class: "card" }, [
      h("div", { class: "url-label" }, [t("changePassword.doneKeptHead")]),
      h("div", { class: "url-desc" }, [t("changePassword.doneKept")]),
      // A notice, not a notice error. Most changes are hygiene, and a red block
      // on every one of them trains people to skip the block — including the
      // person it was written for.
      keyNotice(t("changePassword.doneLeak")),
      h("div", { class: "row-actions" }, [disconnect]),
    ]),
    // Collapsed by default, so it is not sitting in a window someone walked
    // away from — but still reachable, which is what the save gate promised.
    revealed ? secretCard(t("changePassword.passwordLabel"), rotationPassword) : "",
    reveal,
    open,
  );
}

/// Shown at launch when this computer's stored password no longer opens the
/// brain. Three ways forward: enter the new one, find the brain again, or set a
/// new one — the last is for the two people most likely to be here, someone
/// without the new password and someone who did not make the change.
async function passwordChangedElsewhereScreen(errorMsg?: string) {
  currentScreen = () => void passwordChangedElsewhereScreen(errorMsg);
  // A recovery entry point, not step one: this computer already finished setup
  // once, so a rail ticking off Start and Password would be describing a walk
  // that is not happening.
  setRail("stalePassword");
  const stored = await invoke<ConnectionDetails>("get_connection_details").catch(() => null);
  if (!stored) {
    // Nothing stored to be stale about; the ordinary connect path applies.
    connectExistingScreen();
    return;
  }

  const password = h("input", {
    type: "password",
    placeholder: t("connectExisting.passwordPlaceholder"),
    "aria-label": t("connectExisting.passwordPlaceholder"),
  });
  const connect = h("button", { class: "btn-primary" }, [t("common.connect")]);
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    connect.textContent = t("common.checking");
    try {
      details = await invoke<ConnectionDetails>("connect_existing", {
        address: stored.workerUrl,
        password: password.value,
      });
      // Straight on to the wrapper window with no comment: if the brain answers
      // normally now, this screen was a transient 401 and an apology for it
      // would be noise.
      await invoke("open_dashboard");
    } catch (e) {
      void passwordChangedElsewhereScreen(String(e));
    }
  });

  const findAgain = h("button", { class: "btn-ghost btn-stack" }, [
    t("passwordChangedElsewhere.findAgain"),
  ]);
  findAgain.addEventListener("click", () => void discoverScreen());

  const lost = h("button", { class: "btn-ghost btn-stack" }, [
    t("connectExisting.lostPassword"),
  ]);
  lost.addEventListener("click", () => {
    beginRotation();
    rotationExit = () => void passwordChangedElsewhereScreen();
    lostPasswordIntroScreen(stored.workerUrl);
  });

  show(
    brand(),
    h("h1", {}, [t("passwordChangedElsewhere.title")]),
    h("p", { class: "lede" }, [t("passwordChangedElsewhere.lede")]),
    h("p", { class: "lede" }, [t("passwordChangedElsewhere.body")]),
    errorMsg ? notice(errorMsg) : "",
    h("div", { class: "field-stack" }, [password]),
    connect,
    findAgain,
    h("p", { class: "footnote" }, [t("passwordChangedElsewhere.findAgainHint")]),
    h("p", { class: "footnote" }, [t("passwordChangedElsewhere.footnote")]),
    lost,
  );
  ridgeSay({
    key: "mascot.error.staleLocal",
    text: t("mascot.error.staleLocal"),
    state: "alarmed",
    anchor: () => password,
    persist: "always",
  });
  password.focus();
}

function applyWindowTitle() {
  document.title = t("common.appTitle");
  void getCurrentWindow().setTitle(t("common.appTitle"));
}

async function boot() {
  initI18n();
  mountRidge();
  applyWindowTitle();
  window.addEventListener(LOCALE_CHANGE_EVENT, () => {
    applyWindowTitle();
    currentScreen?.();
  });

  try {
    const state = await invoke<{ mode: string; dryRun: boolean }>("get_app_state");
    if (state.dryRun) {
      document.body.append(h("div", { class: "dry-run-badge" }, [t("common.demoMode")]));
    }
    if (state.mode === "worker-update") {
      void workerUpdateScreen();
      return;
    }
    if (state.mode === "change-password") {
      beginRotation();
      changePasswordIntroScreen();
      return;
    }
    if (state.mode === "stale-password") {
      void passwordChangedElsewhereScreen();
      return;
    }
  } catch {
    /* welcome */
  }
  welcomeScreen();
}

void boot();
