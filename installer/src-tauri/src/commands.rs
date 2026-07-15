//! Tauri commands — the only bridge between the webview UI and the Rust core.
//! Tokens and passwords flow IN through here (user input / OS keychain) but
//! never back out to the webview; the UI only ever receives URLs, booleans,
//! account names, and progress events.

use crate::cf::api::CfClient;
use crate::cf::backend::{DryRunBackend, LiveBackend};
use crate::cf::oauth::{self, Tokens};
use crate::cf::provision::{self, ProvisionError, ProvisionOutcome};
use crate::cf::types::{Account, CfApiError};
use crate::{mcp_config, secure_store, windows, worker_bundle};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// In-memory state for the setup flow. Dropped when the process exits;
/// nothing here is persisted except through `secure_store` on success.
pub struct SetupSession {
    pub dry_run: bool,
    password: Mutex<Option<String>>,
    tokens: Mutex<Option<Tokens>>,
    accounts: Mutex<Vec<Account>>,
    outcome: Mutex<Option<ProvisionOutcome>>,
    /// Set when the main window should boot straight into the Worker-update
    /// flow instead of the normal setup flow.
    pending_worker_update: Mutex<bool>,
}

impl SetupSession {
    pub fn new(dry_run: bool) -> Self {
        Self {
            dry_run,
            password: Mutex::new(None),
            tokens: Mutex::new(None),
            accounts: Mutex::new(Vec::new()),
            outcome: Mutex::new(None),
            pending_worker_update: Mutex::new(false),
        }
    }

    fn reset(&self) {
        *self.password.lock().unwrap() = None;
        *self.tokens.lock().unwrap() = None;
        self.accounts.lock().unwrap().clear();
        *self.outcome.lock().unwrap() = None;
        *self.pending_worker_update.lock().unwrap() = false;
    }
}

const MIN_PASSWORD_LEN: usize = 12;
const FRIENDLY_RETRY: &str =
    "That didn't work, but nothing is lost — your progress is saved, so it's safe to try again.";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub mode: &'static str,
    pub dry_run: bool,
}

#[tauri::command]
pub fn get_app_state(session: State<'_, SetupSession>) -> AppState {
    let mode = if *session.pending_worker_update.lock().unwrap() {
        "worker-update"
    } else if secure_store::load_setup().is_some() && !session.dry_run {
        "wrapper"
    } else {
        "setup"
    };
    AppState {
        mode,
        dry_run: session.dry_run,
    }
}

#[tauri::command]
pub fn submit_password(password: String, session: State<'_, SetupSession>) -> Result<(), String> {
    let trimmed = password.trim();
    if trimmed.len() < MIN_PASSWORD_LEN {
        return Err(format!(
            "Your password needs at least {MIN_PASSWORD_LEN} characters."
        ));
    }
    *session.password.lock().unwrap() = Some(trimmed.to_string());
    Ok(())
}

