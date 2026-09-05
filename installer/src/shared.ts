// Helpers shared by the setup flow (main.ts) and the Connection details
// window (details.ts). The webview only ever handles URLs and booleans —
// tokens stay in the Rust core.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { teamCardKeys, type ConnectionRole } from "./connection-role";

export interface ConnectionDetails {
  workerUrl: string;
  mcpUrl: string;
  /** True only when setup provisioned in team mode; absent reads as personal. */
  teamMode: boolean;
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

/* ── Icons ────────────────────────────────────────────────────────────────────
 * Every mark in this app is one of these. There are no emoji anywhere in the
 * UI: an emoji is a font, and a font is rendered by the host OS — the same
 * character is a flat glyph on one machine, a gradient sticker on another, and
 * a tofu box on a machine missing the range. None of those is a design
 * decision, and setup has to look like itself on every desktop it ships to.
 *
 * Path data is Lucide (MIT), inlined rather than linked: setup must render
 * fully offline, so there is no CDN, no icon font and no network request in
 * this file. Drawn on Lucide's grid — 24×24, 2px stroke, no fill, round caps
 * and joins — which is why they sit together as one set and why they take
 * their colour from whatever they are placed in.
 */
const ICON_PATHS = {
  /** A step that finished. */
  check: '<path d="M20 6 9 17l-5-5"/>',
  /** A step that failed. An x, not a bang: it says "this one did not happen",
   *  where a bang says "danger", and the failure is neither dangerous nor the
   *  user's doing. */
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  /** A step that has not started. Deliberately a filled dot rather than a
   *  stroked ring: .check-icon is already a ring, and a ring inside a ring
   *  reads as a target. */
  dot: '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
  /** Something went wrong and it is worth stopping to read. */
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  /** Nothing is wrong; here is something useful. */
  lightbulb:
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>' +
    '<path d="M9 18h6"/><path d="M10 22h4"/>',
  /** A password or a token — the thing to write down before moving on. */
  key:
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 ' +
    '1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
    '<circle cx="16.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/>',
  /** A Second Brain that already exists. */
  brain:
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>' +
    '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>' +
    '<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>' +
    '<path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>' +
    '<path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/>' +
    '<path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  /** The road is blocked, and going around it is the whole answer. */
  construction:
    '<rect x="2" y="6" width="20" height="8" rx="1"/>' +
    '<path d="M17 14v7"/><path d="M7 14v7"/><path d="M17 3v3"/><path d="M7 3v3"/>' +
    '<path d="M10 14 2.3 6.3"/><path d="m14 6 7.7 7.7"/><path d="m8 6 8 8"/>',
  /** A signed, verified update. */
  shieldCheck:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 ' +
    '1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  /** Make one of these for me. */
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 ' +
    '9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 ' +
    '1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>' +
    '<path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M6 18H4"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/**
 * One inline SVG, sized by class and coloured by whatever it sits in.
 *
 * Always `aria-hidden`: every icon in this app sits beside the sentence it
 * illustrates, so announcing it would read the same idea twice — and the two
 * places where the mark carries state on its own (the checklist rows) already
 * publish that state as a live-region sentence of their own.
 */
export function icon(name: IconName, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // Keeps the svg out of the tab order in the browsers that still put it in.
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", cls);
  svg.innerHTML = ICON_PATHS[name];
  return svg;
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

/// A password on screen, with a Copy button and no description — the label
/// carries the whole meaning, and it changes with the state (see #235 §4.1,
/// where the same value is "not in use").
///
/// Deliberately separate from `urlCard`: once a password change lands, nothing
/// can read that password back — not this app, not Cloudflare, not Wrangler —
/// so every screen that reports what happened has to carry it. This is the card
/// that does that, and there is no Email button anywhere near it.
export function secretCard(label: string, value: string): HTMLElement {
  const copyBtn = h("button", { class: "btn-secondary" }, [t("common.copy")]);
  copyBtn.addEventListener("click", () => void copyText(value, copyBtn));
  // The feature edge is not decoration here: on every screen this card appears
  // on, it is the only thing that cannot be recovered if the window is closed,
  // and it was previously indistinguishable from the two address cards beside
  // it — which are both recoverable and not secret.
  return h("div", { class: "card url-card card--feature" }, [
    h("div", { class: "url-label" }, [label]),
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

/// Shown when setup chose team mode — on the setup's last screen and in the
/// Connection pane. Pure copy: what this role can do that the others cannot,
/// and where to do it. Administration itself lives in the dashboard's Team
/// panel, so there is nothing to invoke here.
///
/// The role is a parameter rather than something this function works out,
/// because it is derived from a probe the caller makes and must never be
/// cached: a member promoted to admin next month has to see the admin card the
/// next time they connect, not the one written on install day.
export function teamCard(role: ConnectionRole): HTMLElement {
  const keys = teamCardKeys(role);
  // `connection-role.ts` imports nothing — that is what makes it testable
  // outside a webview — so it cannot name `t`'s key type and returns plain
  // strings. Both keys are `details.*` by construction, and
  // test/unit/connection-role.test.ts asserts that prefix on all three roles;
  // the catalogs themselves are checked by test/unit/installer-i18n-parity.
  const key = (path: string) => path as `details.${string}`;
  // Both call sites deliberately place this above the address cards because it
  // is what the reader is expected to act on; the feature edge makes that
  // ordering visible instead of leaving it to be inferred from position.
  return h("div", { class: "card url-card card--feature" }, [
    h("div", { class: "url-label" }, [t(key(keys.label))]),
    h("div", { class: "url-desc" }, [t(key(keys.body))]),
  ]);
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
      const btn = h(
        "button",
        { class: "btn-secondary", "aria-label": `${t("common.connect")} ${title}` },
        [t("common.connect")],
      );
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
      const copy = h(
        "button",
        { class: "btn-ghost", "aria-label": `${t("common.copyLink")} ${title}` },
        [t("common.copyLink")],
      );
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
    const cliTitle = t("tools.cliTitle");
    const sub = h("div", { class: "row-sub" }, [t("tools.cliSub")]);
    const actions = h("div", { class: "row-actions" });
    const setupBtn = h(
      "button",
      { class: "btn-secondary", "aria-label": `${t("tools.setupCli")} ${cliTitle}` },
      [t("tools.setupCli")],
    );
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
      h("div", {}, [h("div", { class: "row-title" }, [cliTitle]), sub]),
      actions,
    ]);
  };

  const webTool = (title: string, settingsUrl: string) => {
    const copy = h(
      "button",
      { class: "btn-secondary", "aria-label": `${t("common.copyLink")} ${title}` },
      [t("common.copyLink")],
    );
    copy.addEventListener("click", () => void copyText(details.mcpUrl, copy));
    const open = h(
      "button",
      { class: "btn-ghost", "aria-label": `${t("common.openSettings")} ${title}` },
      [t("common.openSettings")],
    );
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
  category: string | null;
  workspaceName: string | null;
}

// Grouping mirrors the dashboard's own integrations screen, so the two surfaces
// read the same way. The order is fixed rather than discovered, so the list does
// not reshuffle as providers connect.
const CATEGORY_ORDER = ["knowledge", "calendar", "email"] as const;

function categoryLabel(id: string): string {
  if (id === "knowledge") return t("integrations.categoryKnowledge");
  if (id === "calendar") return t("integrations.categoryCalendar");
  if (id === "email") return t("integrations.categoryEmail");
  return t("integrations.categoryOther");
}

/// One provider inside a category: status on the left, what you can do on the
/// right. Connecting happens in the dashboard (it needs a secret pasted), so the
/// desktop app deep-links there rather than duplicating those forms.
function providerRow(status: IntegrationStatus): HTMLElement {
  const title = h("div", { class: "row-title" }, [status.name]);
  const sub = h("div", { class: "row-sub" }, []);
  const actions = h("div", { class: "row-actions" });

  if (status.connected) {
    title.append(badge(t("common.connected"), true));
    sub.textContent = status.workspaceName
      ? t("integrations.connectedTo", { workspace: status.workspaceName })
      : t("integrations.connectedPlain");
    // Only Notion has a desktop-side sync command; everything else syncs on the
    // Worker's own schedule, so offering a button here would be a lie.
    if (status.provider === "notion") {
      const sync = h("button", { class: "btn-secondary" }, [t("integrations.syncNow")]);
      sync.addEventListener("click", async () => {
        sync.disabled = true;
        sync.textContent = t("integrations.syncing");
        try {
          sub.textContent = await invoke<string>("sync_notion");
        } catch (e) {
          sub.textContent = String(e);
        } finally {
          sync.disabled = false;
          sync.textContent = t("integrations.syncNow");
        }
      });
      actions.append(sync);
    }
    const manage = h("button", { class: "btn-ghost" }, [t("integrations.manage")]);
    manage.addEventListener("click", () => void invoke("open_dashboard_integrations"));
    actions.append(manage);
  } else {
    const setup = h("button", { class: "btn-secondary" }, [t("integrations.setUp")]);
    setup.addEventListener("click", () => void invoke("open_dashboard_integrations"));
    actions.append(setup);
  }

  return h("div", { class: "row" }, [h("div", {}, [title, sub]), actions]);
}

/// Renders the category list, and swaps itself for that category's providers
/// when one is chosen. Drilling in keeps the window short: without it the list
/// would be every provider at once, which is what made this panel long.
function renderIntegrationBrowser(host: HTMLElement, all: IntegrationStatus[]): void {
  const groups = new Map<string, IntegrationStatus[]>();
  for (const item of all) {
    const key = item.category ?? "other";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number]);
    const bi = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number]);
    return (ai < 0 ? CATEGORY_ORDER.length : ai) - (bi < 0 ? CATEGORY_ORDER.length : bi);
  });

  // Everything is on screen at once under its category heading. An earlier
  // version made each category a tappable row you drilled into, which meant a
  // hidden second level with nothing on screen to say how to get back out.
  const blocks: HTMLElement[] = [];
  for (const id of ordered) {
    blocks.push(h("div", { class: "group-head" }, [categoryLabel(id)]));
    blocks.push(...(groups.get(id) ?? []).map(providerRow));
  }
  host.replaceChildren(...blocks);
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

  // Worker-side integrations are discovered from the Worker rather than listed
  // here, so providers added to the Worker (calendar, email) show up without a
  // desktop release. Grouped by category and drilled into, which keeps this
  // panel short as the provider list grows.
  const integrations = h("div", {});
  void (async () => {
    try {
      const list = await invoke<IntegrationStatus[]>("integration_status");
      if (list.length) renderIntegrationBrowser(integrations, list);
    } catch {
      /* offline: the rest of the panel still works */
    }
  })();

  // Apps are installed on this computer; everything below is connected to the
  // Worker. Both get a heading so neither looks like a loose row.
  container.append(
    h("div", { class: "group-head" }, [t("integrations.appsTitle")]),
    extension,
    obsidian,
    integrations,
  );
  return container;
}
