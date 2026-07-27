// Helpers shared by the setup flow (main.ts) and the Connection details
// window (details.ts). The webview only ever handles URLs and booleans —
// tokens stay in the Rust core.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export interface ConnectionDetails {
  workerUrl: string;
  mcpUrl: string;
}

export interface ToolStatus {
  claudeCode: boolean;
  cursor: boolean;
}

export interface CliStatus {
  installed: boolean;
  npmAvailable: boolean;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  el.append(...children);
  return el;
}

export async function copyText(text: string, button?: HTMLButtonElement) {
  await invoke("copy_text", { text });
  if (button) {
    const original = button.textContent;
    button.textContent = t("common.copied");
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1400);
  }
}

/// A small status pill shown next to a row title. `on` renders it green.
export function badge(text: string, on = false): HTMLElement {
  return h("span", { class: on ? "badge on" : "badge" }, [text]);
}

export function urlCard(label: string, desc: string, value: string): HTMLElement {
  const copyBtn = h("button", { class: "btn-secondary" }, [t("common.copy")]);
  copyBtn.addEventListener("click", () => void copyText(value, copyBtn));
  return h("div", { class: "card url-card" }, [
    h("div", { class: "url-label" }, [label]),
    h("div", { class: "url-desc" }, [desc]),
    h("div", { class: "url-line" }, [h("div", { class: "url-value" }, [value]), copyBtn]),
  ]);
}

/// The two URL cards used on the final setup screen AND in Connection details.
export function detailCards(details: ConnectionDetails): HTMLElement[] {
  return [
    urlCard(t("details.addressLabel"), t("details.addressDesc"), details.workerUrl),
    urlCard(t("details.mcpLabel"), t("details.mcpDesc"), details.mcpUrl),
  ];
}

export function copyBothButton(details: ConnectionDetails): HTMLButtonElement {
  const btn = h("button", { class: "btn-ghost" }, [t("common.copyBoth")]);
  btn.addEventListener("click", () =>
    void copyText(
      `${t("details.addressLabel")}: ${details.workerUrl}\n${t("details.mcpLabel")}: ${details.mcpUrl}`,
      btn,
    ),
  );
  return btn;
}

export function emailButton(details: ConnectionDetails): HTMLButtonElement {
  const btn = h("button", { class: "btn-ghost" }, [t("common.emailDetails")]);
  btn.addEventListener("click", () => {
    const subject = encodeURIComponent(t("email.subject"));
    const body = encodeURIComponent(
      `${t("email.bodyAddress")}\n${details.workerUrl}\n\n${t("email.bodyMcp")}\n${details.mcpUrl}\n`,
    );
    void invoke("open_external", { url: `mailto:?subject=${subject}&body=${body}` });
  });
  return btn;
}

/// One-click connect rows for screen 5 and the details window.
export function toolRows(details: ConnectionDetails, tools: ToolStatus): HTMLElement {
  const container = h("div", { class: "card" });

  const localTool = (title: string, id: string, installed: boolean) => {
    const sub = h("div", { class: "row-sub" }, [
      installed ? t("tools.autoSetup") : t("tools.notOnComputer"),
    ]);
    const actions = h("div", { class: "row-actions" });
    if (installed) {
      const btn = h("button", { class: "btn-secondary" }, [t("common.connect")]);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = t("common.connecting");
        try {
          await invoke("connect_tool", { tool: id });
          btn.textContent = t("common.connected");
          sub.textContent = t("tools.doneRestart");
        } catch (e) {
          btn.textContent = t("common.connect");
          btn.disabled = false;
          sub.textContent = String(e);
        }
      });
      actions.append(btn);
    } else {
      const copy = h("button", { class: "btn-ghost" }, [t("common.copyLink")]);
      copy.addEventListener("click", () => void copyText(details.mcpUrl, copy));
      actions.append(copy);
    }
    return h("div", { class: "row" }, [
      h("div", {}, [
        h("div", { class: "row-title" }, [
          title,
          badge(installed ? t("common.ready") : t("common.notFound"), installed),
        ]),
        sub,
      ]),
      actions,
    ]);
  };

  const cliRow = () => {
    const sub = h("div", { class: "row-sub" }, [t("tools.cliSub")]);
    const actions = h("div", { class: "row-actions" });
    const setupBtn = h("button", { class: "btn-secondary" }, [t("tools.setupCli")]);
    actions.append(setupBtn);

    void (async () => {
      let status: CliStatus;
      try {
        status = await invoke<CliStatus>("detect_cli");
      } catch {
        status = { installed: false, npmAvailable: false };
      }

      setupBtn.addEventListener("click", async () => {
        setupBtn.disabled = true;
        setupBtn.textContent = t("tools.settingUp");
        try {
          await invoke("connect_cli");
        } catch (e) {
          setupBtn.disabled = false;
          setupBtn.textContent = t("tools.setupCli");
          sub.textContent = String(e);
          return;
        }

        if (status.installed) {
          setupBtn.textContent = t("common.connected");
          sub.textContent = t("tools.cliDone");
          return;
        }

        if (status.npmAvailable) {
          setupBtn.textContent = t("tools.installing");
          try {
            await invoke("install_cli");
            setupBtn.textContent = t("tools.installed");
            sub.textContent = t("tools.reopenTerminal");
          } catch {
            setupBtn.textContent = t("tools.configSaved");
            sub.replaceChildren(
              t("tools.configSavedInstallFailed"),
              h("code", {}, ["npm i -g second-brain-cli"]),
            );
          }
          return;
        }

        setupBtn.textContent = t("tools.configSaved");
        sub.replaceChildren(
          t("tools.configSavedNoNpm"),
          h("code", {}, ["npm i -g second-brain-cli"]),
        );
        const copy = h("button", { class: "btn-ghost" }, [t("common.copyCommand")]);
        copy.addEventListener("click", () => void copyText("npm i -g second-brain-cli", copy));
        actions.replaceChildren(copy);
      });
    })();

    return h("div", { class: "row" }, [
      h("div", {}, [h("div", { class: "row-title" }, [t("tools.cliTitle")]), sub]),
      actions,
    ]);
  };

  const webTool = (title: string, settingsUrl: string) => {
    const copy = h("button", { class: "btn-secondary" }, [t("common.copyLink")]);
    copy.addEventListener("click", () => void copyText(details.mcpUrl, copy));
    const open = h("button", { class: "btn-ghost" }, [t("common.openSettings")]);
    open.addEventListener("click", () => void invoke("open_external", { url: settingsUrl }));
    return h("div", { class: "row" }, [
      h("div", {}, [
        h("div", { class: "row-title" }, [title]),
        h("div", { class: "row-sub" }, [t("tools.pasteInSettings")]),
      ]),
      h("div", { class: "row-actions" }, [copy, open]),
    ]);
  };

  container.append(
    localTool(t("tools.claudeCode"), "claude-code", tools.claudeCode),
    localTool(t("tools.cursor"), "cursor", tools.cursor),
    cliRow(),
    webTool(t("tools.chatgpt"), "https://chatgpt.com/#settings/Connectors"),
    webTool(t("tools.claudeWeb"), "https://claude.ai/settings/connectors"),
  );
  return container;
}

