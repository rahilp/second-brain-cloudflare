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
  secretCard,
  teamCard,
  toolRows,
} from "./shared";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initI18n, LOCALE_CHANGE_EVENT, t } from "./i18n";
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

/** Which setup screen is visible — used to re-render on locale change. */
let currentScreen: (() => void) | null = null;

function show(...nodes: (Node | string)[]) {
  app.replaceChildren(h("div", { class: "screen" }, nodes));
}

function brand(): HTMLElement {
  return h("div", { class: "brand" }, [h("img", { src: "/brain.png", alt: "" })]);
}

function welcomeScreen() {
  currentScreen = welcomeScreen;
  const start = h("button", { class: "btn-primary" }, [t("welcome.getStarted")]);
  start.addEventListener("click", audienceScreen);
  const existing = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
  const justMe = h("button", { class: "btn-primary" }, [t("audience.justMe")]);
  justMe.addEventListener("click", () => {
    teamMode = false;
    passwordScreen();
  });
  const aTeam = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("audience.aTeam"),
  ]);
  aTeam.addEventListener("click", () => {
    teamMode = true;
    passwordScreen();
  });
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("common.back"),
  ]);
  back.addEventListener("click", welcomeScreen);
  show(
    brand(),
    h("h1", {}, [t("audience.title")]),
    h("p", { class: "lede" }, [t("audience.lede")]),
    justMe,
    aTeam,
    back,
    h("p", { class: "footnote" }, [t("audience.footnote")]),
  );
}

function notice(message: string, tone: "error" | "info" = "error"): HTMLElement {
  return h("div", { class: `notice ${tone}` }, [
    tone === "error" ? "⚠️" : "💡",
    h("span", {}, [message]),
  ]);
}

/// Two ways in. Signing in to Cloudflare is offered first because it removes
/// the only genuinely hard step — finding the address — but manual entry is not
/// a fallback for failures alone: a custom domain, a brain in someone else's
/// account, or an unwillingness to grant scopes all need it, so it stays a
/// first-class choice.
function connectExistingScreen(errorMsg?: string) {
  currentScreen = () => connectExistingScreen(errorMsg);

  const signIn = h("button", { class: "btn-primary" }, [t("connectExisting.signInButton")]);
  signIn.addEventListener("click", () => void discoverScreen());

  const manual = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("connectExisting.manualButton"),
  ]);
  manual.addEventListener("click", () => manualEntryScreen());

  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [t("common.back")]);
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
}

function searchingScreen() {
  show(
    brand(),
    h("h1", {}, [t("connectExisting.searchingTitle")]),
    h("p", { class: "lede" }, [t("connectExisting.searchingLede")]),
    h("div", { class: "searching-status" }, [
      h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
      t("connectExisting.searchingStep"),
    ]),
  );
}

async function discoverScreen() {
  currentScreen = searchingScreen;
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
    manualEntryScreen(String(e));
  }
}

