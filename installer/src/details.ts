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
  teamCard,
} from "./shared";
import { integrationRows, toolRows } from "./shared";
import {
  canRotatePassword,
  canUpdateWorker,
  legacyWorkerFromDetailsProbe,
  roleFromDetailsProbe,
} from "./connection-role";
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
  /**
   * Who this window is rendering for.
   *
   * Derived on every open, never stored: a member promoted to admin in the
   * dashboard next month must not be looking at a card this app wrote on the
   * day they installed it.
   *
   * This used to be a hardcoded constant naming the owner, on the reasoning
   * that the webview never handles the token — it stays in the Rust core — so
   * this window had nothing to call `/team/me` with. It now has:
   * `connection_role` asks on its behalf. The constant meant every team member
   * who opened this window from the menu or the tray read "You're signed in as
   * this brain's owner-admin" and was offered a "Change my password" button
   * that walks them through a Cloudflare sign-in and inventing a password
   * before failing with ErrorWrongCfAccount — one click from a setup screen
   * that had just called them a member.
   *
   * A solo brain asks nothing at all: `teamMode` comes from the keychain, and
   * `roleFromDetailsProbe` short-circuits on it before any request. Any failure
   * — the command erroring, an unreachable brain, a Worker too old for the
   * route — is a `null` probe, which resolves to "member": the least-privileged
   * answer, because the cost of under-claiming here is a hidden button and the
   * cost of over-claiming is the sentence above.
   */
  const roleProbe =
    details.teamMode ? await invoke<unknown>("connection_role").catch(() => null) : null;
  const connectionRole = roleFromDetailsProbe(details.teamMode, roleProbe);
  /**
   * Whether the brain is too old to say who is asking.
   *
   * Read off the SAME probe, one round trip. It unlocks the Worker-update
   * button and nothing else — see `canUpdateWorker` for why that one route, and
   * why the password card below deliberately does not get the same treatment.
   */
  const legacyWorker = legacyWorkerFromDetailsProbe(roleProbe);

  const tools = await invoke<ToolStatus>("detect_tools");
  const update = await invoke<{ availableVersion: string } | null>(
    "worker_update_available",
  ).catch(() => null);
  // A rebuild in flight blocks a password change (#235 §4). If the check itself
  // can't run — offline, brain unreachable — the button stays enabled: a
  // network blip must not present as "you may not change your password", and
  // the command re-checks before it does anything anyway.
  let rotationBlocked = await invoke<boolean>("rotation_blocked").catch(() => false);

  // Re-asked rather than captured once. A rebuild is finished (or carried on)
  // in the Advanced Settings window, and the user comes straight back here to
  // do the thing they were blocked from — so a value read at boot would go on
  // saying the password can't be changed until this window was closed and
  // reopened. Only a change in the answer redraws, so this settles after one
  // flip instead of looping.
  const refreshRotationBlocked = () => {
    void invoke<boolean>("rotation_blocked").then(
      blocked => {
        if (blocked === rotationBlocked) return;
        rotationBlocked = blocked;
        render();
      },
      () => {
        /* offline: keep whatever the last successful answer was */
      },
    );
  };
  window.addEventListener("focus", refreshRotationBlocked);

  // One pane at a time, chosen from a rail. Everything used to be stacked in a
  // single column, so most of it was below the fold and the only way to find
  // anything was to scroll and read. Each pane now answers one question.
  type SectionId = "connection" | "tools" | "integrations" | "computer";
  let active: SectionId = "connection";

  const paneFor = (id: SectionId): HTMLElement[] => {
    if (id === "connection") {
      // Every time this pane is drawn, not only the first.
      refreshRotationBlocked();
      // No "open the dashboard" button here on purpose: this window is reached
      // from the dashboard, which stays open behind it, so the button only sent
      // this window to the back. The menu bar still has one for the case where
      // no dashboard window is open.
      return [
        h("h2", { class: "pane-title" }, [t("details.navConnection")]),
        h("p", { class: "pane-desc" }, [t("details.lede")]),
        ...detailCards(details),
        // Team setups only, and before the password card: it is what the owner
        // is expected to do next. "Copy both" below still copies exactly the
        // two URL cards above, so nothing lands between them.
        ...(details.teamMode ? [teamCard(connectionRole)] : []),
        // Absent, not disabled, for anyone who cannot rotate. `passwordCard`'s
        // other branch already renders a greyed-out card with an escape hatch,
        // and reusing that shape for a member would say "not right now" about
        // something that is not theirs to do at all — and then dead-end them at
        // a Cloudflare sign-in for an account they have no login to.
        ...(canRotatePassword(connectionRole) ? [passwordCard(rotationBlocked)] : []),
        h("div", { class: "actions-spread" }, [copyBothButton(details), emailButton(details)]),
        disconnectSection(),
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
      ...(update
        ? [updateCard(update.availableVersion, canUpdateWorker(connectionRole, legacyWorker), legacyWorker)]
        : []),
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

    // The pane's own heading, not the section wrapper: focusing it is what
    // makes VoiceOver announce "Connection" → "AI tools" as a real navigation
    // rather than leaving focus on the rail button that was just clicked (#P0-3).
    // Every `paneFor` branch returns its `<h2 class="pane-title">` first, by
    // construction, so this needs no per-branch plumbing to find it.
    const paneEls = paneFor(active);
    const heading = paneEls[0] as HTMLElement;
    heading.setAttribute("tabindex", "-1");
    app.replaceChildren(
      h("div", { class: "panel" }, [rail, h("section", { class: "pane" }, paneEls)]),
    );
    heading.focus({ preventScroll: true });
  };

  render();
}

/**
 * Shown, but not always actionable.
 *
 * The update redeploys the Worker inside the Cloudflare account it lives in, so
 * only the owner can complete it — `start_worker_update` matches the brain's
 * workers.dev subdomain against the signed-in session and refuses anyone else.
 * The card still renders for everybody on purpose: a member whose brain is
 * behind sees features they have read about and do not have, and the honest
 * answer is to say why and who can fix it. What they do not get is a button
 * that walks them through a Cloudflare sign-in before failing.
 *
 * `ownerUnconfirmed` is the third case: the brain is too old to say who is
 * asking, so the button is offered to whoever opened this window — otherwise
 * the brain could never be updated to the version that can say (see
 * `canUpdateWorker`). The copy has to be straight about that. Being offered a
 * button because the app cannot tell who you are is a different sentence from
 * being offered it because it knows you are the owner, and printing the second
 * one would be the app guessing out loud.
 */
function updateCard(
  availableVersion: string,
  mayUpdate: boolean,
  ownerUnconfirmed: boolean,
): HTMLElement {
  const label = h("div", { class: "url-label" }, [
    t("details.updateLabel", { version: availableVersion }),
  ]);
  if (!mayUpdate) {
    // Prose, not a disabled button: a greyed-out control reads as "not right
    // now" about something that is not theirs to do at all.
    return h("div", { class: "card", style: "border-color: var(--accent);" }, [
      label,
      h("div", { class: "url-desc" }, [t("details.updateDescOther")]),
    ]);
  }
  const button = h("button", { class: "btn-primary" }, [t("details.updateButton")]);
  button.addEventListener("click", () => void invoke("begin_worker_update"));
  return h("div", { class: "card", style: "border-color: var(--accent);" }, [
    label,
    h("div", { class: "url-desc" }, [
      t(ownerUnconfirmed ? "details.updateDescLegacy" : "details.updateDesc"),
    ]),
    button,
  ]);
}

/// The one card here with no value and no Copy button. That absence is the
/// first thing a reader notices, so the description explains it rather than
/// leaving it to be inferred: nothing can read the password back, so there is
/// nothing to show.
function passwordCard(blocked: boolean): HTMLElement {
  const card = h("div", { class: "card url-card" }, [
    h("div", { class: "url-label" }, [t("details.passwordLabel")]),
    h("div", { class: "url-desc" }, [t("details.passwordDesc")]),
  ]);

  if (!blocked) {
    const change = h("button", { class: "btn-secondary" }, [t("details.passwordButton")]);
    change.addEventListener("click", () => void invoke("begin_password_change"));
    card.append(h("div", { class: "row-actions", style: "justify-content:flex-end" }, [change]));
    return card;
  }

  // In place of the button, inside the same card. Opening a window that
  // immediately dead-ends is worse than never enabling the door, and the escape
  // route has to be visible next to the thing it unblocks — an abandoned
  // rebuild would otherwise block this forever with no on-screen reason.
  const settings = h("button", { class: "btn-secondary" }, [t("changePassword.blockedButton")]);
  settings.addEventListener("click", () => void invoke("open_settings_window"));
  card.append(
    h("div", { class: "notice" }, [
      "⚠️",
      h("div", {}, [
        h("div", { class: "url-label" }, [t("changePassword.blockedTitle")]),
        h("div", {}, [t("changePassword.blockedBody")]),
        h("div", { style: "margin-top:8px" }, [t("changePassword.blockedEscape")]),
      ]),
    ]),
    h("div", { class: "row-actions", style: "justify-content:flex-end" }, [settings]),
  );
  return card;
}

/// Deliberately not part of changing the password (#235 §6). Tools connected
/// with the connection link hold their own access and never used the password,
/// so a change does not reach them — and a change made after a leak would
/// otherwise leave them open. Confirmation names what will need reconnecting.
function disconnectSection(): HTMLElement {
  const container = h("div", { class: "logout-section" });

  // `note` replaces the description with what just happened, so a partial
  // failure keeps the button it needs to be retried with.
  const render = (confirming: boolean, note?: string) => {
    const label = h("div", { class: "url-label" }, [t("details.disconnectLabel")]);
    if (!confirming) {
      const start = h("button", { class: "btn-danger" }, [t("details.disconnectButton")]);
      start.addEventListener("click", () => render(true));
      container.replaceChildren(
        label,
        h("div", { class: "url-desc" }, [note ?? t("details.disconnectDesc")]),
        h("div", { class: "row-actions" }, [start]),
      );
      return;
    }

    const confirm = h("button", { class: "btn-danger" }, [t("details.disconnectConfirm")]);
    const keep = h("button", { class: "btn-ghost" }, [t("details.disconnectKeep")]);
    const status = h("div", { class: "url-desc" }, [t("details.disconnectConfirmDesc")]);
    keep.addEventListener("click", () => render(false));
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      keep.disabled = true;
      confirm.textContent = t("details.disconnectWorking");
      try {
        const result = await invoke<{ ok: boolean; revoked: number; failed: number }>(
          "disconnect_ai_tools",
        );
        // `failed` is reported rather than swallowed: a tool that kept its
        // access is the whole thing this control exists to close, so that case
        // goes back to a state the user can run again.
        if (!result.ok) {
          render(false, t("details.disconnectFailed"));
          return;
        }
        container.replaceChildren(
          label,
          h("div", { class: "url-desc" }, [
            result.revoked === 0 ? t("details.disconnectDoneNone") : t("details.disconnectDone"),
          ]),
        );
      } catch (e) {
        status.textContent = String(e);
        confirm.disabled = false;
        keep.disabled = false;
        confirm.textContent = t("details.disconnectConfirm");
      }
    });
    container.replaceChildren(label, status, h("div", { class: "row-actions" }, [confirm, keep]));
  };

  render(false);
  return container;
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
