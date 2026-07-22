// Helpers shared by the setup flow (main.ts) and the Connection details
// window (details.ts). The webview only ever handles URLs and booleans —
// tokens stay in the Rust core.
import { invoke } from "@tauri-apps/api/core";

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
    button.textContent = "Copied ✓";
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1400);
  }
}

export function urlCard(label: string, desc: string, value: string): HTMLElement {
  const copyBtn = h("button", { class: "btn-secondary" }, ["Copy"]);
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
    urlCard(
      "Your Second Brain address",
      "Your private web dashboard, and where you connect new tools. Save it somewhere safe.",
      details.workerUrl,
    ),
    urlCard(
      "Your connection link (for AI tools)",
      "Paste this into any AI tool that supports connectors.",
      details.mcpUrl,
    ),
  ];
}

export function copyBothButton(details: ConnectionDetails): HTMLButtonElement {
  const btn = h("button", { class: "btn-ghost" }, ["Copy both"]);
  btn.addEventListener("click", () =>
    void copyText(
      `Your Second Brain address: ${details.workerUrl}\nYour connection link (for AI tools): ${details.mcpUrl}`,
      btn,
    ),
  );
  return btn;
}

export function emailButton(details: ConnectionDetails): HTMLButtonElement {
  const btn = h("button", { class: "btn-ghost" }, ["Email these to myself"]);
  btn.addEventListener("click", () => {
    const subject = encodeURIComponent("Your Second Brain details");
    const body = encodeURIComponent(
      `Your Second Brain address (your private dashboard):\n${details.workerUrl}\n\n` +
        `Your connection link (paste into AI tools that support connectors):\n${details.mcpUrl}\n`,
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
      installed ? "Sets it up for you automatically." : "Not found on this computer.",
    ]);
    const actions = h("div", { class: "row-actions" });
    if (installed) {
      const btn = h("button", { class: "btn-secondary" }, ["Connect"]);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Connecting…";
        try {
          await invoke("connect_tool", { tool: id });
          btn.textContent = "Connected ✓";
          sub.textContent = "Done — restart the tool to start using your Second Brain.";
        } catch (e) {
          btn.textContent = "Connect";
          btn.disabled = false;
          sub.textContent = String(e);
        }
      });
      actions.append(btn);
    } else {
      const copy = h("button", { class: "btn-ghost" }, ["Copy link"]);
      copy.addEventListener("click", () => void copyText(details.mcpUrl, copy));
      actions.append(copy);
    }
    return h("div", { class: "row" }, [
      h("div", {}, [h("div", { class: "row-title" }, [title]), sub]),
      actions,
    ]);
  };

  // The CLI joins the one-click tier. Detection runs through the user's login
  // shell (async), so the row renders immediately and wires itself up once the
  // status arrives. "Set up CLI" always writes the config; the install path is
  // offered only when npm is present.
  const cliRow = () => {
    const sub = h("div", { class: "row-sub" }, ["Use your Second Brain from the terminal."]);
    const actions = h("div", { class: "row-actions" });
    const setupBtn = h("button", { class: "btn-secondary" }, ["Set up CLI"]);
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
        setupBtn.textContent = "Setting up…";
        try {
          await invoke("connect_cli");
        } catch (e) {
          setupBtn.disabled = false;
          setupBtn.textContent = "Set up CLI";
          sub.textContent = String(e);
          return;
        }

        if (status.installed) {
          setupBtn.textContent = "Connected ✓";
          sub.textContent = "Done. The brain command is ready in your terminal.";
          return;
        }

        if (status.npmAvailable) {
          setupBtn.textContent = "Installing…";
          try {
            await invoke("install_cli");
            setupBtn.textContent = "Installed ✓";
            sub.textContent = "The brain command is ready. Reopen your terminal if it isn't found yet.";
          } catch {
            setupBtn.textContent = "Config saved";
            sub.replaceChildren(
              "Config saved, but the install didn't finish. Run it yourself: ",
              h("code", {}, ["npm i -g second-brain-cli"]),
            );
          }
          return;
        }

        // No npm on this computer — save the config and hand over the command.
        setupBtn.textContent = "Config saved ✓";
        sub.replaceChildren(
          "Config saved. Install Node.js, then run: ",
          h("code", {}, ["npm i -g second-brain-cli"]),
        );
        const copy = h("button", { class: "btn-ghost" }, ["Copy command"]);
        copy.addEventListener("click", () => void copyText("npm i -g second-brain-cli", copy));
        actions.replaceChildren(copy);
      });
    })();

    return h("div", { class: "row" }, [
      h("div", {}, [h("div", { class: "row-title" }, ["Second Brain CLI"]), sub]),
      actions,
    ]);
  };

  const webTool = (title: string, settingsUrl: string) => {
    const copy = h("button", { class: "btn-secondary" }, ["Copy link"]);
    copy.addEventListener("click", () => void copyText(details.mcpUrl, copy));
    const open = h("button", { class: "btn-ghost" }, ["Open settings"]);
    open.addEventListener("click", () => void invoke("open_external", { url: settingsUrl }));
    return h("div", { class: "row" }, [
      h("div", {}, [
        h("div", { class: "row-title" }, [title]),
        h("div", { class: "row-sub" }, ["Copy the link, then paste it under connectors in settings."]),
      ]),
      h("div", { class: "row-actions" }, [copy, open]),
    ]);
  };

  container.append(
    localTool("Claude Code", "claude-code", tools.claudeCode),
    localTool("Cursor", "cursor", tools.cursor),
    cliRow(),
    webTool("ChatGPT", "https://chatgpt.com/#settings/Connectors"),
    webTool("Claude (web & desktop)", "https://claude.ai/settings/connectors"),
  );
  return container;
}