function brainPickerScreen(found: DiscoveredBrain[]) {
  currentScreen = () => brainPickerScreen(found);
  const list = h("ul", { class: "account-list" });
  for (const brain of found) {
    // The address leads, not the name: this app deploys every brain under the
    // same script name, so the address is the only part that distinguishes one.
    const btn = h("button", {}, [brain.url.replace(/^https:\/\//, "")]);
    btn.addEventListener("click", () => unlockBrainScreen(brain, undefined, found));
    list.append(h("li", {}, [btn]));
  }
  const manual = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("connectExisting.manualButton"),
  ]);
  manual.addEventListener("click", () => manualEntryScreen());

  const one = found.length === 1;
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
  const password = h("input", {
    type: "password",
    placeholder: t("connectExisting.passwordPlaceholder"),
  });
  const connect = h("button", { class: "btn-primary" }, [t("connectExisting.connect")]);
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [t("common.back")]);
  // Back to the pick-list, not to the chooser: returning to the chooser would
  // discard the scan and cost another Cloudflare sign-in to get here again.
  back.addEventListener("click", () => brainPickerScreen(found));

  // Last element, below Back, and a ghost: it is the rarer path, and above the
  // password field it would invite people to take it before trying the password
  // they have. The brain is chosen and Cloudflare is signed in from discovery,
  // so this goes straight to the password step.
  const lost = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("connectExisting.lostPassword"),
  ]);
  lost.addEventListener("click", () => {
    beginRotation();
    rotationExit = () => unlockBrainScreen(brain, undefined, found);
    lostPasswordIntroScreen(brain.url);
  });

  connect.addEventListener("click", async () => {
    connect.disabled = true;
    connect.textContent = t("common.checking");
    try {
      details = await invoke<ConnectionDetails>("connect_existing", {
        address: brain.url,
        password: password.value,
      });
      await toolsScreen();
    } catch (e) {
      unlockBrainScreen(brain, String(e), found);
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
  );
  password.focus();
}

/// Unchanged from before discovery existed, deliberately: this path must keep
/// working for anyone whose brain cannot be found automatically.
function manualEntryScreen(
  errorMsg?: string,
  prefillAddress?: string,
  tone: "error" | "info" = "error",
) {
  currentScreen = () => manualEntryScreen(errorMsg, prefillAddress, tone);
  const address = h("input", {
    type: "text",
    placeholder: t("connectExisting.addressPlaceholder"),
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  if (prefillAddress) address.value = prefillAddress;
  const password = h("input", { type: "password", placeholder: t("connectExisting.passwordPlaceholder") });
  const connect = h("button", { class: "btn-primary" }, [t("connectExisting.connect")]);
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [t("common.back")]);
  back.addEventListener("click", () => connectExistingScreen());

  // No Cloudflare session here, so this door routes through sign-in and
  // discovery first. Anything already typed is carried over as the fallback
  // address, for the brain a scan can't see — a custom domain, another account.
  const lost = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("connectExisting.lostPassword"),
  ]);
  lost.addEventListener("click", () => {
    beginRotation();
    rotationExit = () => manualEntryScreen(errorMsg, address.value, tone);
    rotationTypedAddress = address.value.trim();
    lostPasswordIntroScreen(null);
  });

  connect.addEventListener("click", async () => {
    connect.disabled = true;
    connect.textContent = t("common.checking");
    try {
      details = await invoke<ConnectionDetails>("connect_existing", {
        address: address.value,
        password: password.value,
      });
      await toolsScreen();
    } catch (e) {
      manualEntryScreen(String(e), address.value);
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
  );
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
  if (check === null) return { pct: 45, label: t("password.checking"), color: "var(--accent)" };
  if (check.breached)
    return { pct: 30, label: t("password.foundInBreaches"), color: "var(--danger)" };
  if (check.score >= 4) return { pct: 100, label: t("password.strong"), color: "var(--ok)" };
  if (check.score === 3) return { pct: 70, label: t("password.good"), color: "var(--ok)" };
  return { pct: 45, label: t("password.easyToGuess"), color: "var(--accent)" };
}

function passwordScreen() {
  currentScreen = passwordScreen;
  const pw = h("input", { type: "password", placeholder: t("password.placeholder") });
  const confirm = h("input", { type: "password", placeholder: t("password.confirmPlaceholder") });
  const fill = h("div", { class: "strength-fill" });
  const label = h("span", { class: "strength-label" });
  const hint = h("p", { class: "hint" }, [""]);
  const generate = h("button", {
    class: "input-action",
    title: t("password.generateTitle"),
    "aria-label": t("password.generateTitle"),
  });
  generate.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M11 2 C11.7 6.8 13.2 8.3 18 9 C13.2 9.7 11.7 11.2 11 16 C10.3 11.2 8.8 9.7 4 9 C8.8 8.3 10.3 6.8 11 2 Z"/>' +
    '<path d="M18 13 C18.35 15.4 19.1 16.15 21.5 16.5 C19.1 16.85 18.35 17.6 18 20 C17.65 17.6 16.9 16.85 14.5 16.5 C16.9 16.15 17.65 15.4 18 13 Z"/>' +
    "</svg>";
  const next = h("button", { class: "btn-primary", disabled: "" }, [t("common.continue")]);

  let check: PasswordCheck | null = null;
  let debounce: number | undefined;

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
    try {
      await invoke("submit_password", { password: pw.value });
      connectScreen();
    } catch (e) {
      hint.textContent = String(e);
      hint.className = "hint error";
    }
  });

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
    h("div", { class: "notice" }, ["🔑", h("span", {}, [t("password.notice")])]),
    next,
    h("p", { class: "footnote" }, [t("password.footnote")]),
  );
  pw.focus();
}

