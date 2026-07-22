// The "Connection details" window — where the URLs live forever after setup.
// Opened from the app menu or tray. Also lets the user connect a new tool
// later without re-running setup.
import { invoke } from "@tauri-apps/api/core";
import {
  ConnectionDetails,
  ToolStatus,
  copyBothButton,
  detailCards,
  emailButton,
  h,
} from "./shared";
import { integrationRows, toolRows } from "./shared";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function boot() {
  let details: ConnectionDetails;
  try {
    details = await invoke<ConnectionDetails>("get_connection_details");
  } catch {
    app.replaceChildren(
      h("div", { class: "screen" }, [
        h("h1", {}, ["Not set up yet"]),
        h("p", { class: "lede" }, [
          "Finish setting up your Second Brain first — these details appear here afterwards.",
        ]),
      ]),
    );
    return;
  }
  const tools = await invoke<ToolStatus>("detect_tools");
  const update = await invoke<{ availableVersion: string } | null>(
    "worker_update_available",
  ).catch(() => null);

  app.replaceChildren(
    h("div", { class: "screen" }, [
      h("h1", {}, ["Connection details"]),
      h("p", { class: "lede" }, ["Everything you need to connect a tool or another computer."]),
      ...(update ? [updateCard(update.availableVersion)] : []),
      ...detailCards(details),
      h("div", { class: "actions-spread" }, [copyBothButton(details), emailButton(details)]),
      h("div", { style: "height:18px" }),
      h("div", { class: "url-label" }, ["Connect your AI tools"]),
      h("div", { class: "url-desc" }, [
        "Tools on this computer connect with one click. For anything else, " +
          "paste your connection link into the tool's connector settings — " +
          "it will ask for your password the first time.",
      ]),
      toolRows(details, tools),
      h("div", { style: "height:18px" }),
      h("div", { class: "url-label" }, ["Integrations"]),
      h("div", { class: "url-desc" }, [
        "Bring in notes and pages from the tools you already use.",
      ]),
      integrationRows(details),
      logoutSection(),
    ]),
  );
}

function updateCard(availableVersion: string): HTMLElement {
  const button = h("button", { class: "btn-primary" }, ["Update my Second Brain"]);
  button.addEventListener("click", () => void invoke("begin_worker_update"));
  return h("div", { class: "card", style: "border-color: var(--accent);" }, [
    h("div", { class: "url-label" }, [`A newer Second Brain is available (${availableVersion})`]),
    h("div", { class: "url-desc" }, [
      "Update to get the latest improvements. Your memories, password, and connected tools are kept.",
    ]),
    button,
  ]);
}

function logoutSection(): HTMLElement {
  const container = h("div", { class: "logout-section" });
  const render = (confirming: boolean) => {
    if (!confirming) {
      const logout = h("button", { class: "btn-danger" }, ["Log out of this computer"]);
      logout.addEventListener("click", () => render(true));
      container.replaceChildren(logout);
      return;
    }
    const confirm = h("button", { class: "btn-danger" }, ["Yes, log out"]);
    confirm.addEventListener("click", () => void invoke("logout"));
    const keep = h("button", { class: "btn-ghost" }, ["Keep me signed in"]);
    keep.addEventListener("click", () => render(false));
    container.replaceChildren(
      h("div", { class: "url-desc" }, [
        "Your Second Brain and all its memories stay safe — this only forgets " +
          "the connection on this computer. You can reconnect anytime with " +
          "your address and password.",
      ]),
      h("div", { class: "row-actions" }, [confirm, keep]),
    );
  };
  render(false);
  return container;
}

void boot();