#[tauri::command]
pub async fn connect_cloudflare(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<Vec<Account>, String> {
    if session.dry_run {
        let accounts = vec![Account {
            id: "dry-run-account".into(),
            name: "Demo Space".into(),
        }];
        *session.accounts.lock().unwrap() = accounts.clone();
        return Ok(accounts);
    }

    let opener_app = app.clone();
    let tokens = oauth::run_login_flow(move |url| {
        let _ = opener_app.opener().open_url(url, None::<&str>);
    })
    .await
    .map_err(|e| {
        log::warn!("oauth flow failed: {e}");
        e.to_string()
    })?;

    let accounts = CfClient::list_accounts(&tokens.access_token)
        .await
        .map_err(|e| {
            log::warn!("account listing failed: {e}");
            "Signed in, but we couldn't read your account. Please try again.".to_string()
        })?;
    if accounts.is_empty() {
        return Err("That Cloudflare login has no account we can set up in.".into());
    }

    *session.tokens.lock().unwrap() = Some(tokens);
    *session.accounts.lock().unwrap() = accounts.clone();
    Ok(accounts)
}

#[tauri::command]
pub async fn start_provisioning(
    account_id: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let password = session
        .password
        .lock()
        .unwrap()
        .clone()
        .ok_or("Please choose a password first.")?;
    let manifest = worker_bundle::manifest();

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    let outcome = if session.dry_run {
        provision::provision(&DryRunBackend, manifest, "Demo Space", &password, progress)
            .await
            .map_err(|e| {
                log::warn!("dry-run provision failed: {e}");
                FRIENDLY_RETRY.to_string()
            })?
    } else {
        let account_name = session
            .accounts
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.name.clone())
            .ok_or("Please sign in to Cloudflare first.")?;
        let mut tokens = session
            .tokens
            .lock()
            .unwrap()
            .clone()
            .ok_or("Please sign in to Cloudflare first.")?;

        // Refresh proactively if the access token already aged out (the user
        // may have sat on the password/progress screens for a while).
        if tokens.expires_at <= std::time::Instant::now() {
            tokens = oauth::refresh(&tokens).await.map_err(|e| {
                log::warn!("proactive token refresh failed: {e}");
                "Your Cloudflare sign-in expired. Please sign in again.".to_string()
            })?;
            *session.tokens.lock().unwrap() = Some(tokens.clone());
        }

        // One transparent refresh+retry on auth expiry: provisioning is
        // idempotent, so re-running the pipeline is safe.
        let mut attempt = 0;
        loop {
            attempt += 1;
            let backend = LiveBackend {
                client: CfClient::new(tokens.access_token.clone(), account_id.clone()),
            };
            let progress_app = app.clone();
            let progress = move |event: provision::StepEvent| {
                let _ = progress_app.emit("setup-progress", &event);
            };
            match provision::provision(&backend, manifest, &account_name, &password, progress)
                .await
            {
                Ok(outcome) => break outcome,
                Err(ProvisionError::Api(CfApiError::Unauthorized)) if attempt == 1 => {
                    tokens = oauth::refresh(&tokens).await.map_err(|e| {
                        log::warn!("token refresh failed: {e}");
                        "Your Cloudflare sign-in expired. Please sign in again.".to_string()
                    })?;
                    *session.tokens.lock().unwrap() = Some(tokens.clone());
                }
                Err(e) => {
                    log::warn!("provisioning failed: {e}");
                    return Err(FRIENDLY_RETRY.to_string());
                }
            }
        }
    };

    if !session.dry_run {
        secure_store::save_setup(&outcome.worker_url, &password).map_err(|e| {
            log::error!("secure store save failed: {e}");
            "Setup finished, but we couldn't save your details to this device's secure storage."
                .to_string()
        })?;
    }
    *session.outcome.lock().unwrap() = Some(outcome.clone());
    Ok(outcome)
}

/// Turns whatever the user pasted into a canonical `https://host` origin:
/// tolerates a missing scheme, trailing slashes, and pasted sub-paths
/// (e.g. their /mcp connector link or a dashboard page).
fn normalize_worker_url(input: &str) -> Result<String, String> {
    const BAD: &str = "That doesn't look like a web address. It usually ends in .workers.dev.";
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(BAD.into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|_| BAD.to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(BAD.into());
    }
    // No legitimate Worker address carries credentials — this also catches
    // scheme-ish junk like "mailto:a@b.c" being read as user@host.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(BAD.into());
    }
    let host = parsed.host_str().ok_or(BAD)?;
    let origin = match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    };
    Ok(origin)
}