function connectScreen(errorMsg?: string) {
  currentScreen = () => connectScreen(errorMsg);
  const signIn = h("button", { class: "btn-primary" }, [t("cloudflare.signIn")]);
  const error = errorMsg
    ? h("div", { class: "notice error" }, ["⚠️", h("span", {}, [errorMsg])])
    : "";

  signIn.addEventListener("click", async () => {
    show(
      brand(),
      h("h1", {}, [t("cloudflare.waitingTitle")]),
      h("p", { class: "lede" }, [t("cloudflare.waitingLede")]),
      h("div", { class: "checklist" }, [
        h("li", { class: "running" }, [
          h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
          t("cloudflare.watchingSignIn"),
        ]),
      ]),
    );
    try {
      accounts = await invoke<Account[]>("connect_cloudflare");
      if (accounts.length === 1) {
        chosenAccount = accounts[0];
        progressScreen();
      } else {
        accountPickerScreen();
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
    h("p", { class: "footnote" }, [t("cloudflare.footnote")]),
  );
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
  const list = h("ul", { class: "account-list" });
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
    ? h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [t("common.back")])
    : "";
  if (back && backBtn instanceof HTMLElement) backBtn.addEventListener("click", back);

  show(
    brand(),
    h("h1", {}, [title]),
    h("p", { class: "lede" }, [lede]),
    list,
    backBtn,
  );
}

function progressSteps(): { id: StepId; label: string }[] {
  return [
    { id: "space", label: t("progress.stepSpace") },
    { id: "memory", label: t("progress.stepMemory") },
    { id: "recall", label: t("progress.stepRecall") },
    { id: "finish", label: t("progress.stepFinish") },
  ];
}

function progressScreen() {
  currentScreen = progressScreen;
  const rows = new Map<StepId, HTMLLIElement>();
  const list = h("ul", { class: "checklist" });
  for (const step of progressSteps()) {
    const li = h("li", {}, [h("span", { class: "check-icon" }, ["•"]), step.label]);
    rows.set(step.id, li);
    list.append(li);
  }
  const errorBox = h("div", {});
  show(
    brand(),
    h("h1", {}, [t("progress.title")]),
    h("p", { class: "lede" }, [t("progress.lede")]),
    h("div", { class: "card" }, [list]),
    errorBox,
  );

  const applyEvent = (ev: StepEvent) => {
    const li = rows.get(ev.step);
    if (!li) return;
    li.className = ev.status;
    const icon = li.querySelector<HTMLSpanElement>(".check-icon")!;
    if (ev.status === "running") icon.replaceChildren(h("span", { class: "spinner" }));
    if (ev.status === "done") icon.replaceChildren("✓");
    if (ev.status === "error") icon.replaceChildren("!");
  };

  let unlisten: (() => void) | null = null;
  const start = async () => {
    for (const li of rows.values()) {
      li.className = "";
      li.querySelector(".check-icon")!.replaceChildren("•");
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
      const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
      retry.addEventListener("click", () => void start());
      errorBox.replaceChildren(
        h("div", { class: "notice error" }, ["⚠️", h("span", {}, [String(e)])]),
        retry,
      );
    }
  };
  void start();
}

async function toolsScreen() {
  currentScreen = () => void toolsScreen();
  const tools = await invoke<ToolStatus>("detect_tools");
  const next = h("button", { class: "btn-primary" }, [t("common.continue")]);
  next.addEventListener("click", detailsScreen);
  show(
    brand(),
    h("h1", {}, [t("tools.title")]),
    h("p", { class: "lede" }, [t("tools.lede")]),
    toolRows(details!, tools),
    next,
  );
}

function detailsScreen() {
  currentScreen = detailsScreen;
  const done = h("button", { class: "btn-primary" }, [t("details.openDashboard")]);
  done.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, [t("details.allSetTitle")]),
    h("p", { class: "lede" }, [t(teamMode ? "details.allSetTeamLede" : "details.allSetLede")]),
    // Before the URL cards: it is the one thing a team owner is expected to do
    // next, and the links below it are for keeping, not acting on.
    ...(teamMode ? [teamCard()] : []),
    ...detailCards(details!),
    h("div", { class: "actions-spread" }, [copyBothButton(details!), emailButton(details!)]),
    h("div", { style: "height:14px" }),
    done,
  );
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
  const info = await invoke<WorkerUpdateInfo | null>("worker_update_available").catch(() => null);
  const versionLine = info
    ? t("workerUpdate.ledeWithVersion", { version: info.availableVersion })
    : t("workerUpdate.ledeGeneric");
  const start = h("button", { class: "btn-primary" }, [t("workerUpdate.signInUpdate")]);
  start.addEventListener("click", () => void runWorkerUpdate());
  const notNow = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("common.notNow"),
  ]);
  notNow.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, [t("workerUpdate.title")]),
    h("p", { class: "lede" }, [versionLine]),
    h("div", { class: "notice" }, ["🔒", h("span", {}, [t("workerUpdate.notice")])]),
    start,
    notNow,
  );
}

