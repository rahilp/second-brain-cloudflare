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

function show(...nodes: (Node | string)[]) {
  app.replaceChildren(h("div", { class: "screen" }, nodes));
}

function brand(): HTMLElement {
  return h("div", { class: "brand" }, [h("img", { src: "/brain.png", alt: "" })]);
}

// ── Screen 1: Welcome ─────────────────────────────────────────────────────────

function welcomeScreen() {
  const start = h("button", { class: "btn-primary" }, ["Get started"]);
  start.addEventListener("click", passwordScreen);
  const existing = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    "Already have a Second Brain?",
  ]);
  existing.addEventListener("click", () => connectExistingScreen());
  show(
    brand(),
    h("h1", {}, ["Let's set up your Second Brain"]),
    h("p", { class: "lede" }, [
      "One private memory that every AI tool you use can share. " +
        "It takes about two minutes, lives in your own private space, " +
        "and nothing technical is required.",
    ]),
    start,
    existing,
    h("p", { class: "footnote" }, ["Free to run · Your data stays yours"]),
  );
}

// ── Connect an existing Second Brain (new computer / set up elsewhere) ────────

function connectExistingScreen(errorMsg?: string, prefillAddress?: string) {
  const address = h("input", {
    type: "text",
    placeholder: "Your Second Brain address (…workers.dev)",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
  });
  if (prefillAddress) address.value = prefillAddress;
  const password = h("input", { type: "password", placeholder: "Your password" });
  const error = errorMsg
    ? h("div", { class: "notice error" }, ["⚠️", h("span", {}, [errorMsg])])
    : "";
  const connect = h("button", { class: "btn-primary" }, ["Connect"]);
  const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    "Back",
  ]);
  back.addEventListener("click", welcomeScreen);

  connect.addEventListener("click", async () => {
    connect.disabled = true;
    connect.textContent = "Checking…";
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
    h("h1", {}, ["Connect your Second Brain"]),
    h("p", { class: "lede" }, [
      "Setting up a new computer? Enter the address and password of the " +
        "Second Brain you already have — nothing will be changed or reset.",
    ]),
    error,
    h("div", { class: "field-stack" }, [address, password]),
    connect,
    back,
    h("p", { class: "footnote" }, [
      "The address is in Connection details on your other computer, " +
        "or in the confirmation email you sent yourself.",
    ]),
  );
  address.focus();
}

// ── Screen 2: Password ────────────────────────────────────────────────────────

interface PasswordCheck {
  breached: boolean;
  count: number;
  score: number; // zxcvbn 0 (guessable) ..= 4 (strong)
  online: boolean;
}

/** Meter position + label for a checked password. Breached always wins. */
function meterFor(pw: string, check: PasswordCheck | null): {
  pct: number;
  label: string;
  color: string;
} {
  if (pw.length === 0) return { pct: 0, label: "", color: "var(--danger)" };
  if (pw.trim().length < 12)
    return { pct: 20, label: "Too short", color: "var(--danger)" };
  if (check === null) return { pct: 45, label: "Checking…", color: "var(--accent)" };
  if (check.breached)
    return { pct: 30, label: "Found in breaches", color: "var(--danger)" };
  if (check.score >= 4) return { pct: 100, label: "Strong", color: "var(--ok)" };
  if (check.score === 3) return { pct: 70, label: "Good", color: "var(--ok)" };
  return { pct: 45, label: "Easy to guess", color: "var(--accent)" };
}

