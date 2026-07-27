// The "Connection details" window — where the URLs live forever after setup.
// Opened from the app menu or tray. Also lets the user connect a new tool
// later without re-running setup.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ConnectionDetails,
  ToolStatus,
  copyBothButton,
  detailCards,
  emailButton,
  h,
} from "./shared";
import { integrationRows, toolRows } from "./shared";
import { initI18n, settingsSection, t } from "./i18n";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app")!;

async function boot() {
  initI18n();
  document.title = t("details.title");

  let details: ConnectionDetails;
  try {
    details = await invoke<ConnectionDetails>("get_connection_details");
  } catch {
    const renderNotSetup = () => {
      document.title = t("details.title");
      void getCurrentWindow().setTitle(t("details.title"));
      app.replaceChildren(
        h("div", { class: "screen" }, [
          settingsSection(() => renderNotSetup()),
          h("h1", {}, [t("details.notSetupTitle")]),
          h("p", { class: "lede" }, [t("details.notSetupLede")]),
        ]),
      );
    };
    renderNotSetup();
    return;
  }
  const tools = await invoke<ToolStatus>("detect_tools");
  const update = await invoke<{ availableVersion: string } | null>(
    "worker_update_available",
  ).catch(() => null);

  const render = () => {
    document.title = t("details.title");
    void getCurrentWindow().setTitle(t("details.title"));
    app.replaceChildren(
      h("div", { class: "screen" }, [
        h("h1", {}, [t("details.title")]),
        settingsSection(() => render()),
        h("p", { class: "lede" }, [t("details.lede")]),
        ...(update ? [updateCard(update.availableVersion)] : []),
        ...detailCards(details),
        h("div", { class: "actions-spread" }, [copyBothButton(details), emailButton(details)]),
        h("div", { style: "height:18px" }),
        h("div", { class: "url-label" }, [t("details.connectToolsTitle")]),
        h("div", { class: "url-desc" }, [t("details.connectToolsDesc")]),
        toolRows(details, tools),
        h("div", { style: "height:18px" }),
        h("div", { class: "url-label" }, [t("details.integrationsTitle")]),
        h("div", { class: "url-desc" }, [t("details.integrationsDesc")]),
        integrationRows(details),
        logoutSection(),
      ]),
    );
  };

  render();
}

function updateCard(availableVersion: string): HTMLElement {
  const button = h("button", { class: "btn-primary" }, [t("details.updateButton")]);
  button.addEventListener("click", () => void invoke("begin_worker_update"));
  return h("div", { class: "card", style: "border-color: var(--accent);" }, [
    h("div", { class: "url-label" }, [t("details.updateLabel", { version: availableVersion })]),
    h("div", { class: "url-desc" }, [t("details.updateDesc")]),
    button,
  ]);
}

function logoutSection(): HTMLElement {
  const container = h("div", { class: "logout-section" });
  const render = (confirming: boolean) => {
    if (!confirming) {
      const logout = h("button", { class: "btn-danger" }, [t("logout.button")]);
      logout.addEventListener("click", () => render(true));
      container.replaceChildren(logout);
      return;
    }
    const confirm = h("button", { class: "btn-danger" }, [t("logout.confirm")]);
    confirm.addEventListener("click", () => void invoke("logout"));
    const keep = h("button", { class: "btn-ghost" }, [t("logout.keep")]);
    keep.addEventListener("click", () => render(false));
    container.replaceChildren(
      h("div", { class: "url-desc" }, [t("logout.desc")]),
      h("div", { class: "row-actions" }, [confirm, keep]),
    );
  };
  render(false);
  return container;
}

void boot();