/// The "Already have a Second Brain?" path: validate the address + password
/// against the live Worker, then save them — no Cloudflare sign-in, no
/// provisioning, nothing in the user's account is touched.
#[tauri::command]
pub async fn connect_existing(
    address: String,
    password: String,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let worker_url = normalize_worker_url(&address)?;
    let password = password.trim().to_string();
    if password.is_empty() {
        return Err("Enter the password you chose when you set it up.".into());
    }

    if !session.dry_run {
        use crate::cf::api::{probe_worker, WorkerProbe};
        match probe_worker(&worker_url, &password).await {
            Ok(WorkerProbe::Valid) => {}
            Ok(WorkerProbe::WrongPassword) => {
                return Err("That password doesn't match this Second Brain. Check it and try again.".into())
            }
            Ok(WorkerProbe::NotABrain) => {
                return Err("We couldn't find a Second Brain at that address. Double-check the link — it usually ends in .workers.dev.".into())
            }
            Err(e) => {
                log::warn!("existing-brain probe failed: {e}");
                return Err("We couldn't reach that address. Check it and your internet connection, then try again.".into());
            }
        }
        secure_store::save_setup(&worker_url, &password).map_err(|e| {
            log::error!("secure store save failed: {e}");
            "Connected, but we couldn't save your details to this device's secure storage.".to_string()
        })?;
    }

    let outcome = ProvisionOutcome {
        mcp_url: format!("{worker_url}/mcp"),
        worker_url,
    };
    *session.outcome.lock().unwrap() = Some(outcome.clone());
    Ok(outcome)
}

fn details_from_anywhere(session: &SetupSession) -> Option<ProvisionOutcome> {
    if let Some(outcome) = session.outcome.lock().unwrap().clone() {
        return Some(outcome);
    }
    secure_store::load_setup().map(|info| ProvisionOutcome {
        mcp_url: format!("{}/mcp", info.worker_url.trim_end_matches('/')),
        worker_url: info.worker_url,
    })
}

#[tauri::command]
pub fn get_connection_details(session: State<'_, SetupSession>) -> Result<ProvisionOutcome, String> {
    details_from_anywhere(&session).ok_or_else(|| "Setup hasn't finished yet.".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub claude_code: bool,
    pub cursor: bool,
}

#[tauri::command]
pub fn detect_tools() -> ToolStatus {
    let home = dirs::home_dir().unwrap_or_default();
    ToolStatus {
        claude_code: mcp_config::detect(mcp_config::Tool::ClaudeCode, &home),
        cursor: mcp_config::detect(mcp_config::Tool::Cursor, &home),
    }
}

#[tauri::command]
pub fn connect_tool(tool: String, session: State<'_, SetupSession>) -> Result<String, String> {
    let tool = mcp_config::Tool::from_id(&tool).ok_or("Unknown tool.")?;
    let outcome = details_from_anywhere(&session).ok_or("Setup hasn't finished yet.")?;
    let home = dirs::home_dir().ok_or("Couldn't find your home folder.")?;
    if session.dry_run {
        // Demo mode must not touch real tool configs.
        return Ok("(demo) no changes written".into());
    }
    let path = mcp_config::connect(tool, &home, &outcome.mcp_url).map_err(|e| {
        log::warn!("mcp config write failed: {e}");
        "We couldn't update that tool's settings. You can paste the link manually instead."
            .to_string()
    })?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn copy_text(text: String, app: AppHandle) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|_| "Couldn't copy to the clipboard.".to_string())
}

