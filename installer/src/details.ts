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

  // One pane at a time, chosen from a rail. Everything used to be stacked in a
  // single column, so most of it was below the fold and the only way to find
  // anything was to scroll and read. Each pane now answers one question.
  type SectionId = "connection" | "tools" | "integrations" | "computer";
  let active: SectionId = "connection";

  const paneFor = (id: SectionId): HTMLElement[] => {
    if (id === "connection") {
      // No "open the dashboard" button here on purpose: this window is reached
      // from the dashboard, which stays open behind it, so the button only sent
      // this window to the back. The menu bar still has one for the case where
      // no dashboard window is open.
      return [
        h("h2", { class: "pane-title" }, [t("details.navConnection")]),
        h("p", { class: "pane-desc" }, [t("details.lede")]),
        ...detailCards(details),
        h("div", { class: "actions-spread" }, [copyBothButton(details), emailButton(details)]),
      ];
    }
    if (id === "tools") {
      return [
        h("h2", { class: "pane-title" }, [t("details.connectToolsTitle")]),
        h("p", { class: "pane-desc" }, [t("details.connectToolsDesc")]),
        toolRows(details, tools),
      ];
    }
    if (id === "integrations") {
      return [
        h("h2", { class: "pane-title" }, [t("details.integrationsTitle")]),
        h("p", { class: "pane-desc" }, [t("details.integrationsDesc")]),
        integrationRows(details),
      ];
    }
    return [
      h("h2", { class: "pane-title" }, [t("details.navComputer")]),
      ...(update ? [updateCard(update.availableVersion)] : []),
      settingsSection(() => render()),
      logoutSection(),
    ];
  };

  const render = () => {
    document.title = t("details.title");
    void getCurrentWindow().setTitle(t("details.title"));

    const rail = h("nav", { class: "rail" });
    const sections: { id: SectionId; label: string }[] = [
      { id: "connection", label: t("details.navConnection") },
      { id: "tools", label: t("details.navTools") },
      { id: "integrations", label: t("details.navIntegrations") },
      { id: "computer", label: t("details.navComputer") },
    ];
    for (const section of sections) {
      const button = h(
        "button",
        { class: section.id === active ? "rail-btn on" : "rail-btn" },
        [section.label],
      );
      button.addEventListener("click", () => {
        active = section.id;
        render();
      });
      rail.append(button);
    }

    app.replaceChildren(
      h("div", { class: "panel" }, [rail, h("section", { class: "pane" }, paneFor(active))]),
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
