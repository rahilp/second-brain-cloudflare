//! Second Brain desktop app.
//!
//! Two modes of one app:
//!   * first run  → the setup flow (webview UI in src/, provisioning in Rust)
//!   * afterwards → a native shell around the user's own Worker dashboard
//! Mode is decided by whether OS-secure storage holds a completed setup.

mod app_update;
mod cf;
mod commands;
mod mcp_config;
mod secure_store;
mod version;
mod windows;
mod worker_bundle;

use commands::SetupSession;
use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Menu-bar Logout: confirm natively, then clear this computer's connection.
/// (The details window has its own inline confirm and calls the command.)
fn confirm_logout(app: &AppHandle) {
    if secure_store::load_setup().is_none() {
        // Nothing to log out of — just make sure setup is visible.
        let _ = windows::open_setup_window(app);
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(
            "Log out of this computer?\n\nYour Second Brain and all its memories stay safe. \
             You can reconnect anytime with your address and password.",
        )
        .title("Log out")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Log out".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                commands::perform_logout(&handle);
            }
        });
}

pub fn run() {
    let dry_run = std::env::var("SECOND_BRAIN_DRY_RUN").is_ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            for label in ["brain", "main", "details"] {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.show();
                    let _ = w.set_focus();
                    return;
                }
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SetupSession::new(dry_run))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::submit_password,
            commands::connect_cloudflare,
            commands::connect_existing,
            commands::start_provisioning,
            commands::get_connection_details,
            commands::detect_tools,
            commands::connect_tool,
            commands::copy_text,
            commands::open_external,
            commands::open_dashboard,
            commands::open_details_window,
            commands::logout,
            commands::worker_update_available,
            commands::begin_worker_update,
            commands::start_worker_update,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // App menu: platform defaults (gives Edit/copy/paste, needed for
            // the password field on macOS) plus our own entry.
            let details_item = MenuItem::with_id(
                app,
                "menu-details",
                "Connection details…",
                true,
                Some("CmdOrCtrl+D"),
            )?;
            let update_item =
                MenuItem::with_id(app, "menu-update", "Check for updates…", true, None::<&str>)?;
            let logout_item =
                MenuItem::with_id(app, "menu-logout", "Log out…", true, None::<&str>)?;
            let menu = Menu::default(&handle)?;
            let connections = SubmenuBuilder::new(app, "Connections")
                .item(&details_item)
                .item(&update_item)
                .separator()
                .item(&logout_item)
                .build()?;
            menu.append(&connections)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "menu-details" => windows::open_details_window(app),
                "menu-update" => app_update::check_for_updates(app, false),
                "menu-logout" => confirm_logout(app),
                _ => {}
            });

            // Tray: quick access to the dashboard and connection details.
            let tray_open = MenuItem::with_id(app, "tray-open", "Open Second Brain", true, None::<&str>)?;
            let tray_details =
                MenuItem::with_id(app, "tray-details", "Connection details…", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&tray_open, &tray_details, &tray_quit])
                .build()?;
            TrayIconBuilder::with_id("second-brain-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray-open" => {
                        if let Some(info) = secure_store::load_setup() {
                            let _ = windows::open_wrapper_window(app, &info.worker_url, &info.auth_token);
                        } else {
                            let _ = windows::open_setup_window(app);
                        }
                    }
                    "tray-details" => windows::open_details_window(app),
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Mode selection. Dry-run always shows setup so the flow can be
            // demoed even on a machine that already has a Second Brain.
            match secure_store::load_setup() {
                Some(info) if !dry_run => {
                    windows::open_wrapper_window(&handle, &info.worker_url, &info.auth_token)?;
                    // In wrapper mode, quietly check whether the deployed Worker
                    // is behind what this app bundles and offer to update it.
                    commands::maybe_offer_worker_update(&handle);
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
