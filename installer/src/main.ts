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
  toolRows,
} from "./shared";
import { initI18n, LOCALE_CHANGE_EVENT, t } from "./i18n";
import "./style.css";

interface Account {
  id: string;
  name: string;
}

type StepId = "space" | "memory" | "recall" | "finish";
interface StepEvent {
  step: StepId;
  status: "running" | "done" | "error";
}

const app = document.querySelector<HTMLDivElement>("#app")!;
let accounts: Account[] = [];
let chosenAccount: Account | null = null;
let details: ConnectionDetails | null = null;

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
  start.addEventListener("click", passwordScreen);
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

function connectExistingScreen(errorMsg?: string, prefillAddress?: string) {
  currentScreen = () => connectExistingScreen(errorMsg, prefillAddress);
  const address = h("input", {
    type: "text",
    placeholder: t("connectExisting.addressPlaceholder"),
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  if (prefillAddress) address.value = prefillAddress;
  const password = h("input", { type: "password", placeholder: t("connectExisting.passwordPlaceholder") });
  const error = errorMsg
    ? h("div", { class: "notice error" }, ["⚠️", h("span", {}, [errorMsg])])
    : "";
  const connect = h("button", { class: "btn-primary" }, [t("connectExisting.connect")]);
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [t("common.back")]);
  back.addEventListener("click", welcomeScreen);

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
      connectExistingScreen(String(e), address.value);
    }
  });

  show(
    brand(),
    h("h1", {}, [t("connectExisting.title")]),
    h("p", { class: "lede" }, [t("connectExisting.lede")]),
    error,
    h("div", { class: "field-stack" }, [address, password]),
    connect,
    back,
    h("p", { class: "footnote" }, [t("connectExisting.footnote")]),
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

function accountPickerScreen() {
  currentScreen = accountPickerScreen;
  const list = h("ul", { class: "account-list" });
  for (const account of accounts) {
    const btn = h("button", {}, [account.name]);
    btn.addEventListener("click", () => {
      chosenAccount = account;
      progressScreen();
    });
    list.append(h("li", {}, [btn]));
  }
  show(
    brand(),
    h("h1", {}, [t("cloudflare.pickerTitle")]),
    h("p", { class: "lede" }, [t("cloudflare.pickerLede")]),
    list,
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
    h("p", { class: "lede" }, [t("details.allSetLede")]),
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

async function boot() {
  initI18n();
  window.addEventListener(LOCALE_CHANGE_EVENT, () => {
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
  } catch {
    /* welcome */
  }
  welcomeScreen();
}

void boot();