async function runWorkerUpdate(errorMsg?: string) {
  currentScreen = () => void runWorkerUpdate(errorMsg);
  if (errorMsg) {
    const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
    retry.addEventListener("click", () => void runWorkerUpdate());
    const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
      t("common.notNow"),
    ]);
    back.addEventListener("click", () => void invoke("open_dashboard"));
    show(
      brand(),
      h("h1", {}, [t("workerUpdate.title")]),
      h("div", { class: "notice error" }, ["⚠️", h("span", {}, [errorMsg])]),
      retry,
      back,
    );
    return;
  }

  show(
    brand(),
    h("h1", {}, [t("cloudflare.waitingTitle")]),
    h("p", { class: "lede" }, [t("workerUpdate.waitingLede")]),
    h("div", { class: "checklist" }, [
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
  const list = h("ul", { class: "checklist" });
  for (const step of updateProgressSteps()) {
    const li = h("li", {}, [h("span", { class: "check-icon" }, ["•"]), step.label]);
    rows.set(step.id, li);
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
    const icon = li.querySelector<HTMLSpanElement>(".check-icon")!;
    if (e.payload.status === "running") icon.replaceChildren(h("span", { class: "spinner" }));
    if (e.payload.status === "done") icon.replaceChildren("✓");
    if (e.payload.status === "error") icon.replaceChildren("!");
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
      const go = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [label]);
      go.addEventListener("click", () => render(true));
      host.replaceChildren(go);
      return;
    }
    const confirm = h("button", { class: "btn-danger" }, [t("changePassword.leaveConfirm")]);
    confirm.addEventListener("click", leave);
    const stay = h("button", { class: "btn-ghost" }, [t("changePassword.leaveKeep")]);
    stay.addEventListener("click", () => render(false));
    host.replaceChildren(
      h("div", { class: "notice" }, ["🔑", h("span", {}, [t("changePassword.leaveWarn")])]),
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
    h("div", { class: "checklist" }, [
      h("li", { class: "running" }, [
        h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
        t("cloudflare.watchingSignIn"),
      ]),
    ]),
  );
}

async function rotationSignIn(onError: (msg: string) => void, next: () => void) {
  currentScreen = () => cloudflareWaitingScreen(t("changePassword.waitingLede"));
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
  const notNow = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("common.notNow"),
  ]);
  notNow.addEventListener("click", () => void invoke("open_dashboard"));

  show(
    brand(),
    h("h1", {}, [t("changePassword.title")]),
    h("p", { class: "lede" }, [t("changePassword.lede")]),
    h("div", { class: "notice" }, ["🔑", h("span", {}, [t("changePassword.notice")])]),
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

  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
    h("div", { class: "notice" }, ["🔑", h("span", {}, [t("changePassword.lostNotice")])]),
    errorMsg ? notice(errorMsg) : "",
    primary,
    back,
    // What granting Cloudflare access means, unchanged: nothing about changing
    // a password alters that bargain.
    signedIn ? "" : h("p", { class: "footnote" }, [t("connectExisting.signInFootnote")]),
  );
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
  const list = h("ul", { class: "account-list" });
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
  const manual = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("connectExisting.manualButton"),
  ]);
  manual.addEventListener("click", () => lostAddressScreen(found, undefined, true));

  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
  const address = h("input", {
    type: "text",
    placeholder: t("connectExisting.addressPlaceholder"),
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

  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
  const pw = h("input", { type: "text", placeholder: t("password.placeholder") });
  const confirm = h("input", { type: "text", placeholder: t("password.confirmPlaceholder") });
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
  generate.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M11 2 C11.7 6.8 13.2 8.3 18 9 C13.2 9.7 11.7 11.2 11 16 C10.3 11.2 8.8 9.7 4 9 C8.8 8.3 10.3 6.8 11 2 Z"/>' +
    '<path d="M18 13 C18.35 15.4 19.1 16.15 21.5 16.5 C19.1 16.85 18.35 17.6 18 20 C17.65 17.6 16.9 16.85 14.5 16.5 C16.9 16.15 17.65 15.4 18 13 Z"/>' +
    "</svg>";
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

  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
    h("div", { class: "notice" }, ["🔑", h("span", {}, [t("changePassword.pickNotice")])]),
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
  // btn-danger is a small pill everywhere else in the app; here it is the
  // screen's primary, so it borrows the setup buttons' metrics. Its label is
  // itself the acknowledgement, matching the one other place in the app where
  // that is true (freeing the old search index).
  const confirm = h(
    "button",
    { class: "btn-primary btn-danger", style: "padding:15px;font-size:15px" },
    [t("changePassword.saveConfirm")],
  );
  confirm.addEventListener("click", () => void runRotation());
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
  const list = h("ul", { class: "checklist" });
  for (const step of rotationSteps()) {
    const status = rotationStepStatus.get(step.id);
    const icon =
      status === "running"
        ? h("span", { class: "spinner" })
        : status === "done"
          ? "✓"
          : status === "error"
            ? "!"
            : "•";
    list.append(
      h("li", status ? { class: status } : {}, [
        h("span", { class: "check-icon" }, [icon]),
        step.label,
      ]),
    );
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
  const copy = blockedCopy(rotationMayBeLive);
  const settings = h("button", { class: "btn-primary" }, [t("changePassword.blockedButton")]);
  settings.addEventListener("click", () => void invoke("open_settings_window"));
  // Leaving is a click when nothing was sent and the old password still works,
  // and a decision when this window holds the only copy of one that may already
  // be live — the same acknowledgement the other may-be-live screen asks for.
  const leave = copy.guardLeaving
    ? guardedExit(t("changePassword.failUnsureLeave"), leaveRotation)
    : (() => {
        const go = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
}

function failDetailLine(detail: string): HTMLElement | string {
  return detail ? h("p", { class: "footnote" }, [t("changePassword.failDetail", { detail })]) : "";
}

/// Nothing reached the brain, so the old password still works. This is the one
/// screen in the feature where the word "failed" belongs, and the password is
/// labelled by what it actually is here: chosen, and not in use.
function rotateFailNotSentScreen(detail: string) {
  currentScreen = () => rotateFailNotSentScreen(detail);
  const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
  retry.addEventListener("click", () => void runRotation());
  const leave = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
}

/// The change went out and never confirmed. Never says "failed": the heading is
/// a statement about the password, which is the only fact the app has. Retry is
/// the escape and the copy says why — setting the same password twice confirms
/// what landed or completes what did not.
function rotateFailUnsureScreen(detail: string, recheck?: RecheckResult) {
  currentScreen = () => rotateFailUnsureScreen(detail, recheck);
  const retry = h("button", { class: "btn-primary" }, [t("common.tryAgain")]);
  retry.addEventListener("click", () => void runRotation());

  // Read-only: a /health probe with the new password, no write. It is safe to
  // offer on the one screen where the user does not know what happened.
  const check = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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

  show(
    brand(),
    h("h1", {}, [t("changePassword.failUnsureTitle")]),
    notice(t("changePassword.failUnsureBody")),
    secretCard(t("changePassword.passwordLabel"), rotationPassword),
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
}

/// The brain has the new password; something local did not get it. No "try
/// again" — the change is done, and re-running the flow to fix a keychain write
/// would change the password a second time.
function rotateFailLocalScreen(outcome: RotateOutcome | null, detail = "") {
  currentScreen = () => rotateFailLocalScreen(outcome, detail);
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
}

/// Read correctly by two people: someone doing routine hygiene, who is
/// finished, and someone who has just had a leak, who is not. What will ask for
/// the new password comes first because it is true for everyone; the OAuth
/// explanation is context, and the leak sentence is a condition rather than a
/// warning, so a hygiene user dismisses it in one beat.
function rotateDoneScreen(revealed = false) {
  currentScreen = () => rotateDoneScreen(revealed);
  // Four items, not three. A change writes to secure storage, the brain
  // command's config and the open dashboard window — so the extension and the
  // Obsidian plugin hold the old password on *this* computer too, which is what
  // Door B's notice has always told people and this list used to deny.
  const needs = h("ul", { class: "url-desc", style: "padding-left:18px" }, [
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

  const reveal = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
      h("div", { class: "notice" }, ["🔑", h("span", {}, [t("changePassword.doneLeak")])]),
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
  const stored = await invoke<ConnectionDetails>("get_connection_details").catch(() => null);
  if (!stored) {
    // Nothing stored to be stale about; the ordinary connect path applies.
    connectExistingScreen();
    return;
  }

  const password = h("input", {
    type: "password",
    placeholder: t("connectExisting.passwordPlaceholder"),
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

  const findAgain = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    t("passwordChangedElsewhere.findAgain"),
  ]);
  findAgain.addEventListener("click", () => void discoverScreen());

  const lost = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
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
  password.focus();
}

function applyWindowTitle() {
  document.title = t("common.appTitle");
  void getCurrentWindow().setTitle(t("common.appTitle"));
}

async function boot() {
  initI18n();
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