/// Opens a URL in the default browser. Restricted to the destinations the UI
/// legitimately links to — the webview cannot use this to open anything else.
#[tauri::command]
pub fn open_external(url: String, app: AppHandle) -> Result<(), String> {
    let allowed = url.starts_with("https://chatgpt.com/")
        || url.starts_with("https://claude.ai/")
        || url.starts_with("mailto:");
    if !allowed {
        return Err("That link can't be opened from here.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Couldn't open your browser.".to_string())
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle, session: State<'_, SetupSession>) -> Result<(), String> {
    let (worker_url, token) = if session.dry_run {
        let outcome = details_from_anywhere(&session).ok_or("Setup hasn't finished yet.")?;
        (outcome.worker_url, "demo".to_string())
    } else {
        let info = secure_store::load_setup().ok_or("Setup hasn't finished yet.")?;
        (info.worker_url, info.auth_token)
    };
    windows::open_wrapper_window(&app, &worker_url, &token)
        .map_err(|_| "Couldn't open your Second Brain window.".to_string())?;
    for label in ["main", "details"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_details_window(app: AppHandle) {
    windows::open_details_window(&app);
}

// ── Worker update ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkerUpdateInfo {
    pub deployed_version: Option<String>,
    pub available_version: String,
}

/// The workers.dev subdomain in a Worker URL is the second dotted label:
/// `second-brain.acme.workers.dev` → `acme`.
fn subdomain_of(worker_url: &str) -> Option<String> {
    let host = url::Url::parse(worker_url).ok()?.host_str()?.to_string();
    if !host.ends_with(".workers.dev") {
        return None; // custom domain — can't auto-resolve the account
    }
    host.split('.').nth(1).map(|s| s.to_string())
}

/// Core check, usable outside a command context (the launch-time offer). None
/// when up to date, unknown, on a custom domain, in dry-run, or not set up.
async fn compute_worker_update(dry_run: bool) -> Option<WorkerUpdateInfo> {
    if dry_run {
        return None;
    }
    let info = secure_store::load_setup()?;
    subdomain_of(&info.worker_url)?;
    let bundled = worker_bundle::manifest().worker_version.clone();
    let deployed = crate::cf::api::worker_version(&info.worker_url, &info.auth_token)
        .await
        .unwrap_or(None);
    crate::version::is_behind(deployed.as_deref(), &bundled).then_some(WorkerUpdateInfo {
        deployed_version: deployed,
        available_version: bundled,
    })
}

/// Checks whether the deployed Worker is behind the version this app bundles.
#[tauri::command]
pub async fn worker_update_available(
    session: State<'_, SetupSession>,
) -> Result<Option<WorkerUpdateInfo>, String> {
    Ok(compute_worker_update(session.dry_run).await)
}

/// Launch-time offer: quietly check, and if the Worker is behind, ask with a
/// native dialog. On accept, drop into the Worker-update flow.
pub fn maybe_offer_worker_update(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let dry_run = app.state::<SetupSession>().dry_run;
        let Some(update) = compute_worker_update(dry_run).await else {
            return;
        };
        let message = format!(
            "A newer version of your Second Brain is available (version {}).\n\n\
             Update now? You'll sign in to Cloudflare once. Your memories, password, \
             and connected tools are kept.",
            update.available_version
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(message)
            .title("Update your Second Brain")
            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "Update now".to_string(),
                "Later".to_string(),
            ))
            .show(move |accepted| {
                let _ = tx.send(accepted);
            });
        if rx.await.unwrap_or(false) {
            *app.state::<SetupSession>().pending_worker_update.lock().unwrap() = true;
            let _ = windows::open_setup_window(&app);
        }
    });
}

/// Puts the main window into Worker-update mode and shows it. Called from the
/// launch-time prompt and the Connection details button.
#[tauri::command]
pub fn begin_worker_update(app: AppHandle, session: State<'_, SetupSession>) -> Result<(), String> {
    *session.pending_worker_update.lock().unwrap() = true;
    windows::open_setup_window(&app).map_err(|_| "Couldn't open the update window.".to_string())
}