function passwordScreen() {
  const pw = h("input", { type: "password", placeholder: "Choose a password (12+ characters)" });
  const confirm = h("input", { type: "password", placeholder: "Type it again" });
  const fill = h("div", { class: "strength-fill" });
  const label = h("span", { class: "strength-label" });
  const hint = h("p", { class: "hint" }, [""]);
  const generate = h("button", {
    class: "input-action",
    title: "Generate a strong password for me",
    "aria-label": "Generate a strong password for me",
  });
  // Flat sparkle mark, drawn inline so it picks up the accent color.
  generate.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M11 2 C11.7 6.8 13.2 8.3 18 9 C13.2 9.7 11.7 11.2 11 16 C10.3 11.2 8.8 9.7 4 9 C8.8 8.3 10.3 6.8 11 2 Z"/>' +
    '<path d="M18 13 C18.35 15.4 19.1 16.15 21.5 16.5 C19.1 16.85 18.35 17.6 18 20 C17.65 17.6 16.9 16.85 14.5 16.5 C16.9 16.15 17.65 15.4 18 13 Z"/>' +
    "</svg>";
  const next = h("button", { class: "btn-primary", disabled: "" }, ["Continue"]);

  // Latest completed check for the current password value (null = pending).
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
      hint.textContent =
        "This password has appeared in data breaches, so it isn't safe " +
        "to use here. Try another, or let us generate one.";
      hint.className = "hint error";
    } else if (pw.value && confirm.value && !match) {
      hint.textContent = "Those don't match yet.";
      hint.className = "hint error";
    } else {
      hint.textContent = "";
      hint.className = "hint";
    }
    // Blocked: too short, mismatch, known-breached, or check still pending.
    // Merely-weak is allowed — the meter warns but doesn't stop you.
    if (longEnough && match && check !== null && !breached) {
      next.removeAttribute("disabled");
    } else {
      next.setAttribute("disabled", "");
    }
  };

  const runCheck = () => {
    const value = pw.value.trim();
    if (value.length < 12) return; // nothing to check yet
    invoke<PasswordCheck>("check_password", { password: pw.value })
      .then((result) => {
        if (pw.value.trim() !== value) return; // stale — user kept typing
        check = result;
        render();
      })
      .catch(() => {
        // Treat a failed check like an offline one: don't block setup.
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
    // Show what they got — they need to save it somewhere.
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
    h("h1", {}, ["Create your password"]),
    h("p", { class: "lede" }, [
      "This is the key to your Second Brain. You'll use it to connect " +
        "new tools and to sign in from other computers.",
    ]),
    h("div", { class: "field-stack" }, [
      h("div", { class: "input-wrap" }, [pw, generate]),
      h("div", { class: "strength" }, [h("div", { class: "strength-track" }, [fill]), label]),
      confirm,
      hint,
    ]),
    h("div", { class: "notice" }, [
      "🔑",
      h("span", {}, [
        "Save this somewhere safe — a password manager is perfect. " +
          "You'll need it to connect new tools later, and it can't be recovered for you.",
      ]),
    ]),
    next,
    h("p", { class: "footnote" }, [
      "We check new passwords against known data breaches without ever " +
        "sending your password anywhere — only a fragment of a fingerprint " +
        "leaves this computer.",
    ]),
  );
  pw.focus();
}

// ── Screen 3: Connect Cloudflare ──────────────────────────────────────────────

function connectScreen(errorMsg?: string) {
  const signIn = h("button", { class: "btn-primary" }, ["Sign in to create your space"]);
  const error = errorMsg
    ? h("div", { class: "notice error" }, ["⚠️", h("span", {}, [errorMsg])])
    : "";

  signIn.addEventListener("click", async () => {
    show(
      brand(),
      h("h1", {}, ["Waiting for your browser…"]),
      h("p", { class: "lede" }, [
        "Finish signing in (or creating your free account) in the browser " +
          "window that just opened, then come back here.",
      ]),
      h("div", { class: "checklist" }, [
        h("li", { class: "running" }, [
          h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
          "Watching for you to finish signing in",
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
    h("h1", {}, ["Connect your account"]),
    h("p", { class: "lede" }, [
      "Your Second Brain lives in your own private space, powered by " +
        "Cloudflare — so your memories belong to you, not to us. " +
        "Sign in, or create a free account in the same window.",
    ]),
    error,
    signIn,
    h("p", { class: "footnote" }, ["We never see your Cloudflare password."]),
  );
}

function accountPickerScreen() {
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
    h("h1", {}, ["Which space should it live in?"]),
    h("p", { class: "lede" }, ["Your login has more than one — pick where your Second Brain goes."]),
    list,
  );
}

// ── Screen 4: Progress ────────────────────────────────────────────────────────

const STEPS: { id: StepId; label: string }[] = [
  { id: "space", label: "Creating your private space" },
  { id: "memory", label: "Building your memory store" },
  { id: "recall", label: "Turning on smart recall" },
  { id: "finish", label: "Finishing up" },
];

function progressScreen() {
  const rows = new Map<StepId, HTMLLIElement>();
  const list = h("ul", { class: "checklist" });
  for (const step of STEPS) {
    const li = h("li", {}, [h("span", { class: "check-icon" }, ["•"]), step.label]);
    rows.set(step.id, li);
    list.append(li);
  }
  const errorBox = h("div", {});
  show(
    brand(),
    h("h1", {}, ["Setting up your Second Brain"]),
    h("p", { class: "lede" }, ["This usually takes a minute or two. Feel free to stretch."]),
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
    // Reset rows for retries.
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
      const retry = h("button", { class: "btn-primary" }, ["Try again"]);
      retry.addEventListener("click", () => void start());
      errorBox.replaceChildren(
        h("div", { class: "notice error" }, ["⚠️", h("span", {}, [String(e)])]),
        retry,
      );
    }
  };
  void start();
}

// ── Screen 5: Connect your AI tools ───────────────────────────────────────────

async function toolsScreen() {
  const tools = await invoke<ToolStatus>("detect_tools");
  const next = h("button", { class: "btn-primary" }, ["Continue"]);
  next.addEventListener("click", detailsScreen);
  show(
    brand(),
    h("h1", {}, ["Connect your AI tools"]),
    h("p", { class: "lede" }, [
      "Give each tool access to the same shared memory. " +
        "You can always connect more later.",
    ]),
    toolRows(details!, tools),
    next,
  );
}

// ── Screen 6: Your Second Brain details ───────────────────────────────────────

function detailsScreen() {
  const done = h("button", { class: "btn-primary" }, ["Open my Second Brain"]);
  done.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, ["You're all set"]),
    h("p", { class: "lede" }, [
      "Two links to keep. You can always find them again in this app " +
        "under Connection details.",
    ]),
    ...detailCards(details!),
    h("div", { class: "actions-spread" }, [copyBothButton(details!), emailButton(details!)]),
    h("div", { style: "height:14px" }),
    done,
  );
}

// ── Worker update flow (main window in "worker-update" mode) ──────────────────

interface WorkerUpdateInfo {
  deployedVersion: string | null;
  availableVersion: string;
}

const UPDATE_STEPS: { id: StepId; label: string }[] = [
  { id: "memory", label: "Updating your memory store" },
  { id: "recall", label: "Refreshing smart recall" },
  { id: "finish", label: "Finishing up" },
];

async function workerUpdateScreen() {
  const info = await invoke<WorkerUpdateInfo | null>("worker_update_available").catch(() => null);
  const versionLine = info
    ? `A newer version of your Second Brain (version ${info.availableVersion}) is ready to install.`
    : "A newer version of your Second Brain is ready to install.";
  const start = h("button", { class: "btn-primary" }, ["Sign in and update"]);
  start.addEventListener("click", () => void runWorkerUpdate());
  const notNow = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
    "Not now",
  ]);
  notNow.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, ["Update your Second Brain"]),
    h("p", { class: "lede" }, [
      versionLine +
        " Your memories, password, and connected tools are all kept — nothing is reset.",
    ]),
    h("div", { class: "notice" }, [
      "🔒",
      h("span", {}, [
        "You'll sign in to Cloudflare once to authorize the update. It takes about a minute.",
      ]),
    ]),
    start,
    notNow,
  );
}

