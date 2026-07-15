//! App self-update, driven entirely from Rust so it works in every window
//! (including the remote wrapper window, which has no IPC). Checks GitHub
//! Releases for a newer signed build, asks the user with a native dialog, then
//! downloads, verifies (minisign), installs, and relaunches.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Entry point. `silent` = true for the on-launch check (say nothing unless an
/// update exists); false for the menu item (also confirm "up to date" / errors).
pub fn check_for_updates(app: &AppHandle, silent: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match run_check(&app).await {
            Ok(Some(update)) => prompt_and_install(&app, update).await,
            Ok(None) => {
                if !silent {
                    info_dialog(&app, "You're up to date", "You have the latest version of Second Brain.");
                }
            }
            Err(e) => {
                log::warn!("update check failed: {e}");
                if !silent {
                    info_dialog(
                        &app,
                        "Couldn't check for updates",
                        "We couldn't check for updates right now. Please try again later.",
                    );
                }
            }
        }
    });
}

async fn run_check(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

async fn prompt_and_install(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let version = update.version.clone();
    let notes = update
        .body
        .clone()
        .filter(|b| !b.trim().is_empty())
        .map(|b| format!("\n\nWhat's new:\n{}", b.trim()))
        .unwrap_or_default();
    let message = format!(
        "Second Brain {version} is available.\n\nUpdate now? The app will download it and restart.{notes}"
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update now".to_string(),
            "Later".to_string(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });

    if rx.await.unwrap_or(false) {
        match update.download_and_install(|_downloaded, _total| {}, || {}).await {
            Ok(()) => app.restart(),
            Err(e) => {
                log::error!("update install failed: {e}");
                info_dialog(
                    app,
                    "Update didn't finish",
                    "Something went wrong installing the update. Your app is unchanged — please try again later.",
                );
            }
        }
    }
}

fn info_dialog(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .blocking_show();
}
