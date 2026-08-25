//! Second Brain desktop app.
//!
//! Two modes of one app:
//!   * first run  → the setup flow (webview UI in src/, provisioning in Rust)
//!   * afterwards → a native shell around the user's own Worker dashboard
//! Mode is decided by whether OS-secure storage holds a completed setup.

mod app_menus;
mod app_update;
mod cf;
mod cli_config;
mod commands;
mod credits;
mod demo_brain;
mod i18n;
mod logging;
mod mcp_config;
mod migration;
mod password_check;
mod rotate;
mod secure_store;
mod settings;
mod version;
mod windows;
mod worker_bundle;
mod worker_url;

use app_menus::{build_menu_items, build_tray_items, install_app_menu, install_tray, AppMenus};
use commands::SetupSession;
use i18n::{AppLocale, Key};
use secure_store::SetupInfo;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Opens the user's dashboard from a menu action (no `State` handle). Falls
/// back to setup when this computer isn't connected yet.
fn open_dashboard_from_menu(app: &AppHandle) {
    let session = app.state::<SetupSession>();
    match commands::open_dashboard_impl(app, &session) {
        Ok(()) => {}
        Err(message) => {
            let locale = app
                .try_state::<AppLocale>()
                .map(|l| l.get())
                .unwrap_or(i18n::Locale::En);
            if not_connected_yet(session.dry_run, secure_store::load_setup) {
                let _ = windows::open_setup_window(app);
            } else {
                app.dialog()
                    .message(message)
                    .title(i18n::t(locale, Key::OpenDashboardFailed))
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
        }
    }
}

/// Whether a failed "open my dashboard" means "this computer is not connected
/// yet" — in which case the setup window is the answer rather than a warning.
///
/// The early return is the point, and it is `load_setup_unless_dry_run`'s point
/// as well. Written inline as `!dry_run && load_setup().is_none()` this is one
/// short-circuit away from #252: `&&` evaluates left to right, so swapping the
/// terms — which compiles, reads the same to a reviewer, and survives every
/// assertion about the value — makes a demo launch read the keychain and raise an
/// OS password prompt on an unsigned dev build, before any window has opened.
/// As a function with `dry_run` in a `return`, the ordering is structural and the
/// loader is injectable, so a test can watch whether it was called at all.
fn not_connected_yet(dry_run: bool, load: impl FnOnce() -> Option<SetupInfo>) -> bool {
    if dry_run {
        // Demo mode is never "not connected": the demo brain is always there, and
        // asking secure storage about it would be asking the wrong question at
        // the cost of a credential prompt.
        return false;
    }
    load().is_none()
}

/// Menu-bar "Sync Notion now": runs the sync in the background and reports the
/// outcome with a native dialog. Silent no-op target when not set up.
fn sync_notion_from_menu(app: &AppHandle) {
    let Some(info) = secure_store::load_setup() else {
        let _ = windows::open_setup_window(app);
        return;
    };
    let locale = app
        .try_state::<AppLocale>()
        .map(|l| l.get())
        .unwrap_or(i18n::Locale::En);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let message = match commands::notion_sync(&info.worker_url, &info.auth_token, locale).await
        {
            Ok(msg) => msg,
            Err(e) => e,
        };
        app.dialog()
            .message(message)
            .title(i18n::t(locale, Key::NotionSyncTitle))
            .kind(MessageDialogKind::Info)
            .show(|_| {});
    });
}

/// Menu-bar Logout: confirm natively, then clear this computer's connection.
/// (The details window has its own inline confirm and calls the command.)
fn confirm_logout(app: &AppHandle) {
    if secure_store::load_setup().is_none() {
        // Nothing to log out of — just make sure setup is visible.
        let _ = windows::open_setup_window(app);
        return;
    }
    let locale = app
        .try_state::<AppLocale>()
        .map(|l| l.get())
        .unwrap_or(i18n::Locale::En);
    let handle = app.clone();
    app.dialog()
        .message(i18n::t(locale, Key::LogoutMessage))
        .title(i18n::t(locale, Key::LogoutTitle))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::t(locale, Key::LogoutConfirm).to_string(),
            i18n::t(locale, Key::Cancel).to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                commands::perform_logout(&handle);
            }
        });
}