interface IntegrationStatus {
  provider: string;
  name: string;
  connected: boolean;
  workspaceName: string | null;
}

export function integrationRows(details: ConnectionDetails): HTMLElement {
  const container = h("div", { class: "card" });

  const extGet = h("button", { class: "btn-secondary" }, [t("integrations.getExtension")]);
  extGet.addEventListener("click", () =>
    void invoke("open_external", {
      url: "https://github.com/rahilp/second-brain-browser-extension",
    }),
  );
  const extCopy = h("button", { class: "btn-ghost" }, [t("common.copyAddress")]);
  extCopy.addEventListener("click", () => void copyText(details.workerUrl, extCopy));
  const extension = h("div", { class: "row" }, [
    h("div", {}, [
      h("div", { class: "row-title" }, [t("integrations.extensionTitle")]),
      h("div", { class: "row-sub" }, [t("integrations.extensionSub")]),
    ]),
    h("div", { class: "row-actions" }, [extGet, extCopy]),
  ]);

  const obsidianActions = h("div", { class: "row-actions" });
  const obsidian = h("div", { class: "row" }, [
    h("div", {}, [
      h("div", { class: "row-title" }, [t("integrations.obsidianTitle")]),
      h("div", { class: "row-sub" }, [t("integrations.obsidianSub")]),
    ]),
    obsidianActions,
  ]);
  void (async () => {
    const installed = await invoke<boolean>("detect_obsidian").catch(() => false);
    const open = h("button", { class: "btn-secondary" }, [
      installed ? t("integrations.openObsidian") : t("integrations.getPlugin"),
    ]);
    open.addEventListener("click", () =>
      void invoke("open_external", {
        url: installed
          ? "obsidian://show-plugin?id=second-brain-sync"
          : "https://community.obsidian.md/plugins/second-brain-sync",
      }),
    );
    const copy = h("button", { class: "btn-ghost" }, [t("common.copyAddress")]);
    copy.addEventListener("click", () => void copyText(details.workerUrl, copy));
    obsidianActions.append(open, copy);
  })();

  const notionSub = h("div", { class: "row-sub" }, [t("integrations.notionSub")]);
  const notionActions = h("div", { class: "row-actions" });
  const notionTitle = h("div", { class: "row-title" }, [t("integrations.notionTitle")]);
  const notion = h("div", { class: "row" }, [
    h("div", {}, [notionTitle, notionSub]),
    notionActions,
  ]);
  void (async () => {
    let connected = false;
    let workspace: string | null = null;
    try {
      const list = await invoke<IntegrationStatus[]>("integration_status");
      const n = list.find((i) => i.provider === "notion");
      connected = !!n?.connected;
      workspace = n?.workspaceName ?? null;
    } catch {
      /* offline */
    }

    if (connected) {
      notionTitle.append(badge(t("common.connected"), true));
      notionSub.textContent = workspace
        ? t("integrations.notionConnectedTo", { workspace })
        : t("integrations.notionConnected");
      const sync = h("button", { class: "btn-secondary" }, [t("integrations.syncNow")]);
      sync.addEventListener("click", async () => {
        sync.disabled = true;
        sync.textContent = t("integrations.syncing");
        try {
          notionSub.textContent = await invoke<string>("sync_notion");
        } catch (e) {
          notionSub.textContent = String(e);
        } finally {
          sync.disabled = false;
          sync.textContent = t("integrations.syncNow");
        }
      });
      const manage = h("button", { class: "btn-ghost" }, [t("integrations.manage")]);
      manage.addEventListener("click", () => void invoke("open_dashboard_integrations"));
      notionActions.replaceChildren(sync, manage);
    } else {
      const setup = h("button", { class: "btn-secondary" }, [t("integrations.setupNotion")]);
      setup.addEventListener("click", () => void invoke("open_dashboard_integrations"));
      notionActions.replaceChildren(setup);
    }
  })();

  container.append(extension, obsidian, notion);
  return container;
}