/// Runs the preserve-everything redeploy. Requires a prior `connect_cloudflare`
/// (so the session holds a Cloudflare token + account list). Resolves the
/// account that hosts the Worker by matching its workers.dev subdomain.
#[tauri::command]
pub async fn start_worker_update(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let manifest = worker_bundle::manifest();

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    if session.dry_run {
        let outcome = ProvisionOutcome {
            worker_url: "https://second-brain.demo.workers.dev".into(),
            mcp_url: "https://second-brain.demo.workers.dev/mcp".into(),
        };
        provision::update_worker(&DryRunBackend, manifest, &outcome.worker_url, "demo", progress)
            .await
            .map_err(|e| {
                log::warn!("dry-run worker update failed: {e}");
                FRIENDLY_RETRY.to_string()
            })?;
        *session.pending_worker_update.lock().unwrap() = false;
        return Ok(outcome);
    }

    let info = secure_store::load_setup().ok_or("This computer isn't set up yet.")?;
    let expected_sub = subdomain_of(&info.worker_url)
        .ok_or("Your Second Brain is on a custom address — update it from your dashboard.")?;
    let mut tokens = session
        .tokens
        .lock()
        .unwrap()
        .clone()
        .ok_or("Please sign in to Cloudflare first.")?;
    if tokens.expires_at <= std::time::Instant::now() {
        tokens = oauth::refresh(&tokens).await.map_err(|e| {
            log::warn!("token refresh failed: {e}");
            "Your Cloudflare sign-in expired. Please sign in again.".to_string()
        })?;
        *session.tokens.lock().unwrap() = Some(tokens.clone());
    }
    let accounts = session.accounts.lock().unwrap().clone();

    // Find the account whose workers.dev subdomain matches the Worker's URL.
    let mut matched: Option<String> = None;
    for account in &accounts {
        let client = CfClient::new(tokens.access_token.clone(), account.id.clone());
        if let Ok(Some(sub)) = client.get_account_subdomain().await {
            if sub == expected_sub {
                matched = Some(account.id.clone());
                break;
            }
        }
    }
    let account_id = matched.ok_or(
        "That Cloudflare account doesn't host this Second Brain. Sign in with the account you set it up in.",
    )?;

    let backend = LiveBackend {
        client: CfClient::new(tokens.access_token.clone(), account_id),
    };
    provision::update_worker(&backend, manifest, &info.worker_url, &info.auth_token, progress)
        .await
        .map_err(|e| {
            log::warn!("worker update failed: {e}");
            FRIENDLY_RETRY.to_string()
        })?;

    *session.pending_worker_update.lock().unwrap() = false;
    Ok(ProvisionOutcome {
        mcp_url: format!("{}/mcp", info.worker_url.trim_end_matches('/')),
        worker_url: info.worker_url,
    })
}

/// Signs this computer out: forgets the saved address + password and returns
/// to the setup flow. The Second Brain itself (and every other device) is
/// untouched. Confirmation happens in the UI before this is invoked.
#[tauri::command]
pub fn logout(app: AppHandle, session: State<'_, SetupSession>) {
    session.reset();
    perform_logout(&app);
}

/// Shared by the `logout` command and the app-menu item (which confirms via a
/// native dialog and has no `State` handle).
pub fn perform_logout(app: &AppHandle) {
    secure_store::clear_setup();
    if let Some(session) = app.try_state::<SetupSession>() {
        session.reset();
    }
    // The wrapper injected the dashboard session into the webview's
    // localStorage — wipe that store too, then close wrapper windows.
    if let Some(w) = app.get_webview_window("brain") {
        let _ = w.clear_all_browsing_data();
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("details") {
        let _ = w.close();
    }
    let _ = windows::open_setup_window(app);
}

#[cfg(test)]
mod tests {
    use super::normalize_worker_url;

    #[test]
    fn normalizes_pasted_addresses() {
        for input in [
            "https://second-brain.demo.workers.dev",
            "second-brain.demo.workers.dev",
            "https://second-brain.demo.workers.dev/",
            "  second-brain.demo.workers.dev/mcp  ",
            "https://second-brain.demo.workers.dev/graph?tab=all",
        ] {
            assert_eq!(
                normalize_worker_url(input).unwrap(),
                "https://second-brain.demo.workers.dev",
                "input: {input:?}"
            );
        }
    }

    #[test]
    fn keeps_explicit_http_and_ports_for_dev_setups() {
        assert_eq!(
            normalize_worker_url("http://localhost:8787/mcp").unwrap(),
            "http://localhost:8787"
        );
    }

    #[test]
    fn rejects_junk() {
        for input in ["", "   ", "not a url at all!", "ftp://x.dev", "mailto:a@b.c"] {
            assert!(normalize_worker_url(input).is_err(), "input: {input:?}");
        }
    }
}