/// Resolves the stored setup for launch, skipping secure storage entirely in
/// dry-run.
///
/// The loader is taken lazily rather than as a value because reading it prompts
/// for Keychain access on macOS. Dry-run always launches into the setup flow, so
/// the loaded value was discarded anyway — the old `match` paid a credential
/// prompt for a result it threw away, which made `SECOND_BRAIN_DRY_RUN=1`
/// unusable for demoing on a machine that already has a Second Brain.
fn load_setup_unless_dry_run(
    dry_run: bool,
    load: impl FnOnce() -> Option<SetupInfo>,
) -> Option<SetupInfo> {
    if dry_run {
        return None;
    }
    load()
}

pub fn run() {
    // Errors from provisioning etc. print to stderr (visible under `tauri dev`
    // or when launched from a terminal) *and* append to a bounded, scrubbed
    // file on disk — the only copy a normal launch ever produces, and the one
    // thing that turns "it said my sign-in expired" into a debuggable report.
    // Override the level with RUST_LOG. See `logging`.
    logging::init();

    let dry_run = std::env::var("SECOND_BRAIN_DRY_RUN").is_ok();

    // A demo has to have something to operate on. Started here rather than on
    // first use so it is listening before any window can ask for it, and only in
    // dry-run — a real run must never have a second brain on loopback that a
    // stray address could reach.
    if dry_run {
        demo_brain::start();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            for label in ["brain", "main", "details"] {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    return;
                }
            }
        }))
        // The details panel always opens at its designed size. Restoring a saved
        // geometry meant a window sized before a layout change stayed wrong forever.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("details")
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SetupSession::new(dry_run))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::check_password,
            commands::generate_password,
            commands::submit_password,
            commands::connect_cloudflare,
            commands::connect_existing,
            commands::discover_brains,
            commands::migration_estimate,
            commands::migration_status,
            commands::begin_embedding_migration,
            commands::migration_step,
            commands::finish_embedding_migration,
            commands::migration_reset,
            commands::outstanding_old_index,
            commands::start_provisioning,
            commands::get_connection_details,
            commands::set_team_mode,
            commands::detect_tools,
            commands::connect_tool,
            commands::detect_cli,
            commands::connect_cli,
            commands::install_cli,
            commands::detect_obsidian,
            commands::integration_status,
            commands::sync_notion,
            commands::open_dashboard_integrations,
            commands::copy_text,
            commands::open_external,
            commands::open_dashboard,
            commands::open_details_window,
            commands::logout,
            commands::set_locale,
            commands::worker_update_available,
            commands::begin_worker_update,
            commands::start_worker_update,
            commands::get_brain_settings,
            commands::save_brain_settings,
            commands::open_settings_window,
            // Changing the brain's password (#235). A command that is written,
            // tested, and left unregistered is invisible to the UI.
            commands::begin_password_change,
            commands::rotation_blocked,
            commands::rotate_password,
            commands::recheck_password,
            commands::validate_brain_address,
            commands::disconnect_ai_tools,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir().ok();
            let locale = i18n::resolve_initial_locale(config_dir.as_deref());
            app.manage(AppLocale::new(locale));

            let (
                menu_open,
                menu_hub,
                menu_settings,
                menu_sync,
                menu_update,
                menu_logout,
                connections,
            ) = build_menu_items(&handle, locale)?;
            install_app_menu(&handle, &connections, locale)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "menu-open" => open_dashboard_from_menu(app),
                "menu-hub" => windows::open_details_window(app),
                "menu-settings" => windows::open_settings_window(app),
                "menu-sync-notion" => sync_notion_from_menu(app),
                "menu-update" => app_update::check_for_updates(app, false),
                "menu-logout" => confirm_logout(app),
                _ => {}
            });

            let (
                tray_open,
                tray_hub,
                tray_settings,
                tray_sync,
                tray_update,
                tray_logout,
                tray_quit,
                tray_menu,
            ) = build_tray_items(&handle, locale)?;
            install_tray(&handle, &tray_menu, |app, event| match event.id().as_ref() {
                "tray-open" => open_dashboard_from_menu(app),
                "tray-hub" => windows::open_details_window(app),
                    "tray-settings" => windows::open_settings_window(app),
                "tray-sync-notion" => sync_notion_from_menu(app),
                "tray-update" => app_update::check_for_updates(app, false),
                "tray-logout" => confirm_logout(app),
                "tray-quit" => app.exit(0),
                _ => {}
            })?;

            app.manage(AppMenus {
                menu_open,
                menu_hub,
                menu_settings,
                menu_sync,
                menu_update,
                menu_logout,
                connections_submenu: connections,
                tray_open,
                tray_hub,
                tray_settings,
                tray_sync,
                tray_update,
                tray_logout,
                tray_quit,
            });

            // Mode selection. Dry-run always shows setup so the flow can be
            // demoed even on a machine that already has a Second Brain.
            match load_setup_unless_dry_run(dry_run, secure_store::load_setup) {
                Some(info) => {
                    windows::open_wrapper_window(&handle, &info.worker_url, &info.auth_token)?;
                    // In wrapper mode, quietly ask the brain how it is: whether
                    // the deployed Worker is behind what this app bundles, and
                    // whether the password stored here still opens it at all.
                    commands::check_brain_at_launch(&handle);
                }
                _ => windows::open_setup_window(&handle)?,
            }

            // Quiet check for an app update on launch (says nothing unless one
            // exists). Skipped in dry-run so demos don't hit the network.
            if !dry_run {
                app_update::check_for_updates(&handle, true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn info() -> SetupInfo {
        SetupInfo { worker_url: "https://example.workers.dev".into(), auth_token: "t".into() }
    }

    #[test]
    fn dry_run_does_not_read_secure_storage() {
        let called = Cell::new(false);

        let got = load_setup_unless_dry_run(true, || {
            called.set(true);
            Some(info())
        });

        assert!(!called.get(), "dry-run must not touch the keychain");
        assert!(got.is_none(), "dry-run always launches into setup");
    }

    #[test]
    fn normal_launch_reads_secure_storage() {
        let called = Cell::new(false);

        let got = load_setup_unless_dry_run(false, || {
            called.set(true);
            Some(info())
        });

        assert!(called.get());
        assert_eq!(got.map(|i| i.worker_url), Some("https://example.workers.dev".to_string()));
    }

    #[test]
    fn normal_launch_without_stored_setup_falls_through_to_setup() {
        let got = load_setup_unless_dry_run(false, || None);
        assert!(got.is_none());
    }

    /// The other place #252's short-circuit lives: the menu-bar "Open dashboard"
    /// that failed, deciding whether to show setup or a warning.
    ///
    /// Same bug, same shape, and until now nothing watched it. The prompt itself
    /// is an OS dialog no test can see; whether the loader was called at all is
    /// observable, and that is the thing that causes it.
    #[test]
    fn a_failed_menu_open_asks_the_keychain_nothing_in_dry_run() {
        let called = Cell::new(false);
        let answer = not_connected_yet(true, || {
            called.set(true);
            None
        });
        assert!(!called.get(), "dry-run must not touch the keychain");
        assert!(
            !answer,
            "demo mode is never 'not connected' — the demo brain is always there"
        );

        // …and a real run does consult it, both ways round, so the guard above
        // cannot be satisfied by never asking anyone.
        assert!(not_connected_yet(false, || None), "no stored setup means setup");
        assert!(
            !not_connected_yet(false, || Some(info())),
            "a connected computer gets the warning, not a fresh setup flow"
        );
    }

    /// A command that is written, tested, and left unregistered is invisible to
    /// the UI: `invoke` fails at runtime with "command not found", and nothing in
    /// this crate notices, because every test here calls the Rust function
    /// directly and never goes through the bridge.
    ///
    /// #235 added six, which is more than anyone keeps in their head. Scans only
    /// the handler list, so the names written here cannot satisfy it.
    #[test]
    fn every_command_the_password_change_needs_is_reachable_from_the_webview() {
        let src = include_str!("lib.rs");
        let start = src
            .find("tauri::generate_handler![")
            .expect("the invoke handler");
        let rest = &src[start..];
        let handlers = &rest[..rest
            .find("])")
            .expect("the handler list closes with `])`")];

        for command in [
            "begin_password_change",
            "rotation_blocked",
            "rotate_password",
            "recheck_password",
            "validate_brain_address",
            "disconnect_ai_tools",
        ] {
            assert!(
                handlers.contains(&format!("commands::{command},")),
                "`{command}` is not registered, so the screen that calls it gets \
                 \"command not found\" and no test in this crate can tell"
            );
        }
    }
}