async function runWorkerUpdate(errorMsg?: string) {
  if (errorMsg) {
    const retry = h("button", { class: "btn-primary" }, ["Try again"]);
    retry.addEventListener("click", () => void runWorkerUpdate());
    const back = h("button", { class: "btn-ghost", style: "width:100%;margin-top:8px" }, [
      "Not now",
    ]);
    back.addEventListener("click", () => void invoke("open_dashboard"));
    show(
      brand(),
      h("h1", {}, ["Update your Second Brain"]),
      h("div", { class: "notice error" }, ["⚠️", h("span", {}, [errorMsg])]),
      retry,
      back,
    );
    return;
  }

  // Sign in to Cloudflare (the app doesn't keep that login after setup).
  show(
    brand(),
    h("h1", {}, ["Waiting for your browser…"]),
    h("p", { class: "lede" }, [
      "Finish signing in to Cloudflare in the browser window that just opened, then come back here.",
    ]),
    h("div", { class: "checklist" }, [
      h("li", { class: "running" }, [
        h("span", { class: "check-icon" }, [h("span", { class: "spinner" })]),
        "Watching for you to finish signing in",
      ]),
    ]),
  );
  try {
    await invoke<Account[]>("connect_cloudflare");
  } catch (e) {
    return void runWorkerUpdate(String(e));
  }

  // Redeploy with a progress checklist.
  const rows = new Map<StepId, HTMLLIElement>();
  const list = h("ul", { class: "checklist" });
  for (const step of UPDATE_STEPS) {
    const li = h("li", {}, [h("span", { class: "check-icon" }, ["•"]), step.label]);
    rows.set(step.id, li);
    list.append(li);
  }
  show(
    brand(),
    h("h1", {}, ["Updating your Second Brain"]),
    h("p", { class: "lede" }, ["This usually takes a minute. Your memories are safe."]),
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
  const done = h("button", { class: "btn-primary" }, ["Open my Second Brain"]);
  done.addEventListener("click", () => void invoke("open_dashboard"));
  show(
    brand(),
    h("h1", {}, ["Your Second Brain is up to date"]),
    h("p", { class: "lede" }, [
      "Everything's on the latest version — your memories, password, and connected tools are unchanged.",
    ]),
    done,
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const state = await invoke<{ mode: string; dryRun: boolean }>("get_app_state");
    if (state.dryRun) {
      document.body.append(h("div", { class: "dry-run-badge" }, ["Demo mode"]));
    }
    if (state.mode === "worker-update") {
      void workerUpdateScreen();
      return;
    }
  } catch {
    // If state can't be read the safe default is the welcome screen —
    // never leave the window blank.
  }
  welcomeScreen();
}

void boot();
