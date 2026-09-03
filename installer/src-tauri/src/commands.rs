//! Tauri commands — the only bridge between the webview UI and the Rust core.
//! Tokens and passwords flow IN through here (user input / OS keychain) but
//! never back out to the webview; the UI only ever receives URLs, booleans,
//! account names, and progress events.
use crate::cf::api::CfClient;
use crate::cf::backend::{DryRunBackend, LiveBackend};
use crate::cf::discover;
use crate::cf::oauth::{self, Tokens};
use crate::cf::provision::{self, ProvisionError, ProvisionOutcome};
use crate::cf::types::{Account, CfApiError};
use crate::app_menus::AppMenus;
use crate::i18n::{self, AppLocale, Key, Locale};
use crate::rotate::{self, RotateOutcome};
use crate::worker_url::subdomain_of;
use crate::{cli_config, mcp_config, password_check, secure_store, windows, worker_bundle};
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
    /// Set when the main window should boot into the change-your-password flow
    /// (#235, Door A). Mirrors `pending_worker_update` exactly, including being
    /// read before any keychain access — see [`get_app_state`].
    pending_rotation: Mutex<bool>,
    /// Set at launch when the brain refused the password this computer has
    /// stored, which means it was changed somewhere else. The window then asks
    /// for the new one instead of opening a dashboard that only 401s.
    stale_password: Mutex<bool>,
    /// Account id + workers.dev subdomain from the most recent scan, held until
    /// a brain is actually connected. Non-secret, but pointless — and possibly
    /// wrong — to persist for a scan the user abandoned.
    cf_hints: Mutex<Option<(String, String)>>,
    /// Demo mode's stand-in for the outstanding-index note. Dry-run must never
    /// reach the keychain — every read there can raise an OS password prompt,
    /// which is #252 all over again — so the demo keeps its note in memory and
    /// the flow stays exercisable end to end.
    demo_previous_index: Mutex<Option<String>>,
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
            pending_rotation: Mutex::new(false),
            stale_password: Mutex::new(false),
            cf_hints: Mutex::new(None),
            demo_previous_index: Mutex::new(None),
        }
    }

    fn reset(&self) {
        *self.password.lock().unwrap() = None;
        *self.tokens.lock().unwrap() = None;
        self.accounts.lock().unwrap().clear();
        *self.outcome.lock().unwrap() = None;
        *self.pending_worker_update.lock().unwrap() = false;
        *self.pending_rotation.lock().unwrap() = false;
        *self.stale_password.lock().unwrap() = false;
        *self.cf_hints.lock().unwrap() = None;
        *self.demo_previous_index.lock().unwrap() = None;
    }
}

const MIN_PASSWORD_LEN: usize = 12;

fn locale_of(app: &AppHandle) -> Locale {
    app.try_state::<AppLocale>()
        .map(|l| l.get())
        .unwrap_or(Locale::En)
}

fn user_err(locale: Locale, key: Key) -> String {
    i18n::t(locale, key).to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub mode: &'static str,
    pub dry_run: bool,
}

#[tauri::command]
pub fn get_app_state(session: State<'_, SetupSession>) -> AppState {
    AppState {
        mode: app_mode(&session),
        dry_run: session.dry_run,
    }
}

/// Which screen the main window opens on.
///
/// Split out of the command so it can be *run* by a test rather than described
/// by one. A Tauri `State` cannot be constructed in a unit test, and the property
/// this function has to hold — that a demo launch performs zero keychain reads —
/// is only observable by calling the thing that does the work. The source-scanning
/// guard that used to stand in for that ordered three flag names against
/// `load_setup` and said nothing at all about the `dry_run` term, so swapping
/// `!session.dry_run && load_setup().is_some()` for
/// `load_setup().is_some() && !session.dry_run` passed it — and that swap is #252
/// exactly: `&&` short-circuits left to right, so the second form reads the
/// keychain on every demo launch.
fn app_mode(session: &SetupSession) -> &'static str {
    // Dry-run is checked before the keychain read so demo mode never touches
    // secure storage (each read can raise a macOS permission prompt for
    // unsigned dev builds, which would block the setup UI's first paint).
    //
    // Every in-memory flag has to be tested before that read for the same
    // reason, which is why the two #235 modes sit up here with the Worker
    // update rather than beside the branch they most resemble. A demo run
    // reaching `load_setup()` at all is the bug — see #252.
    if *session.pending_rotation.lock().unwrap() {
        "change-password"
    } else if *session.stale_password.lock().unwrap() {
        "stale-password"
    } else if *session.pending_worker_update.lock().unwrap() {
        "worker-update"
    } else if !session.dry_run && secure_store::load_setup().is_some() {
        "wrapper"
    } else {
        "setup"
    }
}

/// Strength + breach check for the password screen. Runs entirely in Rust so
/// the password only crosses the IPC boundary the same way submit does; the
/// breach lookup sends a 5-character hash prefix and nothing else.
#[tauri::command]
pub async fn check_password(password: String) -> Result<password_check::PasswordCheck, String> {
    Ok(password_check::check(password.trim()).await)
}

/// A fresh strong password for the "generate one for me" button.
#[tauri::command]
pub fn generate_password() -> String {
    password_check::generate()
}

#[tauri::command]
pub fn submit_password(
    password: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let trimmed = password.trim();
    if trimmed.len() < MIN_PASSWORD_LEN {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorPasswordTooShort,
            &[("min", &MIN_PASSWORD_LEN.to_string())],
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

    let locale = locale_of(&app);
    let opener_app = app.clone();
    let tokens = oauth::run_login_flow(locale, move |url| {
        let _ = opener_app.opener().open_url(url, None::<&str>);
    })
    .await
    .map_err(|e| {
        log::warn!("oauth flow failed: {e}");
        e.to_string()
    })?;

    let locale = locale_of(&app);
    let accounts = CfClient::list_accounts(&tokens.access_token)
        .await
        .map_err(|e| {
            log::warn!("account listing failed: {e}");
            user_err(locale, Key::ErrorCfAccountListFailed)
        })?;
    if accounts.is_empty() {
        return Err(user_err(locale, Key::ErrorCfNoAccount));
    }

    *session.tokens.lock().unwrap() = Some(tokens);
    *session.accounts.lock().unwrap() = accounts.clone();
    Ok(accounts)
}

/// Looks through a Cloudflare account for Workers that answer like a Second
/// Brain, so the user does not have to find and type their own address.
///
/// Requires a prior [`connect_cloudflare`]. Every probe is unauthenticated —
/// the user's password is not involved and is not asked for until they have
/// picked an address. An empty list is a normal outcome, not an error: it means
/// the account holds no recognisable brain, and the UI falls back to manual
/// entry.
#[tauri::command]
pub async fn discover_brains(
    account_id: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<Vec<discover::Candidate>, String> {
    let locale = locale_of(&app);

    if session.dry_run {
        return Ok(vec![discover::Candidate {
            name: "second-brain".into(),
            url: "https://second-brain.demo.workers.dev".into(),
        }]);
    }

    // Guards against a UI that forgot to sign in, and against an account id the
    // session never saw — the same check start_provisioning makes.
    if !session
        .accounts
        .lock()
        .unwrap()
        .iter()
        .any(|a| a.id == account_id)
    {
        return Err(user_err(locale, Key::ErrorCfSignInFirst));
    }

    let mut tokens = session
        .tokens
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
    if tokens.expires_at <= std::time::Instant::now() {
        tokens = oauth::refresh(&tokens).await.map_err(|e| {
            log::warn!("proactive token refresh failed: {e}");
            user_err(locale, Key::ErrorCfSignInExpired)
        })?;
        *session.tokens.lock().unwrap() = Some(tokens.clone());
    }

    let client = CfClient::new(tokens.access_token.clone(), account_id.clone());

    let manifest = worker_bundle::manifest();
    let found = discover::discover_in_account(
        &client,
        &manifest.script_name,
        &manifest.vectorize_name,
    )
    .await
    .map_err(|e| match e {
        // No workers.dev subdomain means no address to construct, which is a
        // different problem from "found nothing" and gets its own message.
        discover::DiscoverFailure::NoSubdomain => user_err(locale, Key::ErrorCfNoSubdomain),
        discover::DiscoverFailure::Api(err) => {
            log::warn!("brain discovery failed: {err}");
            user_err(locale, Key::ErrorCfDiscoverFailed)
        }
    })?;

    // Held in memory, not written yet. Persisting at scan time would leave a
    // Cloudflare account id in the keychain for someone who signed in, saw
    // nothing, and quit — and would record *this* account even if the user went
    // on to connect a brain living in a different one. connect_existing writes
    // it once a brain is actually connected.
    *session.cf_hints.lock().unwrap() = Some((account_id, found.subdomain.clone()));

    Ok(found.brains)
}

#[tauri::command]
pub async fn start_provisioning(
    account_id: String,
    // The wizard's personal/team fork. Provisioning is identical either way;
    // this only decides what gets recorded alongside the credentials.
    team_mode: Option<bool>,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let locale = locale_of(&app);
    let password = session
        .password
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorChoosePasswordFirst))?;
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
                user_err(locale, Key::ErrorFriendlyRetry)
            })?
    } else {
        let account_name = session
            .accounts
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.name.clone())
            .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
        let mut tokens = session
            .tokens
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;

        // Refresh proactively if the access token already aged out (the user
        // may have sat on the password/progress screens for a while).
        if tokens.expires_at <= std::time::Instant::now() {
            tokens = oauth::refresh(&tokens).await.map_err(|e| {
                log::warn!("proactive token refresh failed: {e}");
                user_err(locale, Key::ErrorCfSignInExpired)
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
                        user_err(locale, Key::ErrorCfSignInExpired)
                    })?;
                    *session.tokens.lock().unwrap() = Some(tokens.clone());
                }
                Err(e) => {
                    log::warn!("provisioning failed: {e}");
                    return Err(format!(
                        "{}\n\n{}",
                        user_err(locale, Key::ErrorFriendlyRetry),
                        i18n::t_fmt(locale, Key::ErrorProvisioningDetail, &[("detail", &e.to_string())])
                    ));
                }
            }
        }
    };

    if !session.dry_run {
        secure_store::save_setup(&outcome.worker_url, &password).map_err(|e| {
            log::error!("secure store save failed: {e}");
            user_err(locale, Key::ErrorSecureStoreSetup)
        })?;
        // The wizard's choice lands beside the credentials it describes, with
        // the same failure handling: without it the Connection window would
        // silently show the wrong surface. connect_existing deliberately never
        // writes this key — a connected brain's mode is unknown.
        let mode = if team_mode.unwrap_or(false) {
            secure_store::MODE_TEAM
        } else {
            secure_store::MODE_PERSONAL
        };
        secure_store::save_team_mode(mode).map_err(|e| {
            log::error!("secure store save failed: {e}");
            user_err(locale, Key::ErrorSecureStoreSetup)
        })?;
    }
    *session.outcome.lock().unwrap() = Some(outcome.clone());
    Ok(outcome)
}

/// Turns whatever the user pasted into a canonical `https://host` origin:
/// tolerates a missing scheme, trailing slashes, and pasted sub-paths
/// (e.g. their /mcp connector link or a dashboard page).
fn normalize_worker_url(input: &str, locale: Locale) -> Result<String, String> {
    let bad = || user_err(locale, Key::ErrorBadUrl);
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(bad());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|_| bad())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(bad());
    }
    // No legitimate Worker address carries credentials — this also catches
    // scheme-ish junk like "mailto:a@b.c" being read as user@host.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(bad());
    }
    let host = parsed.host_str().ok_or_else(bad)?;
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
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let locale = locale_of(&app);
    let worker_url = normalize_worker_url(&address, locale)?;
    let password = password.trim().to_string();
    if password.is_empty() {
        return Err(user_err(locale, Key::ErrorEmptyPassword));
    }

    if !session.dry_run {
        use crate::cf::api::{probe_worker, WorkerProbe};
        match probe_worker(&worker_url, &password).await {
            Ok(WorkerProbe::Valid) => {}
            Ok(WorkerProbe::WrongPassword) => {
                return Err(user_err(locale, Key::ErrorWrongPassword));
            }
            Ok(WorkerProbe::NotABrain) => {
                return Err(user_err(locale, Key::ErrorNotABrain));
            }
            Err(e) => {
                log::warn!("existing-brain probe failed: {e}");
                return Err(user_err(locale, Key::ErrorCantReach));
            }
        }
        secure_store::save_setup(&worker_url, &password).map_err(|e| {
            log::error!("secure store save failed: {e}");
            user_err(locale, Key::ErrorSecureStoreConnect)
        })?;

        // Only now, and only if this brain came from a scan of that account. A
        // failure is not worth surfacing: it costs a lookup later, nothing more.
        let hints = session.cf_hints.lock().unwrap().clone();
        if let Some((account_id, subdomain)) = hints {
            if worker_url.contains(&format!(".{subdomain}.workers.dev")) {
                if let Err(e) = secure_store::save_cf_hints(&account_id, &subdomain) {
                    log::warn!("could not save Cloudflare hints: {e}");
                }
            }
        }
    }

    // This *is* the answer to "your password was changed on another computer"
    // (#235 §5): the stale-password screen's first offer is to enter the new one,
    // and it arrives here. Leaving the flag set means `get_app_state` keeps
    // returning `"stale-password"` after the fix has landed, so the next
    // `begin_worker_update` — or the next launch, before the health check has had
    // a chance to disagree — tells the user again that their password was changed
    // elsewhere, about a password that now works. Only a restart cleared it.
    *session.stale_password.lock().unwrap() = false;

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

/// What the Connections window renders, plus whether this brain was set up for
/// a team — the team card is gated on it. A separate response rather than
/// `ProvisionOutcome`: the mode is read from secure storage at read time and
/// provisioning itself knows nothing about it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDetailsResponse {
    pub worker_url: String,
    pub mcp_url: String,
    /// True only when setup provisioned in team mode. Absent/unknown reads as
    /// false — brains connected without provisioning are personal by default.
    pub team_mode: bool,
}

/// Records the personal/team choice for an ALREADY-CONNECTED brain. The new-
/// brain path writes this inside start_provisioning; connect_existing
/// deliberately does not (a connected brain's mode is unknown), so the wizard
/// asks afterwards and lands here. Cosmetic by design: the v3 Worker
/// provisions tenancy server-side on its own, this only decides what the
/// Connection window tells the owner.
#[tauri::command]
pub fn set_team_mode(
    team_mode: bool,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    // Dry-run never writes secure storage (#252).
    if session.dry_run {
        return Ok(());
    }
    let mode = if team_mode {
        secure_store::MODE_TEAM
    } else {
        secure_store::MODE_PERSONAL
    };
    secure_store::save_team_mode(mode).map_err(|e| {
        log::error!("secure store save failed: {e}");
        user_err(locale_of(&app), Key::ErrorSecureStoreSetup)
    })
}

#[tauri::command]
pub fn get_connection_details(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ConnectionDetailsResponse, String> {
    let outcome = details_from_anywhere(&session)
        .ok_or_else(|| user_err(locale_of(&app), Key::ErrorSetupNotFinished))?;
    // Dry-run never reads secure storage (#252): a demo brain is personal.
    let team_mode = !session.dry_run && secure_store::is_team_mode();
    Ok(ConnectionDetailsResponse {
        worker_url: outcome.worker_url,
        mcp_url: outcome.mcp_url,
        team_mode,
    })
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
pub fn connect_tool(
    tool: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<String, String> {
    let locale = locale_of(&app);
    let tool = mcp_config::Tool::from_id(&tool).ok_or_else(|| user_err(locale, Key::ErrorUnknownTool))?;
    let outcome = details_from_anywhere(&session)
        .ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    let home = dirs::home_dir().ok_or_else(|| user_err(locale, Key::ErrorNoHomeFolder))?;
    if session.dry_run {
        // Demo mode must not touch real tool configs.
        return Ok("(demo) no changes written".into());
    }
    let path = mcp_config::connect(tool, &home, &outcome.mcp_url).map_err(|e| {
        log::warn!("mcp config write failed: {e}");
        user_err(locale, Key::ErrorMcpConfigFailed)
    })?;
    Ok(path.display().to_string())
}

// ── CLI setup ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// The `brain` command already resolves in the user's shell.
    pub installed: bool,
    /// npm resolves, so we can offer to install the CLI for them.
    pub npm_available: bool,
}

/// Resolved through the user's login shell so a GUI-app PATH doesn't hide npm.
#[tauri::command]
pub async fn detect_cli() -> CliStatus {
    // Shelling out can take a beat; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(|| CliStatus {
        installed: cli_config::cli_installed(),
        npm_available: cli_config::npm_available(),
    })
    .await
    .unwrap_or(CliStatus {
        installed: false,
        npm_available: false,
    })
}

/// Writes the CLI's config file so `brain` uses this Second Brain immediately.
/// Reads the Worker URL + token straight from secure storage — they never reach
/// the webview.
#[tauri::command]
pub fn connect_cli(app: AppHandle, session: State<'_, SetupSession>) -> Result<String, String> {
    let locale = locale_of(&app);
    if session.dry_run {
        return Ok("(demo) no changes written".into());
    }
    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    let home = dirs::home_dir().ok_or_else(|| user_err(locale, Key::ErrorNoHomeFolder))?;
    let path = cli_config::write_config(&home, &info.worker_url, &info.auth_token).map_err(|e| {
        log::warn!("cli config write failed: {e}");
        user_err(locale, Key::ErrorCliConfigFailed)
    })?;
    Ok(path.display().to_string())
}

/// Installs the CLI globally via npm through the user's login shell. Best-effort:
/// on failure the config is already written, so the user can install by hand.
#[tauri::command]
pub async fn install_cli(app: AppHandle) -> Result<String, String> {
    if app.state::<SetupSession>().dry_run {
        return Ok("(demo) skipped install".into());
    }
    tauri::async_runtime::spawn_blocking(cli_config::install)
        .await
        .map_err(|_| user_err(locale_of(&app), Key::ErrorInstallInterrupted))?
}

#[tauri::command]
pub fn copy_text(text: String, app: AppHandle) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorClipboardFailed))
}

/// Opens a URL in the default browser (or the Obsidian app for `obsidian://`).
/// Restricted to the destinations the UI legitimately links to — the webview
/// cannot use this to open anything else.
#[tauri::command]
pub fn open_external(url: String, app: AppHandle) -> Result<(), String> {
    let allowed = url.starts_with("https://chatgpt.com/")
        || url.starts_with("https://claude.ai/")
        || url.starts_with("https://github.com/rahilp/")
        || url.starts_with("https://community.obsidian.md/")
        || url.starts_with("obsidian://")
        || url.starts_with("mailto:");
    if !allowed {
        return Err(user_err(locale_of(&app), Key::ErrorLinkNotAllowed));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorOpenBrowserFailed))
}

// ── Guided integrations (extension / Obsidian / Notion) ───────────────────────

/// Obsidian's per-user config lists the user's vaults; its presence (or the
/// installed app on macOS) means Obsidian has run here. Best-effort only.
#[tauri::command]
pub fn detect_obsidian() -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(target_os = "macos")]
    let candidates = [
        home.join("Library/Application Support/obsidian/obsidian.json"),
        std::path::PathBuf::from("/Applications/Obsidian.app"),
    ];
    #[cfg(target_os = "windows")]
    let candidates = [dirs::config_dir()
        .unwrap_or_default()
        .join("obsidian")
        .join("obsidian.json")];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates = [home.join(".config/obsidian/obsidian.json")];
    candidates.iter().any(|p| p.exists())
}

/// Mirrors the worker's `GET /integrations` entry shape. The token is never
/// part of it — status only.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub provider: String,
    pub name: String,
    pub connected: bool,
    /// Settings-UI grouping id (knowledge / calendar / email). Used to group the
    /// desktop list the same way the dashboard groups its own.
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default)]
    pub item_count: Option<i64>,
}

/// Reads connection status for every integration from the user's own Worker.
#[tauri::command]
pub async fn integration_status(app: AppHandle) -> Result<Vec<IntegrationStatus>, String> {
    if app.state::<SetupSession>().dry_run {
        let demo = |provider: &str, name: &str, category: &str, connected: bool| IntegrationStatus {
            provider: provider.into(),
            name: name.into(),
            connected,
            category: Some(category.into()),
            workspace_name: None,
            last_synced_at: None,
            item_count: None,
        };
        return Ok(vec![
            demo("notion", "Notion", "knowledge", false),
            demo("calendar-google", "Google Calendar", "calendar", true),
            demo("calendar-outlook", "Outlook Calendar", "calendar", false),
            demo("calendar-icloud", "iCloud Calendar", "calendar", false),
            demo("email-gmail", "Gmail", "email", true),
            demo("email-icloud", "iCloud Mail", "email", false),
        ]);
    }
    let locale = locale_of(&app);
    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    let worker = info.worker_url.trim_end_matches('/');
    let resp = reqwest::Client::new()
        .get(format!("{worker}/integrations"))
        .bearer_auth(&info.auth_token)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            log::warn!("integrations fetch failed: {e}");
            user_err(locale, Key::ErrorReachBrain)
        })?;
    if !resp.status().is_success() {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorBrainHttpStatus,
            &[("status", &resp.status().as_u16().to_string())],
        ));
    }
    #[derive(serde::Deserialize)]
    struct Wrapper {
        integrations: Vec<IntegrationStatus>,
    }
    let body: Wrapper = resp
        .json()
        .await
        .map_err(|_| user_err(locale, Key::ErrorBrainUnexpected))?;
    Ok(body.integrations)
}

/// Runs Notion sync to completion against a Worker. The endpoint syncs one
/// bounded batch per call and reports `remaining`, so this loops until it drains
/// (capped so a runaway can't spin forever). Reusable by the command and the
/// menu-bar action.
pub async fn notion_sync(
    worker_url: &str,
    auth_token: &str,
    locale: Locale,
) -> Result<String, String> {
    let worker = worker_url.trim_end_matches('/');
    let client = reqwest::Client::new();
    let mut changed = 0i64;
    for _ in 0..30 {
        let resp = client
            .post(format!("{worker}/integrations/notion/sync"))
            .bearer_auth(auth_token)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| {
                log::warn!("notion sync failed: {e}");
                user_err(locale, Key::ErrorReachBrain)
            })?;
        let ok_status = resp.status().is_success();
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if !ok_status || body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let err = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or(i18n::t(locale, Key::ErrorNotionSyncFailed));
            return Err(err.to_string());
        }
        let field = |k: &str| body.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        changed += field("created") + field("updated") + field("deleted");
        if field("remaining") <= 0 {
            break;
        }
    }
    Ok(if changed > 0 {
        i18n::t_fmt(
            locale,
            Key::ErrorNotionSynced,
            &[("count", &changed.to_string())],
        )
    } else {
        user_err(locale, Key::ErrorNotionUpToDate)
    })
}

/// Runs Notion sync to completion.
#[tauri::command]
pub async fn sync_notion(app: AppHandle) -> Result<String, String> {
    let locale = locale_of(&app);
    if app.state::<SetupSession>().dry_run {
        return Ok(user_err(locale, Key::ErrorNotionUpToDate));
    }
    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
    notion_sync(&info.worker_url, &info.auth_token, locale).await
}

/// Opens the dashboard and drops the user straight into the Integrations panel.
/// If the dashboard is already open, just opens the panel there.
///
/// `async` on purpose: on Windows, `WebviewWindowBuilder::build` deadlocks when
/// called from a synchronous Tauri command (wry#583) — the command holds the
/// WebView2 UI thread that the new window needs to finish creating, so the app
/// goes Not Responding with an unpainted window. Menu/tray paths call the
/// window helpers from the event loop and stay sync.
#[tauri::command]
pub async fn open_dashboard_integrations(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let (worker_url, token) = if session.dry_run {
        let outcome = details_from_anywhere(&session)
            .ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
        (outcome.worker_url, "demo".to_string())
    } else {
        let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorSetupNotFinished))?;
        (info.worker_url, info.auth_token)
    };
    windows::open_wrapper_window_integrations(&app, &worker_url, &token)
        .map_err(|_| user_err(locale, Key::OpenDashboardFailed))?;
    close_setup_windows(&app);
    Ok(())
}

fn dashboard_credentials(
    session: &SetupSession,
    locale: Locale,
) -> Result<(String, String), String> {
    if session.dry_run {
        // No keychain read, and no connected-yet check.
        //
        // This used to call details_from_anywhere, which falls back to
        // secure_store::load_setup() when the session has no outcome — so opening
        // the settings window in demo mode raised an OS keychain password prompt.
        // That is the same class of bug as #252, and it is why the window never
        // worked in demo mode: the prompt appeared before any request was made.
        //
        // The check itself does not apply here either. In a real run it asks "is
        // this computer connected to a brain yet?"; in demo mode the local demo
        // brain *is* the brain, always present, so there is nothing to refuse.
        // The local demo brain, not `second-brain.demo.workers.dev`: that address
        // does not resolve, so every Worker-backed screen failed with "Couldn't
        // reach your Second Brain". Pointing at a real server on loopback means
        // settings and migration run their actual HTTP paths against real data.
        //
        // The password is asked of the brain rather than written here as a
        // literal. A real run re-reads it from the keychain, which a rotation has
        // just updated; demo mode has no keychain, so the equivalent is to ask
        // the demo brain what it currently answers to. With the literal in place
        // every settings and dashboard window 401s for the rest of the run the
        // moment a demo rotation happens — which is the whole flow this is meant
        // to make demonstrable.
        Ok((crate::demo_brain::base_url(), crate::demo_brain::auth_token()))
    } else {
        let info = secure_store::load_setup()
            .ok_or_else(|| user_err(locale, Key::OpenDashboardNotSetup))?;
        Ok((info.worker_url, info.auth_token))
    }
}

/// Opens the dashboard wrapper, closing setup/details windows on success.
pub fn open_dashboard_impl(app: &AppHandle, session: &SetupSession) -> Result<(), String> {
    let locale = locale_of(app);
    let (worker_url, token) = dashboard_credentials(session, locale)?;
    windows::open_wrapper_window(app, &worker_url, &token)
        .map_err(|_| user_err(locale, Key::OpenDashboardFailed))?;
    // Reaching the dashboard is how a password change is abandoned — "Not now"
    // on the change-password screen lands exactly here, and the setup window is
    // closed on the next line.
    //
    // Cleared because `pending_rotation` was otherwise only unset on success or
    // on logout, and `get_app_state` consults it first: the flag survived, so the
    // next "Update your Second Brain" opened the *password-change* flow instead
    // of the update, and nothing short of restarting the app put it right.
    //
    // `stale_password` is deliberately not cleared here. That flag records
    // something about the brain — that the password this computer holds no longer
    // opens it — and walking over to the dashboard does not make it untrue. It is
    // cleared where it is actually resolved: `connect_existing` and a completed
    // rotation.
    clear_pending_rotation(session);
    close_setup_windows(app);
    Ok(())
}

/// Leaves the change-your-password flow without having changed anything.
///
/// One function rather than an assignment at each exit, because the flag is read
/// by `app_mode` ahead of every other mode: an exit that forgets to clear it does
/// not fail, it silently redirects the *next* thing the user asks for.
fn clear_pending_rotation(session: &SetupSession) {
    *session.pending_rotation.lock().unwrap() = false;
}

fn close_setup_windows(app: &AppHandle) {
    for label in ["main", "details"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
}

/// IPC entry for opening the dashboard after setup ("Apri il mio Second Brain").
///
/// Must stay `async`: a sync command runs on the WebView2 UI thread on Windows,
/// and `WebviewWindowBuilder::build` then deadlocks waiting for that same thread
/// (wry#583) — blank window, Not Responding. `open_dashboard_impl` remains sync
/// for menu/tray, which are dispatched from the event loop instead of IPC.
#[tauri::command]
pub async fn open_dashboard(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    open_dashboard_impl(&app, &session)
}

#[tauri::command]
pub fn set_locale(locale: String, app: AppHandle) -> Result<(), String> {
    let locale = Locale::parse(&locale).ok_or_else(|| "Invalid locale".to_string())?;
    if let Ok(config) = app.path().app_config_dir() {
        let _ = i18n::write_stored_locale(&config, locale);
    }
    if let Some(state) = app.try_state::<AppLocale>() {
        state.set(locale);
    }
    if let Some(menus) = app.try_state::<AppMenus>() {
        menus.apply_locale(&app, locale);
        menus.rebuild_tray_menu(&app).map_err(|e| e.to_string())?;
    }
    // Push the new language into an already-open dashboard window. Without this,
    // changing Language in Settings left the brain webview on the old locale
    // until the window was destroyed and recreated.
    if let Ok((worker_url, _)) = dashboard_credentials(&app.state::<SetupSession>(), locale) {
        windows::sync_brain_locale(&app, &worker_url, locale, true);
    }
    Ok(())
}

/// Opens the native Connections window. `async` so IPC creation cannot deadlock
/// WebView2 on Windows the way a sync command + `WebviewWindowBuilder::build`
/// does (wry#583); menu/tray keep calling `windows::open_details_window` sync.
#[tauri::command]
pub async fn open_details_window(app: AppHandle) {
    windows::open_details_window(&app);
}

// ── Worker update ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkerUpdateInfo {
    pub deployed_version: Option<String>,
    pub available_version: String,
}

/// What the one authenticated request the app makes at launch found out.
enum LaunchCheck {
    /// Nothing worth interrupting the user for: up to date, unknown, offline,
    /// on a custom domain, in dry-run, or not set up.
    Nothing,
    Update(WorkerUpdateInfo),
    /// The brain refused the password this computer has stored, which means it
    /// was changed somewhere else (#235 §5). Until now this was discarded, and
    /// the user got a dashboard that silently 401ed with no route back except
    /// Disconnect.
    StalePassword,
}

/// The launch-time probe. One authenticated `GET /health`, and both facts come
/// out of it — the deployed version, and whether this computer's password still
/// opens the brain at all.
async fn launch_check(dry_run: bool) -> LaunchCheck {
    if dry_run {
        return LaunchCheck::Nothing;
    }
    let Some(info) = secure_store::load_setup() else {
        return LaunchCheck::Nothing;
    };

    // The request is made before the workers.dev check, not after.
    //
    // The custom-domain early-out exists because such a brain cannot be updated
    // from here — but it can certainly have had its password changed on another
    // computer, and its owner deserves the same screen. The cost is one GET at
    // launch for custom-domain users, who previously skipped it.
    let deployed = match crate::cf::api::worker_version(&info.worker_url, &info.auth_token).await {
        Ok(version) => version,
        // The brain refused this computer's password — a password problem, not
        // a Cloudflare one. `Unauthorized` here would mean the *Cloudflare* API
        // rejected the request, which is an `Err(e)` like any other.
        Err(CfApiError::WorkerAuthRejected) => return LaunchCheck::StalePassword,
        // Offline, or a brain having a moment. Neither is a password problem, and
        // telling someone their password changed because their wifi dropped is
        // worse than saying nothing at all.
        Err(e) => {
            log::debug!("launch health check could not reach the brain: {e}");
            return LaunchCheck::Nothing;
        }
    };

    if subdomain_of(&info.worker_url).is_none() {
        return LaunchCheck::Nothing;
    }
    let bundled = worker_bundle::manifest().worker_version.clone();
    if crate::version::is_behind(deployed.as_deref(), &bundled) {
        LaunchCheck::Update(WorkerUpdateInfo {
            deployed_version: deployed,
            available_version: bundled,
        })
    } else {
        LaunchCheck::Nothing
    }
}

/// Core check, usable outside a command context (the launch-time offer). None
/// when up to date, unknown, on a custom domain, in dry-run, or not set up.
async fn compute_worker_update(dry_run: bool) -> Option<WorkerUpdateInfo> {
    match launch_check(dry_run).await {
        LaunchCheck::Update(info) => Some(info),
        LaunchCheck::Nothing | LaunchCheck::StalePassword => None,
    }
}

/// Checks whether the deployed Worker is behind the version this app bundles.
#[tauri::command]
pub async fn worker_update_available(
    session: State<'_, SetupSession>,
) -> Result<Option<WorkerUpdateInfo>, String> {
    Ok(compute_worker_update(session.dry_run).await)
}

/// Whether the Worker-update prompt is this user's to see.
///
/// Pure, so the rule is testable without a keychain or a network — the two
/// facts it needs are gathered by [`worker_update_is_offerable`] below.
///
/// The prompt leads to `start_worker_update`, which resolves the hosting
/// account by matching the brain's workers.dev subdomain against the signed-in
/// Cloudflare session and answers `ErrorWrongCfAccount` to anyone else. So the
/// question is not "may this person administer the brain" — a team admin may,
/// and still cannot do this — it is "does this person hold the Cloudflare
/// account the Worker is deployed into". Only `owner` answers that.
///
/// A one-person brain is exempt and asks nothing: its owner is whoever holds
/// the token, there is nobody else on it to mislead, and a Worker old enough to
/// be behind may well predate `/team/me` entirely.
///
/// A LEGACY Worker — one that answered but predates the `owner` key — is the
/// third case, and it is offered the prompt. On its own, `probe.owner` is a
/// deadlock: this app self-updates from GitHub Releases and the Worker can only
/// be updated FROM this app, so a brain deployed before the key would never be
/// offered the update that adds the key. The prompt still dead-ends at
/// `ErrorWrongCfAccount` for anyone who does not hold the hosting account, so
/// the allowance costs a member one dismissible dialog until the owner updates
/// once — and after that one update this arm is unreachable forever.
fn update_prompt_is_offerable(team_brain: bool, probe: &ConnectionRoleProbe) -> bool {
    if !team_brain {
        return true;
    }
    // Not `role == "admin"`, and not "could not tell" either. Least privilege:
    // being wrong this way costs an owner one click in the tray window; being
    // wrong the other way nags every member on every launch, forever, for an
    // action that cannot succeed.
    //
    // `legacy_worker` is the one documented exception, and it is NOT "could not
    // tell": it is a brain that answered and whose answer is missing the key.
    // A probe that failed leaves both of these false.
    probe.owner || probe.legacy_worker
}

/// The two facts [`update_prompt_is_offerable`] needs, gathered.
///
/// A solo install makes no request at all, so its launch is what it always was.
async fn worker_update_is_offerable() -> bool {
    if !secure_store::is_team_mode() {
        return true;
    }
    let Some(info) = secure_store::load_setup() else {
        return false;
    };
    let probe = fetch_connection_role(&info.worker_url, &info.auth_token).await;
    update_prompt_is_offerable(true, &probe)
}

/// Launch-time check on the brain this computer is connected to.
///
/// Two outcomes are worth interrupting for: the Worker is behind the bundled
/// version (ask, with a native dialog), or the stored password no longer opens
/// the brain (#235 §5 — show the screen that asks for the new one).
pub fn check_brain_at_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let locale = locale_of(&app);
        let dry_run = app.state::<SetupSession>().dry_run;
        let update = match launch_check(dry_run).await {
            LaunchCheck::Nothing => return,
            LaunchCheck::StalePassword => {
                show_stale_password(&app);
                return;
            }
            LaunchCheck::Update(update) => update,
        };
        // After the stale-password arm, deliberately: a password changed on
        // another computer is a real problem and it is the member's own to
        // fix, so that screen reaches everyone. This one does not.
        if !worker_update_is_offerable().await {
            log::info!(
                "the deployed Worker is behind, but this computer's token does not own the \
                 deployment — no update prompt"
            );
            return;
        }
        let message = i18n::t_fmt(
            locale,
            Key::WorkerUpdateMessage,
            &[("version", &update.available_version)],
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(message)
            .title(i18n::t(locale, Key::WorkerUpdateTitle))
            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                i18n::t(locale, Key::AppUpdateNow).to_string(),
                i18n::t(locale, Key::AppUpdateLater).to_string(),
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

/// Routes a launch that found a dead password to the screen that asks for the
/// new one.
///
/// In place of the wrapper window, not beside it. The dashboard behind it can
/// only 401, and leaving it up would mean explaining the problem through a broken
/// page — which until now was the entire experience of having your password
/// changed on another computer: a silently failing window and no route back
/// except Disconnect.
fn show_stale_password(app: &AppHandle) {
    *app.state::<SetupSession>().stale_password.lock().unwrap() = true;
    if let Some(window) = app.get_webview_window("brain") {
        let _ = window.close();
    }
    let _ = windows::open_setup_window(app);
}

/// Puts the main window into Worker-update mode and shows it. Called from the
/// launch-time prompt and the Connection details button.
///
/// `async` so the IPC handler does not run `WebviewWindowBuilder::build` on the
/// WebView2 UI thread (wry#583).
#[tauri::command]
pub async fn begin_worker_update(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    *session.pending_worker_update.lock().unwrap() = true;
    windows::open_setup_window(&app)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorOpenWindowFailed))
}

/// Runs the preserve-everything redeploy. Requires a prior `connect_cloudflare`
/// (so the session holds a Cloudflare token + account list). Resolves the
/// account that hosts the Worker by matching its workers.dev subdomain.
#[tauri::command]
pub async fn start_worker_update(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<ProvisionOutcome, String> {
    let locale = locale_of(&app);
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
        provision::update_worker(
            &DryRunBackend,
            manifest,
            &outcome.worker_url,
            // Not the literal "demo": an update's health poll is made with the
            // password the app already holds, and after a demo rotation that is
            // no longer the default. A 401 there is terminal (it means a redeploy
            // dropped the secret), so a hard-coded token turns every demo update
            // after a demo rotation into a reported failure.
            &crate::demo_brain::auth_token(),
            provision::VectorizeTarget::shipped(manifest),
            progress,
        )
            .await
            .map_err(|e| {
                log::warn!("dry-run worker update failed: {e}");
                user_err(locale, Key::ErrorFriendlyRetry)
            })?;
        *session.pending_worker_update.lock().unwrap() = false;
        return Ok(outcome);
    }

    let info = secure_store::load_setup().ok_or_else(|| user_err(locale, Key::ErrorComputerNotSetup))?;

    // Resolving which Cloudflare account holds this brain used to be written out
    // here as well as in `cloudflare_client_for_brain`. It now has a third caller
    // (`rotate_password`), and three copies of "match the address's subdomain
    // against every signed-in account" is three places for #257 to come back.
    let backend = LiveBackend {
        client: cloudflare_client_for_brain(&info.worker_url, &session, locale).await?,
    };
    // A routine update stays on whatever index this build ships with. Only an
    // embedding migration moves it, and that goes through its own command.
    provision::update_worker(
        &backend,
        manifest,
        &info.worker_url,
        &info.auth_token,
        provision::VectorizeTarget::shipped(manifest),
        progress,
    )
        .await
        .map_err(|e| {
            log::warn!("worker update failed: {e}");
            match e {
                // Permanent, so "try again" would be a lie. Reachable only if the
                // subdomain check above is ever removed — the message is right
                // either way.
                ProvisionError::NotAWorkersDevAddress => user_err(locale, Key::ErrorCustomDomain),
                // The updated brain refused the password this computer kept.
                // "Nothing is lost, try again" would be the one thing worse than
                // silence here: the likeliest cause is a password changed on
                // another device, and retrying an update cannot fix that.
                ProvisionError::WorkerAuthRejected => {
                    user_err(locale, Key::ErrorBrainRefusedPassword)
                }
                _ => user_err(locale, Key::ErrorFriendlyRetry),
            }
        })?;

    *session.pending_worker_update.lock().unwrap() = false;
    Ok(ProvisionOutcome {
        mcp_url: format!("{}/mcp", info.worker_url.trim_end_matches('/')),
        worker_url: info.worker_url,
    })
}

// ── Changing the password (#235) ─────────────────────────────────────────────

/// Why a password change did not finish, in the only shapes that differ in what
/// may honestly be said afterwards.
///
/// `Result<(), String>` is not sufficient here, and that is load-bearing rather
/// than fastidious. A string cannot separate "the change never reached
/// Cloudflare, so your old password still works" from "the change was accepted
/// and never confirmed, so your new password may already be the only one that
/// opens your brain". Those are opposite instructions. With one string every
/// failure has to hedge — so a user whose Cloudflare sign-in merely expired is
/// told their password may already have changed, which teaches people to
/// disbelieve that warning on the one occasion it is real.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateError {
    /// Selects the screen, and with it what may be claimed:
    ///   `"notSent"`     — nothing reached Cloudflare; the old password still works.
    ///   `"unconfirmed"` — the secret may have been accepted; health never went
    ///                     green. Never tell the user the old password still works.
    ///   `"blocked"`     — refused on purpose, with somewhere to go. Nothing was
    ///                     sent, but "try again" is the wrong offer.
    ///   `"local"`       — the brain has the new password; a local write failed.
    pub stage: &'static str,
    /// Already localised; rendered into the failure screen's detail slot rather
    /// than being the screen. Bare text — the "What went wrong: …" framing is the
    /// front end's.
    pub detail: String,
}

impl RotateError {
    fn not_sent(detail: String) -> Self {
        Self { stage: "notSent", detail }
    }
    fn unconfirmed(detail: String) -> Self {
        Self { stage: "unconfirmed", detail }
    }
    /// A refusal this app made on purpose, with a route out of it.
    ///
    /// Its own stage rather than a `notSent` with an unusual detail. `notSent`'s
    /// screen is "Nothing was changed / Try again", and for a rebuild that is in
    /// flight *every part of that is wrong*: trying again in ten seconds fails the
    /// same way, the real instruction (wait, or reset the rebuild from Advanced
    /// Settings) arrives as a footnote under a button that will not work, and an
    /// abandoned ledger blocks rotation permanently with no escape offered at all.
    fn blocked(detail: String) -> Self {
        Self { stage: "blocked", detail }
    }
    fn local(detail: String) -> Self {
        Self { stage: "local", detail }
    }
}

/// Maps a `rotate_secret` failure onto what the user may honestly be told.
///
/// The dividing line is `put_secret`, not the error's variant, and every caller
/// of this function is downstream of `rotate_secret` — so the question is only
/// ever "was the PUT entered before this was raised?".
///
/// `NotAWorkersDevAddress` is the one failure raised before it: the script name is
/// derived from the address first, precisely so a custom-domain brain is refused
/// without a half-started progress screen. Everything else comes out of
/// `put_secret` or the health poll that follows it.
///
/// **Which is why the old catch-all was wrong.** It sent `CfApiError::Network`
/// and `Http` to `notSent`, whose screen states in as many words that the old
/// password still works and everything is exactly as it was. `send_impl` returns
/// `Network` only after exhausting its retries, which includes the case where the
/// PUT reached Cloudflare and only the *response* was lost — and `Http` is an
/// unparseable body, which can arrive with any status at all. Neither supports a
/// positive claim about remote state.
///
/// `Unauthorized` is the one that looks safe and is not. A 401 is an authorization
/// decision made before the secrets handler runs, so *that attempt* changed
/// nothing — but `send_impl` retries, and a first attempt that died on the wire
/// with the PUT already applied, followed by a retry that 401s on an access token
/// that expired in between, produces exactly this error over a brain whose
/// password has already moved.
///
/// The asymmetry decides the doubtful cases. A wrong `unconfirmed` shows the
/// password with "this may already be live, save it" and a re-check button that
/// settles it in one request. A wrong `notSent` tells someone their old password
/// still works, so they close the window without saving the new one, and the next
/// launch locks them out of their own brain with nothing left to recover from.
///
/// Matched exhaustively on purpose. A new `ProvisionError` variant should not
/// quietly inherit a default here; it should stop the build until someone decides
/// which side of the PUT it is raised on.
fn rotation_failure(error: ProvisionError, locale: Locale) -> RotateError {
    match error {
        // Refused before the PUT, by the same #257 guard the update path uses —
        // and the only failure in `rotate_secret` that is.
        ProvisionError::NotAWorkersDevAddress => {
            RotateError::not_sent(user_err(locale, Key::ErrorCustomDomain))
        }
        ProvisionError::HealthCheckFailed | ProvisionError::WorkerAuthRejected => {
            RotateError::unconfirmed(user_err(locale, Key::ErrorRotateNotConfirmed))
        }
        // From `put_secret`. The detail still names the real cause — the stage
        // says what may be claimed, the detail says what went wrong, and those
        // are different questions.
        ProvisionError::Api(CfApiError::Unauthorized) => {
            RotateError::unconfirmed(user_err(locale, Key::ErrorCfSignInExpired))
        }
        ProvisionError::Api(_) => {
            RotateError::unconfirmed(user_err(locale, Key::ErrorRotateNotConfirmed))
        }
        // Not reachable from `rotate_secret`, which neither captures nor registers
        // a subdomain. Listed rather than swept into a `_` so the exhaustiveness
        // above is real, and sent to `unconfirmed` because an unreachable arm that
        // becomes reachable should fail towards the claim that cannot lock anyone
        // out.
        ProvisionError::CaptureFailed | ProvisionError::SubdomainUnavailable => {
            RotateError::unconfirmed(user_err(locale, Key::ErrorRotateNotConfirmed))
        }
    }
}

/// How much of a failure a log line is allowed to carry.
///
/// `CfApiError::Http` holds up to 600 characters of whatever Cloudflare returned
/// when the body would not parse, and `{e}` on a `ProvisionError` renders all of
/// it. A password change is exactly the moment a user is likeliest to be asked
/// for their log, so one failure pasting most of an edge error page — request
/// ids, ray ids, whatever else the response echoed — into it is both unreadable
/// and more than they meant to share.
const LOG_DETAIL_MAX: usize = 160;

/// Trims a diagnostic to [`LOG_DETAIL_MAX`] characters, on a character boundary,
/// and says how much it dropped so a truncated line is never mistaken for the
/// whole story.
fn for_log(detail: impl std::fmt::Display) -> String {
    let text = detail.to_string();
    match text.char_indices().nth(LOG_DETAIL_MAX) {
        None => text,
        Some((cut, _)) => {
            let dropped = text.chars().count() - LOG_DETAIL_MAX;
            format!("{}… (+{dropped} more characters)", &text[..cut])
        }
    }
}

/// Normalises an address typed into the rotation flow, and refuses cleartext.
///
/// `normalize_worker_url` keeps a scheme the user typed, and `worker_url::labels`
/// accepts `http` — both on purpose, for `http://localhost:8787` dev setups, and
/// both wrong on this path. A rotation is the one operation that sends a password
/// the user has never used before as a bearer token, and then *stores* the origin
/// it sent it to: the keychain and the plaintext CLI config both take it, so a
/// single mistyped `http://` makes every later request from the app and from the
/// `brain` command cleartext too, indefinitely. `reqwest` does no HSTS, so nothing
/// downstream will upgrade it.
///
/// Only the typed address goes through here. A Door A address came out of this
/// app's own secure storage, where it was written after a successful connection,
/// and demo mode runs against a loopback brain that has no certificate — neither
/// is a user typing a scheme they did not think about.
fn rotation_address(input: &str, locale: Locale) -> Result<String, String> {
    let normalized = normalize_worker_url(input, locale)?;
    let scheme = url::Url::parse(&normalized)
        .map(|u| u.scheme().to_string())
        .unwrap_or_default();
    if scheme != "https" {
        // Not ErrorBadUrl: `http://my-brain.acme.workers.dev` is a perfectly good
        // address, and telling someone it does not look like one sends them
        // hunting for a typo that is not there. The problem is the scheme, and
        // the reason is worth stating — this is the one path that would put a
        // brand-new password on the wire in the clear.
        return Err(user_err(locale, Key::ErrorRotateNeedsHttps));
    }
    Ok(normalized)
}

/// The address a rotation should act on, and the password this computer already
/// holds for it — `None` when it holds none.
///
/// `address` is Door B: the user has lost their password, so there may be nothing
/// in secure storage to resolve and the address comes from Cloudflare discovery
/// instead. There is then no current password, which is precisely why every check
/// that needs one is skipped for that door rather than failed.
///
/// Absent, this is Door A on a computer that is already connected, and the
/// address is resolved the way every other settings command resolves it: through
/// `dashboard_credentials`, never `secure_store::load_setup()` directly, because
/// that ignores dry-run and raises a Keychain prompt (#252).
///
/// Takes the session rather than the `AppHandle` it could pull the session out
/// of, so it can be driven by a test — the cleartext refusal above is the sort of
/// rule that is easy to write and easy to delete.
fn rotation_target(
    session: &SetupSession,
    locale: Locale,
    address: Option<String>,
) -> Result<(String, Option<String>), String> {
    match address {
        Some(address) => Ok((rotation_address(&address, locale)?, None)),
        None => {
            let (url, token) = dashboard_credentials(session, locale)?;
            Ok((url, Some(token)))
        }
    }
}

/// Every Vectorize index name a brain built by this app could legitimately be
/// bound to.
///
/// The shipped name, plus the one an embedding migration would have moved it to
/// for each reading this build knows about (#248 names indexes by dimension
/// count). Without the migrated names a user who has changed how their brain
/// reads would be told their own brain is not a brain.
fn brain_index_names() -> Vec<String> {
    let manifest = worker_bundle::manifest();
    let mut names = vec![manifest.vectorize_name.clone()];
    for choice in crate::migration::EMBEDDING_MODELS {
        let name = crate::migration::index_name_for(
            &manifest.vectorize_name,
            choice.dimensions,
            manifest.vectorize_dimensions,
        );
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Confirms the Worker at `worker_url` really is a Second Brain, from its
/// Cloudflare bindings rather than from anything it says over HTTP.
///
/// This is the #247 rule, and rotation needs it more sharply than discovery did.
/// In lost mode the user types an address, and the Cloudflare account match
/// cannot catch a typo that lands on a *different Worker of their own* — that
/// script is in the right account, so the only thing left to check is what it is.
/// Getting it wrong would overwrite an unrelated Worker's `AUTH_TOKEN` secret
/// while telling the user their brain's password had changed: the brain stays on
/// the old password, and something they did not name has been altered.
///
/// Bindings and not a probe, for the reason `cf/discover.rs` sets out at length:
/// a Worker authors every byte of its own HTTP responses and can forge whatever
/// a probe looks for, but it cannot forge account state.
async fn confirm_target_is_a_brain(
    worker_url: &str,
    session: &SetupSession,
    locale: Locale,
) -> Result<(), String> {
    use provision::Backend;

    let script = crate::worker_url::script_of(worker_url)
        .ok_or_else(|| user_err(locale, Key::ErrorCustomDomain))?;

    let bindings = if session.dry_run {
        DryRunBackend.get_script_bindings(&script).await
    } else {
        cloudflare_client_for_brain(worker_url, session, locale)
            .await?
            .get_script_bindings(&script)
            .await
    }
    .map_err(|e| {
        // A script that does not exist answers the same way as one that cannot
        // be read. Both mean "there is no brain of yours at that address", which
        // is what the user needs to know and can act on.
        log::warn!("could not read the bindings for {script}: {e}");
        user_err(locale, Key::ErrorNotABrain)
    })?;

    bindings_are_a_brains(&bindings, locale)
}

/// The #247 decision itself, over bindings that have already been read.
///
/// Split from the fetch above so a test can drive it, on the
/// `blocked_by_migration` precedent. Every backend reachable from a test answers
/// `get_script_bindings` with a brain's bindings — the live one needs a real
/// Cloudflare account, and the dry-run one describes the demo brain — so with
/// the decision inline the *refusal* had no way of being exercised at all, and
/// replacing the whole of it with `Ok(())` passed the entire suite.
///
/// What that mutation ships is the harm the caller's doc describes: a Door B
/// typo that lands on a different Worker of the user's own is in the right
/// Cloudflare account, so nothing else in the flow can catch it, and it has its
/// `AUTH_TOKEN` overwritten while the user is told their brain's password
/// changed.
fn bindings_are_a_brains(bindings: &[serde_json::Value], locale: Locale) -> Result<(), String> {
    brain_index_names()
        .iter()
        .any(|name| discover::bindings_look_like_a_brain(bindings, name))
        .then_some(())
        .ok_or_else(|| user_err(locale, Key::ErrorNotABrain))
}

/// Checks an address typed in lost mode before anything is done to it.
///
/// Exists so §2.4's screen can report a bad address where it was entered instead
/// of failing several screens later, and it is the same check `rotate_password`
/// runs on an explicit address — one implementation, two callers, so the screen
/// cannot pass something the command would then refuse.
#[tauri::command]
pub async fn validate_brain_address(
    address: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    // Through `rotation_address`, which is the general normaliser plus this
    // path's refusal of cleartext. The screen has to refuse exactly what the
    // command would refuse, or it waves an address through to the place where
    // the user has already committed to it.
    let worker_url = rotation_address(&address, locale)?;
    confirm_target_is_a_brain(&worker_url, &session, locale).await
}

/// Revokes every access an AI tool was granted through `/oauth/authorize`.
///
/// Deliberately separate from rotation rather than part of it. Those tools hold
/// provider-issued tokens validated against KV, not the brain's password, so a
/// rotation genuinely does not reach them — which is right for a hygiene change
/// and wrong for a leak. Making it explicit is what lets the done screen tell the
/// truth about what a rotation did and did not close.
///
/// The Worker's `{ ok, revoked, failed }` is passed straight through: `failed` is
/// the case this control exists for, and summarising it away would hide a tool
/// that kept its access.
#[tauri::command]
pub async fn disconnect_ai_tools(app: AppHandle) -> Result<serde_json::Value, String> {
    let (worker_url, token, locale) = settings_target(&app)?;
    revoke_all_tools(&worker_url, &token, locale).await
}

/// The request [`disconnect_ai_tools`] makes, split out so it can be driven by a
/// test — the command takes an `AppHandle`, which no unit test can construct, and
/// this is the whole of what it does.
///
/// `bearer_auth` is not decoration. `/oauth/revoke-all` is guarded like every
/// other route on the brain, so without the brain's password the Worker answers
/// 401 and the button reports a failure for a door it never asked to close. It
/// fails safe, which is why it had no test and why it is the last thing here
/// nothing was watching.
async fn revoke_all_tools(
    worker_url: &str,
    token: &str,
    locale: Locale,
) -> Result<serde_json::Value, String> {
    let resp = reqwest::Client::new()
        .post(format!("{}/oauth/revoke-all", worker_url.trim_end_matches('/')))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| {
            log::warn!("revoke-all failed: {e}");
            user_err(locale, Key::ErrorReachBrain)
        })?;
    if !resp.status().is_success() {
        return Err(i18n::t_fmt(
            locale,
            Key::ErrorBrainHttpStatus,
            &[("status", &resp.status().as_u16().to_string())],
        ));
    }
    resp.json()
        .await
        .map_err(|_| user_err(locale, Key::ErrorBrainUnexpected))
}

/// Applies the ledger rule to a `GET /migration/status` body.
///
/// Three states, because the ledger is rewritten with `finishedAt` when a
/// rebuild completes rather than deleted:
///
/// | `state`            | meaning                       | rotation |
/// |--------------------|-------------------------------|----------|
/// | `null`             | never migrated                | allowed  |
/// | `finishedAt` set   | rebuild complete              | allowed  |
/// | `finishedAt` absent| in progress **or abandoned**  | blocked  |
///
/// The block is not about session contention — every batch re-reads the token,
/// so a rotation would technically survive one. It is about the failure mode: a
/// rotation caught half-way leaves the next batch 401ing and the ledger stalling
/// with `failed` climbing, so a recoverable password problem presents as a failed
/// rebuild. That is the more frightening of the two and the one that invites a
/// destructive "fix".
///
/// An outstanding old index is deliberately not consulted. That is the ordinary
/// post-rebuild state, users sit in it for weeks, and rotation touches no
/// Vectorize binding.
fn blocked_by_migration(status: &serde_json::Value) -> bool {
    match status.get("state") {
        None | Some(serde_json::Value::Null) => false,
        Some(state) => !state
            .get("finishedAt")
            .is_some_and(|finished| !finished.is_null()),
    }
}

/// The refusal [`blocked_by_migration`] produces, as its own screen.
///
/// Split out so the stage and the wording travel together and can be asserted
/// without a `rotate_password` in the way. A rebuild that starts mid-flow — which
/// is the only way this is reached, since the Connection pane already hides the
/// door — used to come back as `notSent`, whose screen reads "Nothing was
/// changed" over a "Try again" button, with the actual reason in the detail
/// slot. Every word of that is unhelpful here: the retry fails identically, the
/// instruction that would work (wait for the rebuild, or reset it from Advanced
/// Settings) reads as a footnote, and an abandoned ledger blocks forever.
fn rotation_block(locale: Locale) -> RotateError {
    RotateError::blocked(user_err(locale, Key::ErrorRotateBlocked))
}

/// Whether a rebuild is under way — or was abandoned — and a rotation has to
/// wait for it, asked of the brain itself.
///
/// **Fails open, twice over, and both are the rule rather than an oversight.**
///
/// Door B has no password to ask with, so `current_password` is `None` and the
/// answer is "not blocked" without a request: gating someone's only way back in
/// on a question they are by definition unable to answer would be backwards.
///
/// And a check that could not be *made* is not a block either. A rebuild is a
/// rare state; an unreachable brain is a Tuesday. Refusing on a failed
/// `fetch_status` presents a network blip as "you may not change your password"
/// on the one screen whose entire job is to change it, and leaves a Door A user
/// with no connection unable to change theirs at all — while the block screen
/// points them at Advanced Settings, which they cannot reach either.
///
/// So only a check that succeeded *and* came back blocked refuses. Split out of
/// [`rotate_password`] so that rule can be driven by a test: that command takes
/// an `AppHandle` and a Tauri `State`, and inverting this gate to refuse on
/// failure compiled and passed the whole suite.
async fn rebuild_blocks_rotation(
    worker_url: &str,
    current_password: Option<&str>,
    locale: Locale,
) -> bool {
    let Some(password) = current_password else {
        return false;
    };
    match crate::migration::fetch_status(worker_url, password, locale).await {
        Ok(status) => blocked_by_migration(&status),
        Err(e) => {
            log::warn!("could not ask whether a rebuild is under way, so it is not a block: {e}");
            false
        }
    }
}

/// Whether a rebuild is in flight (or was abandoned) and rotation must wait.
///
/// Door A only. Door B cannot ask — checking needs a working password, which is
/// by definition what that user does not have — and gating their only way back
/// in on a check they cannot perform would be backwards. Someone who has lost
/// their password is not driving a rebuild from that machine anyway.
///
/// Deliberately *not* [`rebuild_blocks_rotation`]: this one is the Connection
/// pane asking in advance whether to offer the door, and a failure there has to
/// reach the pane rather than be flattened into "no". The defensive gate inside
/// the flow answers a different question — may this rotation proceed — where the
/// same failure must never refuse.
#[tauri::command]
pub async fn rotation_blocked(app: AppHandle) -> Result<bool, String> {
    let (url, token, locale) = settings_target(&app)?;
    let status = crate::migration::fetch_status(&url, &token, locale).await?;
    Ok(blocked_by_migration(&status))
}

/// Read-only re-probe of `/health` with a password, for the "it may already be
/// live" screen.
///
/// Writes nothing, which is what makes it safe to offer as a button on the one
/// screen where the user does not know what happened. A wrong password is a
/// `false`, not an error: on that screen "no" is an answer, not a fault.
#[tauri::command]
pub async fn recheck_password(
    password: String,
    address: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    let locale = locale_of(&app);
    // Scoped so the `State` borrow is dropped before the await below.
    let worker_url = {
        let session = app.state::<SetupSession>();
        rotation_target(&session, locale, address)?.0
    };
    password_opens_brain(&worker_url, &password, locale).await
}

/// Does this password open this brain? The whole of [`recheck_password`], split
/// out so it can be driven by a test — the command takes an `AppHandle`.
///
/// **Three answers, and the screen renders three different things.** Yes, no,
/// and could-not-ask: `recheckUnreachable` exists to carry that third one, and
/// it only has something to carry while the three stay distinct. A wrong
/// password is `Ok(false)` and not an error, because on the screen this serves
/// "no" is an answer rather than a fault; collapsing it into the error arm makes
/// a refused password look like a broken connection and sends the user off
/// checking their network instead of trying the other password. Collapsing the
/// other way is worse still — an unreachable brain reported as `Ok(false)` tells
/// someone their new password does not work when nothing was ever asked.
///
/// `worker_auth_ok`, not `worker_health_ok`, for the same reason the rotation
/// gate uses it: `/health` reports `ok` as the *vector index's* health, and this
/// screen is asking one question only. A brain whose index is degraded would
/// answer "no" about a password that is live and is now the only one that opens
/// it — the worst answer this button can give, on the one screen that exists to
/// end the doubt.
async fn password_opens_brain(
    worker_url: &str,
    password: &str,
    locale: Locale,
) -> Result<bool, String> {
    match crate::cf::api::worker_auth_ok(worker_url, password.trim()).await {
        Ok(ok) => Ok(ok),
        // A 401 from the brain itself *is* the "no" answer this screen exists
        // to deliver — not a fault, and never Cloudflare's business.
        Err(CfApiError::WorkerAuthRejected) => Ok(false),
        Err(e) => {
            log::warn!("password re-check could not reach the brain: {e}");
            Err(user_err(locale, Key::ErrorReachBrain))
        }
    }
}

/// Puts the main window into change-your-password mode and shows it. Door A,
/// from the Connection pane — the same shape as `begin_worker_update`.
///
/// `async` for the same Windows WebView2 IPC deadlock as `open_dashboard`.
#[tauri::command]
pub async fn begin_password_change(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    *session.pending_rotation.lock().unwrap() = true;
    windows::open_setup_window(&app)
        .map_err(|_| user_err(locale_of(&app), Key::ErrorOpenWindowFailed))
}

/// Replaces the brain's password, then writes the new one everywhere this
/// computer keeps it.
///
/// The order is not negotiable. The remote change goes first and is confirmed
/// against the *new* password before anything local is touched, so a failure
/// before that point leaves this computer able to open its own brain. Reversing
/// it would produce the one outcome with no recovery inside the app: local
/// stores holding a password the brain never accepted.
#[tauri::command]
pub async fn rotate_password(
    new_password: String,
    address: Option<String>,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<RotateOutcome, RotateError> {
    let locale = locale_of(&app);
    let new_password = new_password.trim().to_string();
    if new_password.len() < MIN_PASSWORD_LEN {
        return Err(RotateError::not_sent(i18n::t_fmt(
            locale,
            Key::ErrorPasswordTooShort,
            &[("min", &MIN_PASSWORD_LEN.to_string())],
        )));
    }

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    if session.dry_run {
        let refresh_app = app.clone();
        return rotate_demo_password(&new_password, &session, locale, progress, move |token| {
            // The demo brain's own address, for the same reason the live path
            // uses the brain's: `refresh_wrapper_token` only writes where the
            // window's origin matches, and demo mode's window is on loopback.
            let url = crate::demo_brain::base_url();
            windows::refresh_wrapper_token(&refresh_app, &url, token)
        })
        .await;
    }

    // 1. Which brain. Through the session-aware helper, never the keychain
    //    directly — see `rotation_target`.
    let door_b = address.is_some();
    let (worker_url, current_password) =
        rotation_target(&session, locale, address).map_err(RotateError::not_sent)?;

    // 1a. On Door B the address was typed or picked rather than read back from
    //     this computer's own store, so confirm it is a brain before writing a
    //     secret to it. Door A's address came from secure storage, which this app
    //     wrote itself after a successful connection.
    if door_b {
        confirm_target_is_a_brain(&worker_url, &session, locale)
            .await
            .map_err(RotateError::not_sent)?;
    }

    // 2. Refuse defensively if a rebuild is under way. The Connection pane
    //    already hides the door, but the flow can be open across the moment a
    //    rebuild starts on another machine.
    //
    //    Only a check that *succeeds* and says "blocked" refuses — both halves of
    //    that live in `rebuild_blocks_rotation`, which is where the reasoning is
    //    and where a test can reach them.
    if rebuild_blocks_rotation(&worker_url, current_password.as_deref(), locale).await {
        return Err(rotation_block(locale));
    }

    // 3. The Cloudflare account that holds this brain, matched by the subdomain
    //    in its address rather than assumed.
    let client = cloudflare_client_for_brain(&worker_url, &session, locale)
        .await
        .map_err(RotateError::not_sent)?;

    // 4. The remote change, health-gated against the new password.
    //
    // `?`, not `.ok()`. Everything below writes the new password into stores this
    // computer reads at launch, and doing that after a remote change that did not
    // land is the one outcome #235 has no recovery for: the brain still answers to
    // the old password, nothing here holds it any more, and the app has no way to
    // ask for it back. That mutation compiled and passed the whole suite.
    provision::rotate_secret(
        &LiveBackend { client },
        &worker_url,
        &new_password,
        progress,
    )
    .await
    .map_err(|e| {
        log::warn!("password rotation failed: {}", for_log(&e));
        rotation_failure(e, locale)
    })?;

    // 5. Only now is it safe to write anything locally.
    //
    // The third row of the rotation screen's checklist, and the only one emitted
    // from outside `rotate_secret` — which is not an oversight but the ordering
    // itself. Nothing local may be written until the remote change has been
    // confirmed, so the step cannot exist inside the function that does the
    // confirming, and a row that nobody emits is a row that sits as a static
    // bullet for the whole run.
    let emit_local = |status: provision::StepStatus| {
        let _ = app.emit(
            "setup-progress",
            provision::StepEvent { step: provision::Step::Local, status },
        );
    };
    emit_local(provision::StepStatus::Running);

    // Without a home directory there is nowhere for `persist` to look, so it
    // cannot run at all and there is no outcome to report — which is what the
    // `"local"` stage is for. `ErrorRotateSecureStore` reads correctly here: the
    // password was changed and nothing on this computer was told, which is what
    // the user needs to act on. Deliberately not `ErrorSecureStoreConnect`, which
    // opens "Connected, but…" — nothing was connected, a working password was
    // replaced.
    //
    // The one hard failure this step has, and so the one place it ends in
    // `Error`. Everything `persist` itself can get wrong comes back as a flag on
    // the outcome instead — see below.
    let Some(home) = dirs::home_dir() else {
        emit_local(provision::StepStatus::Error);
        return Err(RotateError::local(user_err(locale, Key::ErrorRotateSecureStore)));
    };
    let refresh_app = app.clone();
    let refresh_url = worker_url.clone();
    let outcome = rotate::persist(
        &home,
        &worker_url,
        &new_password,
        // The one caller that supplies the real secure store. `persist` takes it
        // as a seam so its own tests never write the process-global test map (and
        // so the failure branch is reachable at all) — which means this line is
        // the whole of "the keychain is actually written", and the guard below
        // holds it in place.
        |url, token| secure_store::save_setup(url, token).map_err(|e| e.to_string()),
        move |token| windows::refresh_wrapper_token(&refresh_app, &refresh_url, token),
    );

    // `Done`, not a status derived from the outcome, and the distinction is the
    // one the checklist is for. `persist` never fails as a whole — it writes each
    // store independently and reports which ones took — so the *step* completed
    // whatever the flags say. An `Error` row here would also contradict the screen
    // it appears on: this returns `Ok`, the done screen renders, and it names any
    // store that did not take in a sentence of its own. A red row above a
    // successful screen tells the user two different things at once, and the one
    // that is wrong is the one with no detail attached.
    emit_local(provision::StepStatus::Done);

    clear_pending_rotation(&session);
    // A rotation is also the answer to "your password was changed elsewhere".
    *session.stale_password.lock().unwrap() = false;

    // Reported, not raised. The rotation itself succeeded — the brain is on the
    // new password — so turning a failed local write into an `Err` would throw
    // away the outcome that tells the screen *which* store to name, and would
    // describe a change that did happen as one that did not. The `"local"` stage
    // is for a local step that produced no outcome at all (above), and the front
    // end renders the same screen from either arrival.
    Ok(outcome)
}

/// The demo half of [`rotate_password`], split out so it can be driven by a test.
///
/// A Tauri `State`/`AppHandle` cannot be constructed in a unit test, and the
/// property that matters most here — that a demo rotation reaches the keychain
/// exactly zero times — is only observable by calling the thing that does the
/// work. `previous_index_for` is split for the same reason.
///
/// This runs the real pipeline: `rotate_secret` against `DryRunBackend`, whose
/// `put_secret` moves the demo brain onto the new password and whose `health_ok`
/// then has to get a real 200 back from it. What it must never do is write to
/// secure storage — demo state lives in the session and in the demo brain, per
/// the `demo_previous_index` precedent.
async fn rotate_demo_password(
    new_password: &str,
    session: &SetupSession,
    locale: Locale,
    progress: impl Fn(provision::StepEvent),
    refresh_dashboard: impl FnOnce(&str) -> bool,
) -> Result<RotateOutcome, RotateError> {
    // Resolved the same way every other demo screen resolves it, so this path
    // shares the no-keychain guarantee rather than restating it.
    let (_demo_url, _demo_token) =
        dashboard_credentials(session, locale).map_err(RotateError::not_sent)?;

    // The address handed to `rotate_secret` is the `.demo.workers.dev` stand-in,
    // not the loopback address above. `rotate_secret` derives the Worker's script
    // name from the address it is given (#257) and loopback has no script label,
    // so it would refuse a demo rotation before doing anything.
    // `DryRunBackend::health_ok` resolves the stand-in back to the brain on
    // loopback, so the gate is still a real request against a real server.
    let worker_url = "https://second-brain.demo.workers.dev";

    provision::rotate_secret(&DryRunBackend, worker_url, new_password, progress)
        .await
        .map_err(|e| {
            log::warn!("demo password rotation failed: {}", for_log(&e));
            rotation_failure(e, locale)
        })?;

    clear_pending_rotation(session);
    *session.stale_password.lock().unwrap() = false;

    // No `rotate::persist`. Its first act is a secure-storage write, and a demo
    // run must not put a demo password into the user's real keychain — nor a
    // plaintext demo credential into their real CLI config. The demo brain is now
    // answering to the new password, and `dashboard_credentials` asks it rather
    // than remembering, so demo mode is genuinely on the new password from here
    // without anything having been stored.
    //
    // The dashboard is the exception, and it is called rather than assumed. An
    // open wrapper window holds the token it was created with in `localStorage`,
    // which is true of the demo window exactly as it is of a real one — and it is
    // the single behaviour the whole dry-run-fidelity argument exists to make
    // demonstrable, since it is the one place a rotation can leave something
    // visibly stale. Hard-coding `dashboard: true` here skipped it, so a demo
    // rotation left the dashboard window 401ing against the demo brain and the
    // done screen said it had not.
    let dashboard = refresh_dashboard(new_password);

    Ok(RotateOutcome {
        keychain: true,
        cli_config: None,
        dashboard,
    })
}

/// Signs this computer out: forgets the saved address + password and returns
/// to the setup flow. The Second Brain itself (and every other device) is
/// untouched. Confirmation happens in the UI before this is invoked.
///
/// `async` because `perform_logout` may open the setup window via
/// `WebviewWindowBuilder::build` when `main` is gone (wry#583).
#[tauri::command]
pub async fn logout(app: AppHandle, session: State<'_, SetupSession>) -> Result<(), String> {
    session.reset();
    perform_logout(&app);
    Ok(())
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

// ── Advanced Settings (#246) ───────────────────────────────────────────────────
//
// Every mutating command returns the freshly re-read view rather than echoing
// what was requested. The Worker clamps and invariant-checks at resolve time,
// so what it stored may differ from what was asked for — rendering from the
// request would show the user a state their brain is not actually in.

/// Resolves the brain to talk to, going through the same session-aware helper
/// the dashboard commands use.
///
/// Deliberately NOT `secure_store::load_setup()` directly: that ignores
/// dry-run, so it both breaks demoing the panel on a configured machine and
/// raises a Keychain prompt for a value dry-run would discard — the bug fixed
/// for launch in #252, which is easy to reintroduce one command at a time.
/// Resolves the Cloudflare account that holds this brain, refreshing the sign-in
/// if it aged out.
///
/// Shared by the worker update and the embedding migration: both need to act on
/// the account the brain actually lives in, matched by the subdomain in its
/// stored address rather than assumed.
async fn cloudflare_client_for_brain(
    worker_url: &str,
    session: &SetupSession,
    locale: Locale,
) -> Result<CfClient, String> {
    let expected_sub = crate::worker_url::subdomain_of(worker_url)
        .ok_or_else(|| user_err(locale, Key::ErrorCustomDomain))?;

    let mut tokens = session
        .tokens
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| user_err(locale, Key::ErrorCfSignInFirst))?;
    if tokens.expires_at <= std::time::Instant::now() {
        tokens = oauth::refresh(&tokens).await.map_err(|e| {
            log::warn!("token refresh failed: {e}");
            user_err(locale, Key::ErrorCfSignInExpired)
        })?;
        *session.tokens.lock().unwrap() = Some(tokens.clone());
    }

    let accounts = session.accounts.lock().unwrap().clone();
    for account in &accounts {
        let client = CfClient::new(tokens.access_token.clone(), account.id.clone());
        if let Ok(Some(sub)) = client.get_account_subdomain().await {
            if sub == expected_sub {
                return Ok(client);
            }
        }
    }
    Err(user_err(locale, Key::ErrorWrongCfAccount))
}

/// What a rebuild would involve, and which models can be chosen. Shown before
/// anything is created.
#[tauri::command]
pub async fn migration_estimate(
    app: AppHandle,
) -> Result<crate::migration::MigrationEstimate, String> {
    let (url, token, locale) = settings_target(&app)?;
    // The shipped dimension count is the fallback for a brain running a reading
    // this build does not list.
    let manifest = worker_bundle::manifest();
    crate::migration::fetch_estimate(&url, &token, manifest.vectorize_dimensions, locale).await
}

/// Where an interrupted rebuild got to, so the app can offer to resume rather
/// than start again.
#[tauri::command]
pub async fn migration_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::fetch_status(&url, &token, locale).await
}

/// Moves the brain onto a new embedding model: create the index it will use,
/// redeploy the binding at it, then record the model.
///
/// Nothing is destroyed here. The previous index is left in place and populated,
/// so every failure before [`finish_embedding_migration`] is recoverable by
/// redeploying against it.
///
/// The order matters. The config write happens *after* the redeploy, because
/// config lives in KV and takes effect on the very next request: writing it first
/// would leave the Worker embedding at the new size against the old index, which
/// fails every capture on upsert. Reversing them narrows that window to the gap
/// between a successful deploy and one KV write. It cannot be closed entirely
/// without the dual-binding scheme #248 defers, and the rebuild that follows
/// leaves recall incomplete anyway — which the UI says plainly.
#[tauri::command]
pub async fn begin_embedding_migration(
    model: String,
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let manifest = worker_bundle::manifest();

    // Reject an unknown model before touching anything. Dimensions are fixed at
    // index creation, so a model whose size we would have to guess could produce
    // an index that rejects every vector — and an index cannot be altered.
    let dimensions = crate::migration::dimensions_for(&model)
        .ok_or_else(|| user_err(locale, Key::ErrorUnknownEmbeddingModel))?;
    let target_index = crate::migration::index_name_for(
        &manifest.vectorize_name,
        dimensions,
        manifest.vectorize_dimensions,
    );

    let (worker_url, auth_token, _) = settings_target(&app)?;

    let progress_app = app.clone();
    let progress = move |event: provision::StepEvent| {
        let _ = progress_app.emit("setup-progress", &event);
    };

    if session.dry_run {
        // The demo brain runs on a loopback address, which has no script or
        // subdomain to derive — `update_worker` would refuse it before doing
        // anything. The `.demo.workers.dev` stand-in exercises the same code path,
        // and `DryRunBackend::health_ok` resolves it back to the brain on
        // loopback, so the health poll is a real request against a real server
        // while the deploy stays a no-op.
        provision::update_worker(
            &DryRunBackend,
            manifest,
            "https://second-brain.demo.workers.dev",
            // The live password, for the same reason as `start_worker_update`'s
            // dry-run branch: the health poll is authenticated, and a demo
            // rotation has already moved this.
            &auth_token,
            provision::VectorizeTarget { name: &target_index, dimensions, keep_live_index: false },
            progress,
        )
        .await
        .map_err(|e| {
            log::warn!("dry-run migration redeploy failed: {e}");
            user_err(locale, Key::ErrorFriendlyRetry)
        })?;
        // In the same order as the live path below, so demo mode actually moves
        // the model. Without this the demo rebuild runs at the old model, the
        // old index stays "live", and the final free-up step is unreachable —
        // which would leave the most consequential screen untested.
        crate::migration::patch_embedding_model(&worker_url, &auth_token, &model, locale).await?;
        // In memory, never the keychain — see demo_previous_index.
        if target_index != manifest.vectorize_name {
            *session.demo_previous_index.lock().unwrap() = Some(manifest.vectorize_name.clone());
        }
        return crate::migration::reset(&worker_url, &auth_token, locale).await;
    }

    let client = cloudflare_client_for_brain(&worker_url, &session, locale).await?;

    // What the brain reads right now, taken from the live binding rather than
    // derived from an assumed size. Recorded BEFORE the switch, because
    // afterwards the brain reports the new index as current and this name is the
    // only thing that identifies what may later be freed. Written first so it
    // survives a redeploy that fails half-way.
    if let Some(script) = crate::worker_url::script_of(&worker_url) {
        if let Ok(bindings) = client.get_script_bindings(&script).await {
            if let Some(current) = provision::binding_field(&bindings, "vectorize", "index_name") {
                if current != target_index {
                    if let Err(e) = secure_store::save_previous_index(current) {
                        log::warn!("could not record the outgoing index: {e}");
                    }
                }
            }
        }
    }

    let backend = LiveBackend { client };

    // Creating the index is idempotent and non-destructive, and update_worker
    // creates the target if it is missing — so a retry after a failed deploy
    // costs nothing.
    provision::update_worker(
        &backend,
        manifest,
        &worker_url,
        &auth_token,
        provision::VectorizeTarget { name: &target_index, dimensions, keep_live_index: false },
        progress,
    )
    .await
    .map_err(|e| {
        log::warn!("migration redeploy failed: {e}");
        match e {
            ProvisionError::NotAWorkersDevAddress => user_err(locale, Key::ErrorCustomDomain),
            _ => user_err(locale, Key::ErrorFriendlyRetry),
        }
    })?;

    // Past this point the brain is already reading the new index, so a failure is
    // not "nothing happened". Search stays incomplete until the rebuild runs, and
    // the message has to say so — retrying is safe and idempotent, but walking
    // away is not.
    let half_switched = |_e: String| user_err(locale, Key::ErrorMigrationHalfSwitched);

    crate::migration::patch_embedding_model(&worker_url, &auth_token, &model, locale)
        .await
        .map_err(half_switched)?;

    // Any ledger from a previous target is meaningless against this one.
    crate::migration::reset(&worker_url, &auth_token, locale)
        .await
        .map_err(half_switched)
}

/// Abandons an unfinished rebuild so the next one starts from the beginning.
///
/// The escape hatch for a rebuild that keeps stalling on the same entry: without
/// it, a user whose cursor sits on a permanently failing memory has no way out.
/// Rebuilding is idempotent, so this costs model calls and cannot corrupt
/// anything.
#[tauri::command]
pub async fn migration_reset(app: AppHandle) -> Result<(), String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::reset(&url, &token, locale).await
}

/// One re-embed batch. The window loops on this until `done`, and stops if
/// `stalled` — the day's model allowance is spent and the cursor is kept.
#[tauri::command]
pub async fn migration_step(app: AppHandle) -> Result<crate::migration::BatchProgress, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::migration::run_batch(&url, &token, locale).await
}

/// Whether an index is left over from a migration, and can be freed.
///
/// The window asks this rather than tracking sizes itself: the name comes from
/// what Cloudflare reported as bound before the switch, so nothing is derived
/// from an assumed dimension count and nothing lives in browser storage that a
/// reset could lose.
#[tauri::command]
pub fn outstanding_old_index(session: State<'_, SetupSession>) -> Option<String> {
    previous_index_for(&session)
}

/// Split out of the command so it can be tested: a Tauri `State` cannot be
/// constructed in a unit test, and the property that matters here — that demo
/// mode performs no keychain read — is only observable by calling it.
fn previous_index_for(session: &SetupSession) -> Option<String> {
    if session.dry_run {
        // Checked before the keychain read, exactly as get_app_state does: a read
        // here raises an OS password prompt on unsigned dev builds, and demo mode
        // must never do that.
        return session.demo_previous_index.lock().unwrap().clone();
    }
    secure_store::load_previous_index()
}

/// Deletes the superseded index. The one irreversible step, so the window
/// confirms it separately and only after a rebuild has finished.
///
/// Takes no argument on purpose. An earlier shape had the window pass the size it
/// thought it was moving from, which put the name of something irreversibly
/// deletable in the hands of browser storage.
#[tauri::command]
pub async fn finish_embedding_migration(
    app: AppHandle,
    session: State<'_, SetupSession>,
) -> Result<(), String> {
    let locale = locale_of(&app);
    let (worker_url, auth_token, _) = settings_target(&app)?;

    let old_index = if session.dry_run {
        session.demo_previous_index.lock().unwrap().clone()
    } else {
        secure_store::load_previous_index()
    }
    .ok_or_else(|| user_err(locale, Key::ErrorNoOldIndexToFree))?;

    // Refuse to delete the index the brain is reading. The recorded name is
    // trustworthy, but a redeploy could have been rolled back since, and the cost
    // of being wrong here is unrecoverable.
    let live_model = crate::migration::fetch_status(&worker_url, &auth_token, locale)
        .await?
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    let manifest = worker_bundle::manifest();
    let live_index = crate::migration::index_name_for(
        &manifest.vectorize_name,
        crate::migration::dimensions_for(&live_model).unwrap_or(manifest.vectorize_dimensions),
        manifest.vectorize_dimensions,
    );
    if old_index == live_index {
        return Err(user_err(locale, Key::ErrorCannotDeleteLiveIndex));
    }

    // Through the Backend trait rather than the client directly, so demo mode
    // exercises the same code path instead of returning early past it.
    use provision::Backend;
    let failed = |e: CfApiError| {
        log::warn!("old index delete failed: {e}");
        user_err(locale, Key::ErrorFriendlyRetry)
    };
    if session.dry_run {
        DryRunBackend
            .delete_vectorize(&old_index)
            .await
            .map_err(failed)?;
    } else {
        let backend = LiveBackend {
            client: cloudflare_client_for_brain(&worker_url, &session, locale).await?,
        };
        backend.delete_vectorize(&old_index).await.map_err(failed)?;
    }

    // Only after the delete succeeded. Clearing it first would silently orphan
    // the index with nothing left pointing at it.
    if session.dry_run {
        *session.demo_previous_index.lock().unwrap() = None;
    } else {
        secure_store::clear_previous_index();
    }
    Ok(())
}

fn settings_target(app: &AppHandle) -> Result<(String, String, Locale), String> {
    let locale = locale_of(app);
    let session = app.state::<SetupSession>();
    let (url, token) = dashboard_credentials(&session, locale)?;
    Ok((url, token, locale))
}

/// What `GET /team/me` says about the token this machine is set up with.
///
/// Two fields and no verdict: the rules that turn this into a role live in
/// `installer/src/connection-role.ts`, in one place, so the setup flow and the
/// Connection details window cannot drift apart about the same person.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct ConnectionRoleProbe {
    /// `profile.role` — "admin" or "member", or absent if it could not be read.
    pub role: Option<String>,
    /// `profile.owner` — true only for the identity holding this deployment's
    /// AUTH_TOKEN. `role` cannot say this: src/lib/tenancy.ts hashes AUTH_TOKEN
    /// into a users row with role 'admin', so the owner and a promoted
    /// colleague are the same value there.
    pub owner: bool,
    /// Whether `/team/me` answered with a profile that carried NO `owner` key —
    /// a Worker deployed before the key existed, positively identified as such.
    ///
    /// Not the same fact as `owner: false`, and not the same fact as a probe
    /// that failed. It licenses exactly one thing, the Worker update, because
    /// that update is the only way OUT of this state; see
    /// [`update_prompt_is_offerable`].
    #[serde(rename = "legacyWorker")]
    pub legacy_worker: bool,
}

/// How long to wait before answering without the brain.
///
/// Shorter than `migration::TIMEOUT` on purpose: this one runs while a window
/// is drawing itself, and the answer it is waiting for only decides which of
/// two paragraphs to show.
const ROLE_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Asks the brain who is holding this token. **Never fails.**
///
/// Every way of not getting an answer — a Worker too old to serve the route, a
/// 401 from a revoked token, an unreachable brain, a body that will not parse —
/// returns the default, which `roleFromProbe` reads as "member". Returning a
/// `Result` here would push that decision onto every caller, and the one thing
/// this must not do is claim more than it knows: over-claiming is the sentence
/// the whole change exists to delete.
///
/// Split out from the command so a test can drive it — the command takes an
/// `AppHandle` and nothing in this crate can build one.
pub async fn fetch_connection_role(worker_url: &str, auth_token: &str) -> ConnectionRoleProbe {
    let none = ConnectionRoleProbe::default();
    let url = format!("{}/team/me", worker_url.trim_end_matches('/'));
    let resp = match reqwest::Client::new()
        .get(url)
        .bearer_auth(auth_token)
        .timeout(ROLE_PROBE_TIMEOUT)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            log::warn!("/team/me answered {} — claiming nothing about this token", r.status());
            return none;
        }
        Err(e) => {
            log::warn!("could not ask who holds this token: {e}");
            return none;
        }
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("/team/me was not the expected shape: {e}");
            return none;
        }
    };
    role_probe_from_body(&body)
}

/// The parse, split from the request so a test can hand it a body no brain this
/// app talks to would send.
///
/// A 200 is not a promise about shape. `as_bool() == Some(true)` rather than
/// truthiness: a body carrying `owner: "yes"` or `owner: 1` is unexpected, and
/// an unexpected body must not promote anyone. Same for `role`, which is only
/// taken when it is genuinely a string.
/// The absent `owner` key is read separately from an unreadable one. A body
/// carrying `owner: "yes"` has the key and cannot be trusted, so it claims
/// nothing at all; a body with no `owner` key AND a role it did manage to state
/// is a Worker from before the key existed, which is a different fact and the
/// one that opens the update.
fn role_probe_from_body(body: &serde_json::Value) -> ConnectionRoleProbe {
    let profile = body.get("profile").filter(|p| p.is_object());
    let role = profile
        .and_then(|p| p.get("role"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    ConnectionRoleProbe {
        legacy_worker: role.is_some()
            && profile.is_some_and(|p| p.get("owner").is_none()),
        owner: body["profile"]["owner"].as_bool() == Some(true),
        role,
    }
}

/// The Connection details window asking who it is rendering for.
///
/// The webview never handles the token — it stays in this process — so this is
/// the only way that window can know, and until it existed the window said
/// "You're signed in as this brain's owner-admin" to every member who opened it.
///
/// Only ever called on a brain this machine recorded as a team brain; a solo
/// install makes no request at all.
#[tauri::command]
pub async fn connection_role(app: AppHandle) -> Result<ConnectionRoleProbe, String> {
    let (url, token, _locale) = settings_target(&app)?;
    Ok(fetch_connection_role(&url, &token).await)
}

#[tauri::command]
pub async fn get_brain_settings(app: AppHandle) -> Result<crate::settings::SettingsView, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::settings::fetch_settings(&url, &token, locale).await
}

/// Commits staged changes from the Advanced Settings window.
///
/// Replaces the earlier save-on-change commands: settings that alter how recall
/// behaves should not be written the instant a radio is clicked, because a
/// mis-click silently retunes the user's brain with no way back.
#[tauri::command]
pub async fn save_brain_settings(
    app: AppHandle,
    levels: Vec<(String, String)>,
    resets: Vec<String>,
    model: Option<String>,
    insight_model: Option<String>,
) -> Result<crate::settings::SettingsView, String> {
    let (url, token, locale) = settings_target(&app)?;
    crate::settings::apply_settings(&url, &token, &levels, &resets, model, insight_model, locale).await?;
    crate::settings::fetch_settings(&url, &token, locale).await
}

/// Opens Advanced Settings. `async` for the same Windows WebView2 IPC deadlock
/// as `open_dashboard` (wry#583); menu/tray call `windows::open_settings_window`
/// sync from the event loop.
#[tauri::command]
pub async fn open_settings_window(app: AppHandle) {
    crate::windows::open_settings_window(&app);
}

#[cfg(test)]
mod tests {
    use super::{
        app_mode, bindings_are_a_brains, blocked_by_migration, brain_index_names,
        clear_pending_rotation, cloudflare_client_for_brain, confirm_target_is_a_brain,
        dashboard_credentials, fetch_connection_role, for_log, normalize_worker_url,
        role_probe_from_body, update_prompt_is_offerable,
        password_opens_brain, ConnectionRoleProbe,
        previous_index_for, rebuild_blocks_rotation, revoke_all_tools, rotate_demo_password,
        rotation_address, rotation_block, rotation_failure, rotation_target, RotateError,
        SetupSession, LOG_DETAIL_MAX,
    };
    use crate::cf::oauth::Tokens;
    use crate::cf::provision::{ProvisionError, ProvisionOutcome};
    use crate::cf::types::{Account, CfApiError};
    use crate::i18n::{self, Key, Locale};

    /// The body of a top-level `fn`, read from the source *above* the test module.
    ///
    /// Both halves of that sentence are load-bearing, and both were learned by
    /// this repo the expensive way. Reading only the code means a guard can never
    /// be satisfied by the assertion text written to describe it — that has
    /// silently disabled four guards here so far, including one that passed with
    /// the thing it was guarding deleted. And every anchor is `expect`ed rather
    /// than defaulted to "the rest of the file": a scan that fails open finds
    /// whatever it is looking for and reports success.
    fn fn_body<'a>(src: &'a str, signature: &str) -> &'a str {
        let code = &src[..src
            .find("\n#[cfg(test)]\nmod tests {")
            .expect("the test module is the boundary of the scannable source")];
        let start = code
            .find(signature)
            .unwrap_or_else(|| panic!("`{signature}` is not in this file any more"));
        let body = &code[start..];
        let end = body
            .find("\n}\n")
            .unwrap_or_else(|| panic!("`{signature}` has no closing brace in column zero"));
        &body[..end]
    }

    /// Where `needle` appears in `body`, or a failure naming what was being
    /// looked for. Never `unwrap_or(0)`: a missing anchor that sorts first
    /// satisfies every ordering assertion made about it.
    fn at(body: &str, needle: &str) -> usize {
        body.find(needle)
            .unwrap_or_else(|| panic!("`{needle}` is gone from the function this test guards"))
    }

    /// How many keychain reads `run` performed, or `None` when another test
    /// reset the counter mid-sample and the answer is unknowable.
    ///
    /// The counter is process-global and the suite runs in parallel, so a single
    /// sample can pick up someone else's access — or, if they reset in between,
    /// go backwards. The old form of this subtracted regardless, which underflows
    /// on a decrease (a panic in debug) and, with `saturating_sub`, reports the
    /// false zero that would make this whole check pass while the bug was live.
    fn keychain_reads_during(run: impl FnOnce()) -> Option<usize> {
        let before = crate::secure_store::probe::reads();
        run();
        let after = crate::secure_store::probe::reads();
        after.checked_sub(before)
    }

    /// Asserts `run` never touches the keychain, sampling to survive the suite.
    ///
    /// A sample that caught another test's read proves nothing either way — but a
    /// path that reads the keychain contaminates *every* sample, so one clean
    /// sample is the proof and repeated dirty ones are the failure.
    fn assert_never_reads_the_keychain(what: &str, mut run: impl FnMut()) {
        // Reset once, outside the sampling loop: the counter is a `usize` that
        // nothing else zeroes, and every reader here tolerates a decrease.
        crate::secure_store::probe::reset();
        let mut dirty = Vec::new();
        let mut inconclusive = 0;
        for _ in 0..8 {
            match keychain_reads_during(&mut run) {
                Some(0) => return,
                Some(n) => dirty.push(n),
                None => inconclusive += 1,
            }
        }
        panic!(
            "no sample of {what} came back clean (reads: {dirty:?}, {inconclusive} \
             inconclusive) — a keychain read here is the OS password prompt users \
             see, raised before the setup UI's first paint"
        );
    }

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
                normalize_worker_url(input, Locale::En).unwrap(),
                "https://second-brain.demo.workers.dev",
                "input: {input:?}"
            );
        }
    }

    #[test]
    fn rejects_garbage_urls() {
        for input in ["", "not a url", "ftp://bad.scheme"] {
            assert!(normalize_worker_url(input, Locale::En).is_err(), "input: {input:?}");
        }
    }

    #[test]
    fn keeps_explicit_http_and_ports_for_dev_setups() {
        assert_eq!(
            normalize_worker_url("http://localhost:8787/mcp", Locale::En).unwrap(),
            "http://localhost:8787"
        );
    }

    #[test]
    fn rejects_junk() {
        for input in ["", "   ", "not a url at all!", "ftp://x.dev", "mailto:a@b.c"] {
            assert!(
                normalize_worker_url(input, Locale::En).is_err(),
                "input: {input:?}"
            );
        }
    }


    /// #252 fixed launch raising a Keychain prompt in dry-run. Every command
    /// that resolves a brain must go through dashboard_credentials for the same
    /// reason — bypassing it reintroduces the bug one command at a time.
    #[test]
    fn settings_commands_resolve_credentials_through_the_session_helper() {
        let src = include_str!("commands.rs");
        let start = src.find("fn settings_target").expect("settings_target");
        let end = src[start..].find("\n}").expect("end of fn") + start;
        let body = &src[start..end];
        assert!(
            body.contains("dashboard_credentials"),
            "settings_target must use dashboard_credentials so dry-run is honoured"
        );
        assert!(
            !body.contains("secure_store::load_setup"),
            "settings_target must not read secure_store directly — it ignores dry-run and prompts the Keychain"
        );
    }

    /// Demo mode is pointed at the local demo brain, not at
    /// `second-brain.demo.workers.dev` — that address does not resolve, so every
    /// Worker-backed screen failed before anything could be demonstrated.
    /// Demo mode performs zero keychain reads.
    ///
    /// Counted rather than grepped. Two separate paths have now reached the
    /// keychain in dry-run: `outstanding_old_index` read the note unconditionally,
    /// and `dashboard_credentials` called `details_from_anywhere`, which falls
    /// back to `secure_store::load_setup()` — so merely opening the settings
    /// window raised an OS password prompt before any request was made. That
    /// second one is why the window never worked in demo mode at all.
    ///
    /// A source scan cannot express the real rule, which is "not inside the
    /// dry-run branch" rather than "the function mentions dry_run" — a guard I
    /// wrote that way passed while the bug was reintroduced. The prompt itself is
    /// an OS dialog no unit test can see, but the read that causes it is
    /// countable, so this counts.
    #[test]
    fn demo_mode_never_reads_the_keychain() {
        // A brain of its own. The token assertion below is about what a demo
        // session is handed, not about what some other test happened to leave the
        // process-wide brain answering to.
        let _brain = crate::demo_brain::scoped_brain();
        let session = SetupSession::new(true);
        *session.outcome.lock().unwrap() = Some(ProvisionOutcome {
            worker_url: "https://second-brain.demo.workers.dev".into(),
            mcp_url: "https://second-brain.demo.workers.dev/mcp".into(),
        });

        assert_never_reads_the_keychain("dashboard_credentials in demo mode", || {
            let _ = dashboard_credentials(&session, Locale::En);
        });
        let (url, token) = dashboard_credentials(&session, Locale::En).expect("demo credentials");
        assert!(url.starts_with("http://127.0.0.1:"), "demo must use the local brain: {url}");
        assert_eq!(token, "demo");

        // The outstanding-index note is the other path that reached the keychain.
        assert_never_reads_the_keychain("the outstanding-index note in demo mode", || {
            let _ = previous_index_for(&session);
        });

        // And with no session outcome either: the fallback is exactly where the
        // keychain read used to hide.
        let fresh = SetupSession::new(true);
        assert_never_reads_the_keychain("an unconnected demo session", || {
            let _ = dashboard_credentials(&fresh, Locale::En);
        });
    }

    // ── Changing the password (#235) ─────────────────────────────────────────

    /// The three failure shapes are three different things to tell the user, and
    /// the copy on each screen is only true for one of them.
    ///
    /// "notSent" says the old password still works. "unconfirmed" must never say
    /// that: the secret was accepted and only the confirmation timed out, so the
    /// new password may already be the only one that opens the brain. Collapsing
    /// them means every failure has to hedge — and a user whose Cloudflare
    /// sign-in merely expired is told their password may have changed, which
    /// teaches people to ignore that warning on the one occasion it is real.
    #[test]
    fn each_failure_shape_selects_the_screen_that_can_tell_the_truth() {
        assert_eq!(
            rotation_failure(ProvisionError::HealthCheckFailed, Locale::En).stage,
            "unconfirmed",
            "the secret was accepted and only the confirmation ran out of attempts"
        );
        assert_eq!(
            rotation_failure(ProvisionError::NotAWorkersDevAddress, Locale::En).stage,
            "notSent",
            "refused by the #257 guard before the write — the script name is derived \
             from the address before anything is emitted or sent"
        );
        assert_eq!(rotation_block(Locale::En).stage, "blocked");
        assert_eq!(RotateError::local(String::new()).stage, "local");

        // Distinct strings, checked as a set: two stages that happen to be spelled
        // the same select the same screen no matter how carefully the match arms
        // above are written.
        let stages = [
            RotateError::not_sent(String::new()).stage,
            RotateError::unconfirmed(String::new()).stage,
            RotateError::blocked(String::new()).stage,
            RotateError::local(String::new()).stage,
        ];
        let mut unique = stages.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 4, "two stages collapsed into one: {stages:?}");
    }

    /// Nothing raised from `put_secret` onwards may claim the old password still
    /// works.
    ///
    /// `notSent`'s screen states, in as many words, that the old password still
    /// works and everything is exactly as it was. That is a positive claim about
    /// *remote* state, and there are only two errors this app can make it from:
    /// one it raised itself before sending anything, and one Cloudflare raised
    /// before the secrets handler ran. Everything else out of `rotate_secret`
    /// comes from a request that was already in flight.
    ///
    /// The `_` arm that used to sit at the bottom of `rotation_failure` sent
    /// `Network` and `Http` to `notSent`. `send_impl` returns `Network` only after
    /// exhausting its retries — which includes a PUT that reached Cloudflare and
    /// whose *response* was lost — and `Http` is an unparseable body that can
    /// arrive with any status. Both were being reported as "nothing happened" over
    /// a brain whose password may have already moved, and a user who believes that
    /// closes the window without saving the password they now need.
    #[test]
    fn a_failure_after_the_put_never_claims_the_old_password_still_works() {
        // `reqwest::Error` has no public constructor, so a request that cannot
        // even be built stands in for the one `send_impl` returns after every
        // attempt died on the wire — the case where the PUT may have been applied
        // on any of them and only the response was lost.
        let on_the_wire = CfApiError::Network(
            reqwest::Client::new()
                .get("http://[not a host]/")
                .build()
                .expect_err("an unparseable URL cannot be built into a request"),
        );

        let after_the_put = [
            ProvisionError::Api(on_the_wire),
            ProvisionError::Api(CfApiError::Http {
                status: 200,
                body: "[unparseable response] <html>…".into(),
            }),
            ProvisionError::Api(CfApiError::Api {
                code: 10021,
                message: "workers.api.error".into(),
            }),
            ProvisionError::Api(CfApiError::Other("Cloudflare returned no result".into())),
            // The one that looks safe and is not. A 401 is decided before the
            // secrets handler runs, so *that attempt* wrote nothing — but
            // `send_impl` retries, and a first attempt that died on the wire with
            // the PUT already applied, followed by a retry that 401s on a token
            // that expired in between, arrives here over a brain that has moved.
            ProvisionError::Api(CfApiError::Unauthorized),
            ProvisionError::HealthCheckFailed,
            // Unreachable from `rotate_secret`, and classified so that becoming
            // reachable fails towards the claim that cannot lock anyone out.
            ProvisionError::CaptureFailed,
            ProvisionError::SubdomainUnavailable,
        ];
        for error in after_the_put {
            let described = error.to_string();
            assert_eq!(
                rotation_failure(error, Locale::En).stage,
                "unconfirmed",
                "`{described}` was reported as notSent, whose screen tells the user \
                 their old password still works — which this app cannot know"
            );
        }
    }

    /// A rebuild in flight is refused on purpose, and gets a screen that says so.
    ///
    /// As `notSent` it arrived as "Nothing was changed" over a "Try again" button,
    /// with the real reason — and the only instruction that works — in the detail
    /// slot underneath. Retrying fails identically, and an abandoned ledger blocks
    /// rotation forever, so that screen offered a user in a permanent state a
    /// button that could never get them out of it.
    #[test]
    fn a_deliberate_refusal_is_not_dressed_up_as_nothing_having_happened() {
        let blocked = rotation_block(Locale::En);
        assert_eq!(blocked.stage, "blocked");
        assert_ne!(
            blocked.stage,
            RotateError::not_sent(String::new()).stage,
            "a block is not a failure to send: the retry the notSent screen offers \
             fails the same way, and an abandoned ledger never stops blocking"
        );
        assert_eq!(blocked.detail, i18n::t(Locale::En, Key::ErrorRotateBlocked));
        assert_ne!(
            rotation_block(Locale::It).detail,
            blocked.detail,
            "the detail must follow the app's locale"
        );
    }

    /// The wire shape the failure screens read, pinned by name.
    ///
    /// `#[serde(rename_all = "camelCase")]` is one line and deleting it compiles.
    /// Both fields here happen to be single words, so the rename is invisible
    /// today — which is exactly why it is worth pinning before a third field
    /// arrives and the front end starts reading `undefined` for it.
    #[test]
    fn the_failure_reaches_the_screen_under_the_names_it_reads() {
        assert_eq!(
            serde_json::to_value(RotateError::unconfirmed("nope".into()))
                .expect("RotateError serializes"),
            serde_json::json!({ "stage": "unconfirmed", "detail": "nope" })
        );

        // …and the attribute itself, which the assertion above genuinely cannot
        // see. `stage` and `detail` are single lowercase words, so the rename is a
        // no-op *today*: deleting it changes no byte of the JSON and no test can
        // notice. The next field added will not be so lucky — `RotateOutcome`
        // already carries `cli_config`/`cliConfig` — and the way that failure
        // presents is a screen quietly rendering `undefined`, which nothing here
        // would catch either. So the attribute is pinned, not inferred.
        let src = include_str!("commands.rs");
        let code = &src[..src
            .find("\n#[cfg(test)]\nmod tests {")
            .expect("the test module is the boundary of the scannable source")];
        let decl = code
            .find("pub struct RotateError {")
            .expect("RotateError is declared above the tests");
        let attrs = &code[code[..decl]
            .rfind("#[derive(")
            .expect("RotateError still derives its traits")..decl];
        assert!(
            attrs.contains(r#"rename_all = "camelCase""#),
            "RotateError no longer renames its fields. Harmless while every field \
             is one word, and a field the front end reads as `undefined` the moment \
             one is not — with nothing on either side of the bridge to say so."
        );
    }

    /// A rotation failure is the moment a user is likeliest to be asked for their
    /// log, and `CfApiError::Http` carries up to 600 characters of whatever
    /// Cloudflare returned when the body would not parse. One failure used to put
    /// most of an edge error page into the log — unreadable, and more than anyone
    /// meant to share.
    #[test]
    fn a_logged_failure_is_bounded_and_says_when_it_was_cut() {
        let short = "Cloudflare sign-in expired";
        assert_eq!(for_log(short), short, "a short detail is left alone");

        let long = "x".repeat(600);
        let logged = for_log(&long);
        assert!(
            logged.chars().count() < long.chars().count(),
            "a 600-character response body reached the log intact"
        );
        assert!(
            logged.starts_with(&"x".repeat(LOG_DETAIL_MAX)),
            "the kept part must be the beginning, where the useful diagnostic is"
        );
        assert!(
            logged.contains("+440 more"),
            "a truncated line that does not say it was truncated reads as the whole \
             story: {logged}"
        );

        // Cut on a character boundary, not a byte one — Cloudflare's messages are
        // UTF-8 and slicing one in half panics.
        let multibyte = "é".repeat(600);
        assert!(for_log(&multibyte).starts_with(&"é".repeat(LOG_DETAIL_MAX)));
    }

    /// The detail is what the front end drops into "What went wrong: …", so it
    /// has to be localised rather than a Rust error's `Display`.
    #[test]
    fn the_failure_detail_is_localised_and_not_a_rust_error_string() {
        let english = rotation_failure(
            ProvisionError::Api(CfApiError::Unauthorized),
            Locale::En,
        );
        assert_eq!(english.detail, i18n::t(Locale::En, Key::ErrorCfSignInExpired));

        let italian = rotation_failure(
            ProvisionError::Api(CfApiError::Unauthorized),
            Locale::It,
        );
        assert_ne!(
            italian.detail, english.detail,
            "the detail must follow the app's locale"
        );
        assert!(
            !rotation_failure(ProvisionError::HealthCheckFailed, Locale::En)
                .detail
                .is_empty(),
            "an empty detail renders as an empty sentence on the screen"
        );
    }

    /// The ledger has three states, not two: a finished rebuild leaves its record
    /// behind with `finishedAt` set rather than deleting it.
    #[test]
    fn rotation_waits_only_while_a_rebuild_is_actually_outstanding() {
        let never = serde_json::json!({ "ok": true, "state": null });
        let finished = serde_json::json!({
            "ok": true,
            "state": { "model": "m", "processed": 10, "finishedAt": 1_753_000_000_000i64 }
        });
        let running = serde_json::json!({
            "ok": true,
            "state": { "model": "m", "processed": 3, "totalAtStart": 100 }
        });

        assert!(!blocked_by_migration(&never), "a brain that never migrated");
        assert!(!blocked_by_migration(&finished), "a rebuild that completed");
        assert!(
            blocked_by_migration(&running),
            "in progress, or abandoned — both block, and Advanced Settings is the \
             escape the message points at"
        );

        // A ledger with the key present but null is not a finished one. Reading
        // `is_some()` alone would let a half-written record unblock rotation.
        let null_finish = serde_json::json!({ "state": { "finishedAt": null } });
        assert!(blocked_by_migration(&null_finish));

        // And a body with no `state` key at all — an older Worker — is not a
        // reason to refuse.
        assert!(!blocked_by_migration(&serde_json::json!({ "ok": true })));
    }

    /// An outstanding old index is the ordinary post-rebuild state. Users sit in
    /// it for weeks, rotation touches no Vectorize binding, and treating it as a
    /// block would make the password unchangeable until they freed an index they
    /// were told they could keep.
    ///
    /// Asserted on the source rather than by planting a note: the note lives in
    /// process-global test state that other tests clear, so a behavioural version
    /// of this would be racing them. What is checkable is that neither function
    /// can consult it. Scans only the function bodies, so this test's own text
    /// cannot satisfy it.
    #[test]
    fn an_outstanding_old_index_is_not_a_reason_to_block_rotation() {
        let src = include_str!("commands.rs");
        for name in ["fn blocked_by_migration", "pub async fn rotation_blocked"] {
            let start = src.find(name).unwrap_or_else(|| panic!("{name} exists"));
            let body = &src[start..];
            let body = &body[..body.find("\n}").expect("end of fn")];
            assert!(
                !body.contains("previous_index"),
                "{name} consults the outstanding-index note. That note means a \
                 rebuild finished and the old index has not been freed — which is \
                 a state users stay in deliberately, and rotation does not care."
            );
        }
    }

    /// Who is holding the token this machine is set up with — asked of the
    /// brain, because nothing local can answer it.
    ///
    /// The Connection details window used to hardcode "owner". Every team member
    /// who opened it read "You're signed in as this brain's owner-admin" and was
    /// offered a password change that walks them through a Cloudflare sign-in
    /// and a new password before failing with ErrorWrongCfAccount. The webview
    /// never handles the token — it stays here — so the window could not ask
    /// until this command existed.
    ///
    /// `owner`, not `role`: src/lib/tenancy.ts hashes AUTH_TOKEN into a users
    /// row with role 'admin', so the person who created the brain and a
    /// colleague they promoted are indistinguishable by role alone.
    #[tokio::test]
    async fn connection_role_reads_what_the_brain_says_about_this_token() {
        let brain = crate::demo_brain::scoped_brain();
        const PASSWORD: &str = "the-password-this-role-probe-test-sets";
        crate::demo_brain::rotate_to(PASSWORD);

        let probe = fetch_connection_role(brain.base_url(), PASSWORD).await;
        assert_eq!(probe.role.as_deref(), Some("admin"), "the profile role is read");
        assert!(probe.owner, "the AUTH_TOKEN holder owns the deployment");
        assert!(
            !probe.legacy_worker,
            "a brain serving the current /team/me is not a legacy Worker"
        );
    }

    /// Least privilege, on every way of not getting an answer. Each of these
    /// must reach `{ role: None, owner: false }`, which `roleFromProbe` in
    /// installer/src/connection-role.ts turns into "member" — because the
    /// failure this whole change exists to fix is the app claiming MORE than it
    /// knows, and a probe that cannot be completed knows nothing.
    #[tokio::test]
    async fn a_probe_that_cannot_be_answered_claims_nothing() {
        let brain = crate::demo_brain::scoped_brain();
        const PASSWORD: &str = "the-password-this-least-privilege-test-sets";
        crate::demo_brain::rotate_to(PASSWORD);

        // A 401: the wrong token, which is what a member holding a token this
        // brain has revoked would get.
        let refused = fetch_connection_role(brain.base_url(), "not-the-password").await;
        assert_eq!(refused, ConnectionRoleProbe::default(), "a 401 must not claim ownership");

        // Nothing listening at all. Port 1 is reserved and never bound.
        let unreachable = fetch_connection_role("http://127.0.0.1:1", PASSWORD).await;
        assert_eq!(unreachable, ConnectionRoleProbe::default());

        // A route that is not there — a Worker too old to serve /team/me, which
        // is the ordinary state for anyone who updated the app first.
        let old = fetch_connection_role(&format!("{}/nope", brain.base_url()), PASSWORD).await;
        assert_eq!(old, ConnectionRoleProbe::default());
    }

    /// Who the launch-time Worker-update prompt is for.
    ///
    /// `check_for_updates` self-updates the DESKTOP app from GitHub Releases
    /// with no Cloudflare involvement — correct, and it must keep working for
    /// everyone. The consequence is that a team member's BUNDLED Worker version
    /// races ahead of the team's DEPLOYED one purely by their keeping the app
    /// current, `is_behind` goes true on every launch, and they were shown an
    /// OK/Cancel dialog offering an update that resolves the hosting account by
    /// matching the brain's workers.dev subdomain — and so dead-ends at
    /// ErrorWrongCfAccount for anyone but the owner. Indefinitely, and
    /// *because* they kept their app up to date.
    ///
    /// Owner, not admin: a promoted team admin has no more access to that
    /// Cloudflare account than a member does.
    #[test]
    fn the_worker_update_prompt_is_the_owners_alone() {
        let member =
            ConnectionRoleProbe { role: Some("member".into()), owner: false, legacy_worker: false };
        let promoted =
            ConnectionRoleProbe { role: Some("admin".into()), owner: false, legacy_worker: false };
        let owner =
            ConnectionRoleProbe { role: Some("admin".into()), owner: true, legacy_worker: false };

        assert!(update_prompt_is_offerable(true, &owner), "the owner still gets asked");
        assert!(!update_prompt_is_offerable(true, &member), "a member must not be nagged");
        assert!(
            !update_prompt_is_offerable(true, &promoted),
            "a promoted admin has no Cloudflare account here either"
        );

        // Least privilege: a brain that could not be asked is not a brain that
        // said yes. The cost of being wrong this way is an owner who clicks
        // Update in the tray window instead; the cost of the other way is the
        // bug above.
        assert!(
            !update_prompt_is_offerable(true, &ConnectionRoleProbe::default()),
            "an unanswerable probe must suppress the prompt, not raise it"
        );

        // And a one-person brain is unchanged in every case — including the
        // unanswerable one. There is nobody on it to mislead, its owner is
        // whoever holds the token by construction, and a Worker too old to
        // answer /team/me is exactly the Worker most likely to be behind.
        for probe in [ConnectionRoleProbe::default(), member.clone(), owner.clone()] {
            assert!(update_prompt_is_offerable(false, &probe), "a solo install must not change");
        }
    }

    /// The deadlock the gate above creates on its own, and the one exception.
    ///
    /// This app self-updates from GitHub Releases with no Cloudflare
    /// involvement, and the deployed Worker can only be updated FROM this app.
    /// So the app is always AHEAD of the deployment, never behind it — and on a
    /// brain whose Worker predates the `owner` key that closes a circle:
    /// `/team/me` answers without `owner`, so nothing establishes the role, so
    /// least privilege suppresses the update prompt, so the Worker that would
    /// add `owner` is never deployed. The way out was gated on a capability
    /// only the version you are trying to reach reports.
    ///
    /// A Worker that ANSWERED and simply predates the key therefore opens this
    /// one prompt. A probe that could not be answered does not, and that is the
    /// whole distinction: `legacy_worker` is a positive identification, not a
    /// shrug. Accepting it costs a member one dismissible dialog until the
    /// owner updates once — `start_worker_update` still refuses anyone who does
    /// not hold the hosting account — and the arm is unreachable after that.
    #[test]
    fn a_worker_too_old_to_say_who_is_asking_can_still_be_updated() {
        let legacy = ConnectionRoleProbe {
            role: Some("admin".into()),
            owner: false,
            legacy_worker: true,
        };
        assert!(
            update_prompt_is_offerable(true, &legacy),
            "a brain deployed before the owner key could never be offered the update that adds it"
        );

        // And the exception is exactly one state wide. A probe that failed
        // leaves `legacy_worker` false and is still suppressed — an absent
        // answer is not an old answer.
        assert!(!update_prompt_is_offerable(true, &ConnectionRoleProbe::default()));
        assert!(!update_prompt_is_offerable(
            true,
            &ConnectionRoleProbe { role: Some("member".into()), owner: false, legacy_worker: false }
        ));
    }

    /// The flag has to survive the hop into the webview under the name the
    /// webview reads.
    ///
    /// This struct is `snake_case` and the TypeScript that narrows it is
    /// `camelCase`, so the rename is the only thing joining them — and dropping
    /// it fails silently and in exactly the worst way: `legacyWorker` would be
    /// `undefined` in the details window, every legacy brain would look like a
    /// probe that failed, and the tray window's Update button — the surface an
    /// owner actually opens — would be deadlocked again with every test still
    /// green.
    #[test]
    fn the_details_window_reads_the_flag_this_struct_writes() {
        let json = serde_json::to_value(ConnectionRoleProbe {
            role: Some("admin".into()),
            owner: false,
            legacy_worker: true,
        })
        .expect("the probe serialises");
        assert_eq!(
            json.get("legacyWorker"),
            Some(&serde_json::json!(true)),
            "the details window reads `legacyWorker`; this is what it gets: {json}"
        );

        let ts = include_str!("../../src/connection-role.ts");
        assert!(
            ts.contains("?.legacyWorker === true"),
            "installer/src/connection-role.ts must narrow the same key, strictly"
        );
    }

    /// Which bodies are a legacy Worker, and which are merely unreadable.
    ///
    /// The line is the KEY's presence, not the value's truth. `owner: "yes"`
    /// has the key and cannot be trusted, so it claims nothing; a body with no
    /// `owner` at all, alongside a role it did state, is a Worker from before
    /// the key existed. Collapsing those two would hand the update prompt to
    /// anyone who can put a surprising body in front of this app.
    #[test]
    fn only_an_absent_owner_key_counts_as_a_legacy_worker() {
        use serde_json::json;

        // The shape src/routes/admin.ts sent before `owner` existed.
        for body in [
            json!({ "ok": true, "profile": { "userId": "usr-1", "role": "admin" } }),
            json!({ "ok": true, "profile": { "userId": "usr-2", "role": "member" } }),
        ] {
            let probe = role_probe_from_body(&body);
            assert!(probe.legacy_worker, "{body} is a Worker from before the owner key");
            assert!(!probe.owner, "and it still claims no ownership");
            assert!(update_prompt_is_offerable(true, &probe));
        }

        // Everything else. None of these is a legacy Worker: either the key is
        // present (and unusable), or nothing was established at all.
        for body in [
            json!({}),
            json!(null),
            json!("not an object"),
            json!({ "ok": true, "profile": {} }),
            json!({ "ok": true, "profile": "admin" }),
            json!({ "ok": true, "profile": { "role": 42 } }),
            json!({ "ok": true, "profile": { "owner": {} } }),
            json!({ "ok": true, "profile": { "role": "member", "owner": "yes" } }),
            json!({ "ok": true, "profile": { "role": "admin", "owner": 1 } }),
            json!({ "ok": true, "profile": { "role": "admin", "owner": null } }),
            json!({ "ok": true, "profile": { "role": "member", "owner": false } }),
            json!({ "ok": true, "profile": { "role": "admin", "owner": true } }),
            json!({ "ok": false, "error": "Unauthorized" }),
        ] {
            assert!(
                !role_probe_from_body(&body).legacy_worker,
                "{body} was read as a Worker predating the owner key"
            );
        }
    }

    /// The prompt is gated; the stale-password screen is not.
    ///
    /// A member's password going stale is genuinely theirs to fix, and routing
    /// them to it needs no Cloudflare account. Gating both behind one check is
    /// the easy mistake here, so it is asserted on the source: the scan runs
    /// over the function body only, so this test's own text cannot satisfy it.
    #[test]
    fn a_dead_password_still_reaches_everyone() {
        let src = include_str!("commands.rs");
        let code = &src[..src
            .find("\n#[cfg(test)]\nmod tests {")
            .expect("the test module is the boundary of the scannable source")];
        let start = code.find("pub fn check_brain_at_launch").expect("check_brain_at_launch");
        let body = &code[start..];
        let body = &body[..body.find("\n}\n").expect("end of fn")];

        let stale = body.find("StalePassword").expect("the stale-password arm");
        let gate = body.find("worker_update_is_offerable").expect("the update gate");
        assert!(
            stale < gate,
            "the stale-password arm must return before the ownership gate — a member \
             whose password was changed elsewhere has a real problem that is theirs to fix"
        );
        let stale_arm = &body[stale..gate];
        assert!(
            !stale_arm.contains("worker_update_is_offerable"),
            "the stale-password screen must not be gated on owning the deployment"
        );
    }

    /// A 200 is not a promise about shape.
    ///
    /// Every one of these is a body some Worker could send — an older one, a
    /// proxy's error page rendered as JSON, a field that changed type — and none
    /// of them is a reason to tell the person in front of the app that they own
    /// this deployment. `owner: "yes"` is the one that matters: it is truthy,
    /// and the natural way to write this check would take it.
    #[test]
    fn an_unexpected_body_promotes_nobody() {
        use serde_json::json;
        for body in [
            json!({}),
            json!(null),
            json!({ "ok": true, "profile": {} }),
            json!({ "ok": true, "profile": { "role": "member" } }),
            json!({ "ok": true, "profile": { "role": "member", "owner": "yes" } }),
            json!({ "ok": true, "profile": { "role": "admin", "owner": 1 } }),
            json!({ "ok": true, "profile": { "role": "admin", "owner": "true" } }),
            json!({ "ok": true, "profile": { "owner": {} } }),
            json!({ "ok": false, "error": "Unauthorized" }),
        ] {
            assert!(
                !role_probe_from_body(&body).owner,
                "{body} was read as ownership"
            );
        }

        // A role that is not a string is no role at all, rather than a stringified one.
        assert_eq!(role_probe_from_body(&json!({ "profile": { "role": 42 } })).role, None);

        // And the shape src/routes/admin.ts actually sends still reads.
        let real = role_probe_from_body(&json!({
            "ok": true,
            "profile": { "userId": "usr-1", "role": "admin", "owner": true }
        }));
        assert_eq!(real.role.as_deref(), Some("admin"));
        assert!(real.owner);
        assert!(!real.legacy_worker, "a body carrying the key is not a legacy Worker");
    }

    /// A rebuild that could not be asked about is not a rebuild in progress.
    ///
    /// The gate has to fail **open**, and the only reason to state that as a rule
    /// is that failing closed is the natural way to write it. A rebuild is a rare
    /// state; a brain that cannot be reached for a moment is a Tuesday. Refusing
    /// on a failed `fetch_status` turns every blip into "you may not change your
    /// password" on the one screen that exists to change it, and hands an offline
    /// Door A user a permanent refusal whose suggested escape — Advanced
    /// Settings — is behind the same connection that just failed.
    ///
    /// Inverting that arm compiled and passed all 237 tests: the gate lived
    /// inside `rotate_password`, which takes an `AppHandle` and a Tauri `State`,
    /// so nothing could call it. It is its own function now for that reason.
    #[tokio::test]
    async fn a_rebuild_that_could_not_be_asked_about_does_not_block_a_rotation() {
        // A brain of its own: this rotates its password, and the process-wide one
        // is what every other test in the suite is mid-request against.
        let brain = crate::demo_brain::scoped_brain();
        const PASSWORD: &str = "the-password-this-rebuild-test-sets";
        crate::demo_brain::rotate_to(PASSWORD);

        // Asked and answered: a brain that has never been rebuilt does not block.
        assert!(
            !rebuild_blocks_rotation(brain.base_url(), Some(PASSWORD), Locale::En).await,
            "a brain with no ledger at all was treated as mid-rebuild"
        );

        // The one that matters. Nothing is listening on port 1, so the request
        // fails outright — and a question that could not be put is not a "yes".
        assert!(
            !rebuild_blocks_rotation("http://127.0.0.1:1", Some(PASSWORD), Locale::En).await,
            "a brain that could not be reached was reported as mid-rebuild, so a \
             network blip presents as a refusal to change a password and an \
             offline user can never change theirs"
        );

        // The same rule for a password the brain refuses: `fetch_status` comes
        // back as an error, and this computer holding a stale password is a
        // reason to change it rather than grounds to forbid changing it.
        assert!(
            !rebuild_blocks_rotation(brain.base_url(), Some("not-this-brains-password"), Locale::En)
                .await,
            "a 401 from the rebuild check locked the user out of the flow that \
             fixes exactly that"
        );

        // Door B has no password to ask with, so there is no question to put.
        assert!(
            !rebuild_blocks_rotation(brain.base_url(), None, Locale::En).await,
            "someone who has lost their password was turned away by a check that \
             needs the password they have lost"
        );

        // …and a rebuild that genuinely is outstanding still blocks, or the gate
        // above is satisfied by a function that always says no. One batch of the
        // demo brain's 1,620 entries leaves a ledger with no `finishedAt`, which
        // is the in-progress state.
        crate::migration::run_batch(brain.base_url(), PASSWORD, Locale::En)
            .await
            .expect("one re-embed batch against the demo brain");
        assert!(
            rebuild_blocks_rotation(brain.base_url(), Some(PASSWORD), Locale::En).await,
            "a rebuild is under way and the rotation was allowed through. Caught \
             half-way it leaves the next batch 401ing and the ledger stalling, so \
             a recoverable password problem presents as a failed rebuild — the \
             more frightening of the two, and the one that invites a destructive fix"
        );

        // Which Door B still cannot be asked about, rebuild or no rebuild.
        assert!(!rebuild_blocks_rotation(brain.base_url(), None, Locale::En).await);
    }

    /// Every in-memory mode is decided before secure storage is consulted.
    ///
    /// The rule this protects is not a style preference. `&&` and `else if` are
    /// short-circuiting, so a term evaluated before `load_setup()` is a term that
    /// costs no keychain read, and one evaluated after it is a term that costs an
    /// OS password prompt on an unsigned dev build — raised before the setup UI's
    /// first paint. That is #252, and demo mode, which must never see a prompt,
    /// reaches this function on every launch.
    ///
    /// The previous version of this test ordered three flag *names* against
    /// `load_setup` in the source, and never constrained the `dry_run` term at
    /// all — so rewriting `!session.dry_run && load_setup().is_some()` as
    /// `load_setup().is_some() && !session.dry_run` passed it while reintroducing
    /// the exact bug the last release fixed. `app_mode` was split out of the
    /// command so the counter can answer instead of a substring search: the
    /// prompt is an OS dialog no test can see, but the read that causes it is
    /// countable.
    #[test]
    fn every_in_memory_mode_is_decided_before_the_keychain_is_touched() {
        // The plain demo launch: no flags, nothing stored, and the `dry_run` term
        // is the only thing standing between it and the keychain.
        let demo = SetupSession::new(true);
        assert_never_reads_the_keychain("a demo launch deciding its mode", || {
            assert_eq!(app_mode(&demo), "setup");
        });

        // And each in-memory mode, on a *real* session, where the flag is the only
        // thing standing between it and the keychain. A mode moved below the
        // `load_setup()` branch still returns the right string — it just charges
        // the user a password prompt to get there, which no assertion on the
        // returned mode can see.
        fn flag_of<'a>(session: &'a SetupSession, mode: &str) -> &'a std::sync::Mutex<bool> {
            match mode {
                "change-password" => &session.pending_rotation,
                "stale-password" => &session.stale_password,
                "worker-update" => &session.pending_worker_update,
                other => panic!("no in-memory flag selects {other}"),
            }
        }
        for mode in ["change-password", "stale-password", "worker-update"] {
            let live = SetupSession::new(false);
            *flag_of(&live, mode).lock().unwrap() = true;
            assert_never_reads_the_keychain(mode, || {
                assert_eq!(app_mode(&live), mode);
            });
        }
    }

    /// A demo rotation runs the real pipeline and reaches the keychain zero times.
    ///
    /// Counted rather than grepped, for the reason `demo_mode_never_reads_the_keychain`
    /// sets out: every read can raise an OS password prompt on an unsigned dev
    /// build, a source scan cannot express "not inside the dry-run branch", and a
    /// guard written that way passed while the bug was reintroduced.
    ///
    /// The brain is scoped to this test, which is what lets the password be a
    /// real one. The process-wide demo brain outlives every test, so rotating
    /// *that* to anything other than the token everyone else sends starts 401ing
    /// whatever is mid-request against it — measured at 10 failures in 15 runs at
    /// `RUST_TEST_THREADS=64`. Rotating it to `DEFAULT_TOKEN` was the way round
    /// that, and it cost the assertion that matters most: a rotation that flipped
    /// nothing looked identical to one that worked. With a brain of its own this
    /// can set a password no other test has ever sent and then insist the brain is
    /// holding it.
    #[tokio::test]
    async fn a_demo_rotation_runs_the_real_path_and_never_reads_the_keychain() {
        let _brain = crate::demo_brain::scoped_brain();
        const NEW: &str = "a-password-only-this-test-sets";

        let session = SetupSession::new(true);
        *session.pending_rotation.lock().unwrap() = true;

        // Sampled rather than counted once. The read probe is a process-global
        // counter and the suite runs in parallel, so a single sample can pick up
        // another test's keychain access and report it against this path. A
        // sample that caught someone else proves nothing either way — but a path
        // that reads the keychain contaminates *every* sample, so one clean
        // sample is the proof and repeated dirty ones are the failure.
        //
        // `checked_sub`, because another test resetting the counter mid-sample
        // makes `after` smaller than `before`: the plain subtraction underflowed
        // and panicked, and a saturating one would have reported the false zero
        // that passes this test no matter what the code does.
        crate::secure_store::probe::reset();
        let refreshed_with = std::sync::Mutex::new(Vec::new());
        let mut outcome = None;
        let mut dirty = Vec::new();
        let mut inconclusive = 0;
        for _ in 0..8 {
            let before = crate::secure_store::probe::reads();
            let attempt = rotate_demo_password(
                NEW,
                &session,
                Locale::En,
                |_| {},
                |token| {
                    refreshed_with.lock().unwrap().push(token.to_string());
                    true
                },
            )
            .await
            .expect("the demo brain must accept the password the demo just set");
            match crate::secure_store::probe::reads().checked_sub(before) {
                Some(0) => {
                    outcome = Some(attempt);
                    break;
                }
                Some(n) => dirty.push(n),
                None => inconclusive += 1,
            }
        }
        let outcome = outcome.unwrap_or_else(|| {
            panic!(
                "no sample of a demo rotation came back clean (reads: {dirty:?}, \
                 {inconclusive} inconclusive) — that is the OS password prompt users \
                 see, and a demo password has no business in a real keychain"
            )
        });

        assert!(
            crate::cf::backend::probe::secret_puts()
                .contains(&("second-brain".to_string(), "AUTH_TOKEN".to_string())),
            "the rotation never reached the backend, so the demo proves nothing \
             about the thing it is demonstrating"
        );
        assert_eq!(
            crate::demo_brain::auth_token(),
            NEW,
            "the demo brain is still on the password it started with, so the \
             rotation reported a change that did not happen — which is the one \
             thing a demo of a password change has to get right"
        );
        assert_ne!(
            NEW,
            crate::demo_brain::DEFAULT_TOKEN,
            "the assertion above is only worth making about a password no other \
             caller in this suite already sends"
        );
        assert!(outcome.keychain);
        assert_eq!(
            outcome.cli_config, None,
            "a demo run must not write a plaintext credential file"
        );
        // The dashboard is the one store a demo rotation genuinely has to touch,
        // and it used to be hard-coded to `true` without anything being called.
        // An open wrapper window keeps the token it was created with, in demo mode
        // exactly as in a real one — so skipping it left the demo window 401ing
        // against the demo brain while the done screen said it was fine, which is
        // the single behaviour the dry-run-fidelity argument exists to demonstrate.
        assert_eq!(
            refreshed_with.lock().unwrap().last().map(String::as_str),
            Some(NEW),
            "the open dashboard window was never handed the new password"
        );
        assert!(outcome.dashboard, "…and the result is reported, not assumed");
        assert!(
            !*session.pending_rotation.lock().unwrap(),
            "a finished rotation must leave the flow"
        );
    }

    /// A refused refresh is reported as refused, in demo mode too. The `true` that
    /// used to be written here was a constant, so nothing could have told the
    /// difference.
    #[tokio::test]
    async fn a_demo_rotation_reports_a_dashboard_it_could_not_reach() {
        let _brain = crate::demo_brain::scoped_brain();
        let session = SetupSession::new(true);
        let outcome = rotate_demo_password(
            "another-password-only-this-test-sets",
            &session,
            Locale::En,
            |_| {},
            |_| false,
        )
        .await
        .expect("the demo brain must accept the password the demo just set");
        assert!(!outcome.dashboard);
    }

    // ── The doors, the guards, and the order they run in ─────────────────────

    /// A rotation is the one operation that sends a password the user has never
    /// used before, as a bearer token, to an address they just typed — and then
    /// *stores* that address. `http://` there is not a dev convenience, it is a
    /// password in cleartext on the wire and an origin that makes every later
    /// request from the app and from the `brain` command cleartext as well.
    /// `reqwest` performs no HSTS upgrade, so nothing downstream corrects it.
    #[test]
    fn a_typed_rotation_address_may_not_be_cleartext() {
        for input in [
            "http://second-brain.acme.workers.dev",
            "HTTP://second-brain.acme.workers.dev",
            "http://localhost:8787",
            "http://second-brain.acme.workers.dev/mcp",
        ] {
            assert!(
                rotation_address(input, Locale::En).is_err(),
                "{input} was accepted, so the new password goes out unprotected and \
                 an http:// origin is written to the keychain and the plaintext CLI \
                 config for every request after it"
            );
        }

        // …and the ordinary case still works, including the bare host the manual
        // entry screen invites.
        for input in [
            "https://second-brain.acme.workers.dev",
            "second-brain.acme.workers.dev",
            "  second-brain.acme.workers.dev/mcp  ",
        ] {
            assert_eq!(
                rotation_address(input, Locale::En).unwrap(),
                "https://second-brain.acme.workers.dev",
                "input: {input:?}"
            );
        }

        // The general normaliser still keeps http for the dev setups that need it,
        // so this refusal has to live on the rotation path and cannot be delegated.
        assert_eq!(
            normalize_worker_url("http://localhost:8787/mcp", Locale::En).unwrap(),
            "http://localhost:8787"
        );
    }

    /// The two doors resolve their address from different places, and the typed
    /// one carries the cleartext refusal with it.
    ///
    /// Door A goes through `dashboard_credentials`, never `secure_store` directly
    /// (#252), and comes back with the password this computer already holds —
    /// which is what the migration check below needs and Door B does not have.
    #[test]
    fn each_door_resolves_the_brain_it_is_allowed_to_resolve() {
        // Door A resolves through the demo brain, so this needs one whose password
        // no other test can move underneath it.
        let _brain = crate::demo_brain::scoped_brain();
        let session = SetupSession::new(true);

        // Door B: the address is typed, so there is no current password…
        let (url, current) =
            rotation_target(&session, Locale::En, Some("second-brain.acme.workers.dev".into()))
                .expect("a typed https address resolves");
        assert_eq!(url, "https://second-brain.acme.workers.dev");
        assert_eq!(
            current, None,
            "someone who has lost their password has none to offer, which is why \
             every check that needs one is skipped for this door rather than failed"
        );

        // …and cleartext is refused here too, not only in the screen's validator.
        assert!(
            rotation_target(&session, Locale::En, Some("http://second-brain.acme.workers.dev".into()))
                .is_err()
        );

        // Door A: resolved from the session, with the password this computer holds.
        let (url, current) =
            rotation_target(&session, Locale::En, None).expect("a connected computer resolves");
        assert_eq!(url, crate::demo_brain::base_url());
        assert_eq!(current.as_deref(), Some("demo"));
    }

    /// The screen that checks an address must refuse exactly what the command
    /// would refuse.
    ///
    /// One implementation, two callers, is the whole point of `validate_brain_address`
    /// — a screen that waves something through only moves the refusal several
    /// screens later, to the place where the user has already committed. Pointing
    /// it back at `normalize_worker_url` compiles, passes every behavioural test
    /// here, and quietly re-opens the cleartext door on the one path where the
    /// address is typed by hand.
    #[test]
    fn the_address_screen_refuses_exactly_what_the_command_refuses() {
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub async fn validate_brain_address(");
        assert!(
            body.contains("rotation_address"),
            "the screen's validator no longer shares the command's check"
        );
        assert!(
            !body.contains("normalize_worker_url"),
            "the screen normalises the address itself, so it accepts the `http://` \
             the command would refuse — and reports the problem several screens \
             after the one that could have prevented it"
        );
        assert!(
            body.contains("confirm_target_is_a_brain"),
            "…and it must still be the same brain check, not merely a URL parse"
        );
    }

    /// Door B's address was typed or picked, so it is confirmed to be a brain from
    /// Cloudflare's own record of the account before a secret is written to it.
    ///
    /// The Cloudflare account match cannot catch a typo that lands on a *different
    /// Worker of the user's own* — that script is in the right account, so the only
    /// thing left to check is what it is. Getting it wrong overwrites an unrelated
    /// Worker's `AUTH_TOKEN` while telling the user their brain's password changed.
    #[tokio::test]
    async fn an_address_with_no_script_to_name_is_refused_before_any_secret_is_written() {
        let session = SetupSession::new(true);

        assert_eq!(
            confirm_target_is_a_brain("https://brain.example.com", &session, Locale::En)
                .await
                .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorCustomDomain),
            "a custom domain yields no script name, and #257 says the script name \
             comes from the address or not at all"
        );

        // A real workers.dev address goes on to read the account's bindings.
        confirm_target_is_a_brain("https://second-brain.demo.workers.dev", &session, Locale::En)
            .await
            .expect("the demo account's bindings look like a brain");
    }

    /// …and a Worker that is not a brain is refused, however right its account is.
    ///
    /// The negative half of the test above, and the half that was missing. Both
    /// cases it covered — a custom domain, and the app's own brain — are decided
    /// before this check or by it saying yes, so replacing the decision itself
    /// with `Ok(())` left all 237 tests green while removing the only thing
    /// standing between a mistyped address and someone else's Worker.
    ///
    /// The account match cannot help here, which is the whole point: every script
    /// listed below is in the user's *own* Cloudflare account, reached at their
    /// own `workers.dev` subdomain, and a Door B typo — one letter of a script
    /// name — is how a user lands on one. Accepted, the flow writes `AUTH_TOKEN`
    /// onto it and reports that the brain's password has changed: the brain is
    /// untouched and still on the old password, and something the user never
    /// named has been altered.
    ///
    /// Driven through `bindings_are_a_brains` rather than
    /// `confirm_target_is_a_brain` because there is no backend a test can reach
    /// that answers with anything but a brain's bindings — the wire between the
    /// two is asserted at the bottom.
    #[test]
    fn a_worker_that_is_not_a_brain_is_refused_however_right_its_account_is() {
        let vectorize = |index: &str| {
            serde_json::json!({ "type": "vectorize", "name": "VECTORIZE", "index_name": index })
        };
        let d1 = || serde_json::json!({ "type": "d1", "name": "DB", "database_id": "abc" });
        let kv = || serde_json::json!({ "type": "kv_namespace", "name": "OAUTH_KV" });
        let a_brains_index = brain_index_names()
            .first()
            .expect("this build knows what index its own brains are on")
            .clone();

        for (what, bindings) in [
            ("a Worker with no bindings at all", vec![]),
            ("their own API, with a database and no vector index", vec![d1(), kv()]),
            (
                "their own search Worker, on an index of its own",
                vec![d1(), vectorize("acme-docs-vectors")],
            ),
            (
                "a brain's index name with no database behind it",
                vec![vectorize(&a_brains_index), kv()],
            ),
            (
                "a database and a vector index that is not one a brain uses",
                vec![d1(), vectorize("second-brain-vectors-backup")],
            ),
        ] {
            assert_eq!(
                bindings_are_a_brains(&bindings, Locale::En).unwrap_err(),
                i18n::t(Locale::En, Key::ErrorNotABrain),
                "{what} was accepted as a brain. A Door B typo then overwrites its \
                 AUTH_TOKEN while telling the user their brain's password changed."
            );
        }

        // …and every index one of this build's own brains could legitimately be
        // on is accepted, including the ones an embedding migration moved it to.
        // Refusing those tells a user who changed how their brain reads that
        // their own brain is not a brain.
        for name in brain_index_names() {
            assert!(
                bindings_are_a_brains(&[d1(), vectorize(&name), kv()], Locale::En).is_ok(),
                "{name} is an index this app's own brains are on, and it was refused"
            );
        }

        // The wire. The decision is only worth pinning while the command that
        // reads the bindings still ends in it, and that is exactly what a test
        // driving the decision directly cannot see.
        let src = include_str!("commands.rs");
        let body = fn_body(src, "async fn confirm_target_is_a_brain(");
        assert!(
            at(body, "get_script_bindings") < at(body, "bindings_are_a_brains(&bindings, locale)"),
            "the brain check no longer decides on the bindings it just read"
        );
        assert!(
            !body.contains("\n    Ok(())"),
            "confirm_target_is_a_brain reports success without consulting anything \
             — which is the mutation this whole test exists for"
        );
    }

    /// The order of `rotate_password`, which is the whole of its safety argument.
    ///
    /// Three mutations of this function compiled with all 208 tests passing:
    /// deleting the Door B brain check, deleting the migration gate, and turning
    /// the remote change's `?` into `.ok()` so the local writes ran even when the
    /// remote change had failed. That last one is the outcome this module's own
    /// doc calls unrecoverable — the brain keeps the old password, nothing on this
    /// computer holds it, and the app has no way to ask for it back.
    ///
    /// Asserted on the source because the function takes an `AppHandle` and a
    /// Tauri `State`, neither of which a unit test can construct, and because
    /// reaching step 4 needs a live Cloudflare account. What each step *does* is
    /// tested behaviourally elsewhere in this module; what nothing else can see is
    /// that they are still wired together in this order.
    #[test]
    fn the_rotation_does_the_remote_change_first_and_only_persists_if_it_worked() {
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub async fn rotate_password(");

        let door_b = at(body, "if door_b {");
        let confirm = at(body, "confirm_target_is_a_brain");
        // The gate moved into `rebuild_blocks_rotation` so that its fail-open
        // rule could be exercised at all — see
        // `a_rebuild_that_could_not_be_asked_about_does_not_block_a_rotation`.
        // The ordering it has to keep is unchanged, and this is still the only
        // thing that can see it.
        let blocked = at(body, "rebuild_blocks_rotation");
        let remote = at(body, "provision::rotate_secret");
        let persist = at(body, "rotate::persist");

        assert!(
            door_b < confirm && confirm < remote,
            "the Door B brain check must run, and must run before the secret is \
             written — a typo that lands on another Worker of the user's own is in \
             the right Cloudflare account and passes every other check"
        );
        assert!(
            blocked < remote,
            "the rebuild gate must refuse before the secret is written: a rotation \
             caught half-way leaves the next batch 401ing and a recoverable password \
             problem presenting as a failed migration"
        );
        assert!(
            at(body, "return Err(rotation_block") < remote,
            "the rebuild gate no longer returns — it computes a block and carries on"
        );
        assert!(
            remote < persist,
            "the local stores are written before the brain has taken the new \
             password. Reversing this is the one failure #235 cannot recover from."
        );

        // The `?` itself. `.ok()` here compiles, keeps the ordering above intact,
        // and runs every local write over a remote change that failed.
        //
        // Read as one statement, bounded by the blank line that ends it, rather
        // than as everything between the call and `persist`: the local step's
        // progress emit sits in that gap and discards its own result on purpose,
        // which a looser scan reads as the remote failure being swallowed.
        let call = {
            let tail = &body[remote..];
            &tail[..tail
                .find("\n\n")
                .expect("the remote change is one statement, ending in a blank line")]
        };
        assert!(
            call.contains("})?;"),
            "the remote change's failure is no longer propagated, so `persist` runs \
             whether or not the brain took the new password"
        );
        for swallowed in [".ok()", ".unwrap_or", "let _ ="] {
            assert!(
                !call.contains(swallowed),
                "the remote change's failure is discarded with `{swallowed}`"
            );
        }
    }

    /// The checklist's third row is reported by this command or by nobody.
    ///
    /// `rotate_secret` emits `Secret` and `Confirm` itself; `Local` cannot live
    /// there, because nothing local may be written until that function has
    /// returned. So the emit sits here, and an emit that only one caller can make
    /// is an emit that goes missing quietly: the row renders as a static bullet
    /// for the whole run, on the screen whose entire job is to show the user which
    /// part of a password change they are waiting on.
    ///
    /// `Step::Local` no longer carries an `#[allow(dead_code)]`, so deleting the
    /// emit is also a warning — this pins the ordering, which the compiler cannot
    /// see.
    #[test]
    fn the_local_writes_report_themselves_to_the_checklist() {
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub async fn rotate_password(");

        assert!(
            at(body, "provision::Step::Local") < at(body, "rotate::persist"),
            "the local step is declared after the writes it is meant to announce"
        );
        let running = at(body, "emit_local(provision::StepStatus::Running)");
        let persist = at(body, "rotate::persist");
        let done = at(body, "emit_local(provision::StepStatus::Done)");
        assert!(
            running < persist && persist < done,
            "the row has to go Running *before* the writes and Done *after* them, \
             or it reports a step the user has already sat through"
        );

        // The same channel as every other step. A different event name drops the
        // row silently — the window is listening on one name and nothing errors.
        assert!(
            body[..running].contains(r#"app.emit(
            "setup-progress","#),
            "the local step is emitted on a channel the rotation screen is not \
             listening to"
        );

        // And the one hard failure ends in `Error` rather than an unreported
        // early return: `persist` cannot run at all without a home directory.
        let hard_failure = at(body, "dirs::home_dir()");
        assert!(
            body[hard_failure..persist].contains("emit_local(provision::StepStatus::Error)"),
            "a rotation that cannot write anything locally leaves the row spinning \
             forever while the failure screen renders behind it"
        );
    }

    /// `persist` takes its secure-storage write as a seam, so that one line in
    /// `rotate_password` is the entire connection between a password change and
    /// the store the app reads at every launch.
    ///
    /// The seam is what makes `persist`'s own failure branch reachable — the test
    /// backend cannot fail — and what stops its tests writing the process-global
    /// map that `secure_store`'s end-to-end test asserts on. The cost is this one
    /// wire, which nothing else can see.
    #[test]
    fn the_rotation_hands_persist_the_real_secure_store() {
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub async fn rotate_password(");
        let persist = at(body, "rotate::persist");
        let call = &body[persist..];
        assert!(
            call.contains("secure_store::save_setup"),
            "`persist` is no longer given the real store, so `keychain: true` would \
             tell the user their computer holds a password it does not have"
        );
        // Searched in the tail after `persist`, not in the whole body: the
        // dry-run branch at the top of this function refreshes a window too, and
        // an unanchored search would find that one and prove nothing about this
        // call.
        assert!(
            call.contains("windows::refresh_wrapper_token"),
            "…and the open dashboard window is no longer told either"
        );
    }

    /// A finished rotation leaves the change-your-password flow — on the live
    /// path as well as the demo one.
    ///
    /// `a_demo_rotation_runs_the_real_path_and_never_reads_the_keychain` asserts
    /// this of `rotate_demo_password`, which a test can call. The live half
    /// cannot be called at all: it takes an `AppHandle` and a Tauri `State`, and
    /// reaching its last lines needs a real Cloudflare account. So deleting the
    /// clear from *that* half left every test green, and what it ships is
    /// `app_mode` returning `"change-password"` for the rest of the session and
    /// the next launch reopening the password-change screen over a password that
    /// has just been successfully changed. That is the wedge
    /// `walking_away_from_a_password_change_does_not_wedge_the_next_flow`
    /// exists to prevent, reached through the door that *worked* — and the user
    /// has no way to tell that their change did land.
    ///
    /// Source-scanned for that reason, and both anchors are `expect`ed: an
    /// ordering assertion whose landmark has been deleted must fail rather than
    /// quietly compare a missing position against something.
    #[test]
    fn a_finished_rotation_leaves_the_password_change_flow_on_the_live_path_too() {
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub async fn rotate_password(");

        let persist = at(body, "rotate::persist");
        let cleared = at(body, "clear_pending_rotation");
        let ok = at(body, "Ok(outcome)");

        assert!(
            persist < cleared && cleared < ok,
            "the flow is left before the rotation has finished doing its work, or \
             not at all — it has to be cleared on the way out of the success path"
        );
        assert!(
            persist < at(body, "*session.stale_password.lock().unwrap() = false"),
            "a rotation is also the answer to \"your password was changed \
             elsewhere\", and a flag nothing clears keeps telling the user that \
             about the password they have just set themselves"
        );
    }

    /// Abandoning a password change leaves the flow.
    ///
    /// `pending_rotation` was cleared only on success and on logout, and
    /// `app_mode` consults it before everything else — so "Not now" left it set,
    /// and the next "Update your Second Brain" opened the *password-change* screen
    /// instead of the update. Nothing short of restarting the app put it right.
    #[test]
    fn walking_away_from_a_password_change_does_not_wedge_the_next_flow() {
        let session = SetupSession::new(true);
        *session.pending_rotation.lock().unwrap() = true;
        assert_eq!(app_mode(&session), "change-password");

        clear_pending_rotation(&session);
        assert_eq!(
            app_mode(&session),
            "setup",
            "the abandoned flow still owns the window"
        );

        // …and the exit the front end actually takes is wired to it. "Not now"
        // opens the dashboard, which closes the setup window on the next line —
        // `open_dashboard_impl` needs an `AppHandle`, so the wiring is what is
        // checkable here and the clearing itself is asserted above.
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub fn open_dashboard_impl(");
        assert!(
            at(body, "clear_pending_rotation") < at(body, "close_setup_windows"),
            "leaving for the dashboard must drop the password-change flow before the \
             window that was running it is closed"
        );
    }

    /// Windows report: "Apri il mio Second Brain" after setup opened a blank
    /// Not Responding window. Root cause is wry#583 — `WebviewWindowBuilder::build`
    /// deadlocks when called from a synchronous Tauri command on the WebView2 UI
    /// thread. Menu/tray stay sync because they are not IPC.
    ///
    /// Source-scanned: there is no GUI in this suite, only the absence of a hang
    /// to preserve. `fn_body` panics if a signature regresses to `pub fn`.
    #[test]
    fn ipc_window_openers_are_async_to_avoid_webview2_deadlock() {
        let src = include_str!("commands.rs");
        for (signature, must_call) in [
            (
                "pub async fn open_dashboard(",
                "open_dashboard_impl",
            ),
            (
                "pub async fn open_dashboard_integrations(",
                "windows::open_wrapper_window_integrations",
            ),
            (
                "pub async fn open_details_window(",
                "windows::open_details_window",
            ),
            (
                "pub async fn open_settings_window(",
                "windows::open_settings_window",
            ),
            (
                "pub async fn begin_worker_update(",
                "windows::open_setup_window",
            ),
            (
                "pub async fn begin_password_change(",
                "windows::open_setup_window",
            ),
            (
                "pub async fn logout(",
                "perform_logout",
            ),
        ] {
            let body = fn_body(src, signature);
            assert!(
                body.contains(must_call),
                "{signature} no longer opens its window via `{must_call}`"
            );
        }
        // A sync twin left beside the async IPC entry would reintroduce the hang
        // for any caller that picked the wrong name. `fn_body` already requires
        // the async signatures; also refuse a non-async `open_dashboard(` command.
        let code = &src[..src
            .find("\n#[cfg(test)]\nmod tests {")
            .expect("the test module is the boundary of the scannable source")];
        for sync_name in [
            "open_dashboard",
            "open_dashboard_integrations",
            "open_details_window",
            "open_settings_window",
            "begin_worker_update",
            "begin_password_change",
            "logout",
        ] {
            assert!(
                !code.contains(&format!("pub fn {sync_name}(")),
                "{sync_name} must not regain a sync IPC signature (WebView2 deadlock on Windows)"
            );
        }

        // Any other sync #[tauri::command] that reaches a window opener is the
        // same footgun — scan the whole file rather than maintaining a name list.
        let opener_needles = [
            "windows::open_setup_window",
            "windows::open_wrapper_window",
            "windows::open_wrapper_window_integrations",
            "windows::open_details_window",
            "windows::open_settings_window",
            "crate::windows::open_settings_window",
            "WebviewWindowBuilder",
            "open_dashboard_impl",
            "perform_logout",
        ];
        let mut search = code;
        let mut sync_offenders: Vec<String> = Vec::new();
        while let Some(attr_at) = search.find("#[tauri::command]") {
            let after_attr = &search[attr_at + "#[tauri::command]".len()..];
            let trimmed = after_attr.trim_start();
            if trimmed.starts_with("pub async fn ") {
                search = &after_attr[1..];
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("pub fn ") {
                let name_end = rest.find('(').unwrap_or(0);
                let name = &rest[..name_end];
                let body = fn_body(src, &format!("pub fn {name}("));
                if opener_needles.iter().any(|n| body.contains(n)) {
                    sync_offenders.push(name.to_string());
                }
                search = &after_attr[1..];
                continue;
            }
            search = &after_attr[1..];
        }
        assert!(
            sync_offenders.is_empty(),
            "sync #[tauri::command] still reach window openers (WebView2 deadlock): {sync_offenders:?}"
        );
    }

    /// Fixing a stale password has to *fix* it.
    ///
    /// `stale_password` is set at launch when the brain refuses the password this
    /// computer holds, and `connect_existing` is the screen's first offer — enter
    /// the new one. Nothing cleared the flag, so after a successful reconnection
    /// `app_mode` still returned `"stale-password"` and the next
    /// `begin_worker_update` told the user again that their password had been
    /// changed elsewhere, about a password that now works.
    ///
    /// Source-scanned because `connect_existing` takes an `AppHandle` and probes a
    /// live Worker; what is checkable is that the clear happens on the success
    /// path — after the probe and the store write, not before them.
    #[test]
    fn a_reconnection_clears_the_password_changed_elsewhere_flag() {
        let src = include_str!("commands.rs");
        let body = fn_body(src, "pub async fn connect_existing(");
        let cleared = at(body, "stale_password");
        assert!(
            at(body, "probe_worker") < cleared && at(body, "secure_store::save_setup") < cleared,
            "the flag is cleared before the new password has been shown to work, so \
             a wrong one would silently dismiss the screen that was asking for it"
        );
        assert!(
            cleared < at(body, "*session.outcome.lock()"),
            "the flag must be cleared on the way out of the success path"
        );
    }

    /// Resolving which Cloudflare account holds a brain was written out twice —
    /// once in `start_worker_update` and once in `cloudflare_client_for_brain`.
    /// Rotation is the third caller, so the copy went. This pins the errors the
    /// shared helper raises and the order it raises them in, which is what
    /// `start_worker_update` used to do inline.
    ///
    /// Every case here returns before any network call: a custom domain and a
    /// missing sign-in are refused up front, and an empty account list never
    /// enters the loop.
    #[tokio::test]
    async fn the_shared_account_lookup_refuses_in_the_same_order_the_inline_copy_did() {
        let session = SetupSession::new(false);

        assert_eq!(
            cloudflare_client_for_brain("https://brain.example.com", &session, Locale::En)
                .await
                .map(|_| ())
                .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorCustomDomain),
            "a custom domain yields no subdomain to match, and retrying cannot help"
        );

        assert_eq!(
            cloudflare_client_for_brain(
                "https://second-brain.acme.workers.dev",
                &session,
                Locale::En
            )
            .await
            .map(|_| ())
            .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorCfSignInFirst),
            "no Cloudflare session yet"
        );

        *session.tokens.lock().unwrap() = Some(Tokens {
            access_token: "cf-access-token".into(),
            refresh_token: None,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
        });
        session.accounts.lock().unwrap().push(Account {
            id: "acct-1".into(),
            name: "Some other space".into(),
        });
        // The account list is scanned, nothing matches `acme`, and the message
        // names the real problem rather than a generic failure.
        //
        // Left un-run against the network deliberately: with one account this
        // would make a live request, so the assertion below is the empty-list
        // case, which is the same branch.
        session.accounts.lock().unwrap().clear();
        assert_eq!(
            cloudflare_client_for_brain(
                "https://second-brain.acme.workers.dev",
                &session,
                Locale::En
            )
            .await
            .map(|_| ())
            .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorWrongCfAccount),
        );
    }

    /// …and that `start_worker_update` actually calls it. The behavioural test
    /// above pins the helper; this pins that the inline copy is gone, because a
    /// second copy left behind would keep passing every test while quietly
    /// drifting.
    #[test]
    fn the_worker_update_resolves_its_account_through_the_shared_helper() {
        let src = include_str!("commands.rs");
        let start = src.find("pub async fn start_worker_update").expect("the command");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("end of fn")];

        assert!(
            body.contains("cloudflare_client_for_brain"),
            "start_worker_update must resolve its account through the shared helper"
        );
        assert!(
            !body.contains("get_account_subdomain"),
            "start_worker_update still enumerates accounts itself — that is the \
             copy rotation was meant to remove"
        );
    }

    /// The re-check has three answers, and the screen renders three things.
    ///
    /// Yes, no, and could-not-ask. `recheckUnreachable` is copy written for that
    /// third one, and it only has something to carry while the three stay apart —
    /// turning the `Unauthorized` arm into an error compiled and passed
    /// everything, which merges "your password is not the one that works" into
    /// "we could not reach your brain" and sends a user who only had to try their
    /// other password off to check their network instead.
    ///
    /// The last section is the probe itself, which was `worker_health_ok` until
    /// this branch changed it. `/health` reports `ok` as the *vector index's*
    /// health, so that call answered a question about Vectorize on the one screen
    /// that exists to tell someone whether their password changed — and a brain
    /// with a degraded index says "no" about a password that is live and is now
    /// the only one that opens it.
    #[tokio::test]
    async fn the_password_recheck_has_three_answers_and_asks_only_about_the_password() {
        let brain = crate::demo_brain::scoped_brain();
        const PASSWORD: &str = "the-password-this-recheck-test-sets";
        crate::demo_brain::rotate_to(PASSWORD);

        assert_eq!(
            password_opens_brain(brain.base_url(), PASSWORD, Locale::En).await,
            Ok(true),
            "the brain's own password did not open it"
        );
        assert_eq!(
            password_opens_brain(brain.base_url(), "not-this-brains-password", Locale::En).await,
            Ok(false),
            "a refused password must come back as an answer, not a fault: this \
             screen is asking a yes/no question and \"no\" is one of the answers \
             it was opened to receive"
        );
        assert_eq!(
            password_opens_brain("http://127.0.0.1:1", PASSWORD, Locale::En).await,
            Err(i18n::t(Locale::En, Key::ErrorReachBrain).to_string()),
            "\"could not ask\" is the third answer, and reporting it as `false` \
             tells someone their new password does not work when nothing was ever \
             asked — on the screen they opened because they did not know"
        );

        // Surrounding whitespace is not a wrong password. The field is one a user
        // pastes into.
        assert_eq!(
            password_opens_brain(brain.base_url(), &format!("  {PASSWORD}\n"), Locale::En).await,
            Ok(true),
            "a pasted password with whitespace around it was reported as refused"
        );

        // The probe asks about the password and nothing else. A path the brain
        // does not serve answers 404 *after* authenticating, so the password was
        // accepted and the answer is still yes — where `worker_health_ok` would
        // say no, because it reads any non-200 (and any `vectorize.ok: false`) as
        // a refusal. Those are the same branch of the same function; the degraded
        // index is the case that matters and no demo brain here can be made to
        // report one, so this is the reachable half of it.
        assert_eq!(
            password_opens_brain(&format!("{}/not-a-route", brain.base_url()), PASSWORD, Locale::En)
                .await,
            Ok(true),
            "the re-check answered \"your password does not work\" about a brain \
             that had just accepted it, because it asked whether the brain was \
             well rather than whether it was open"
        );

        // …and the probe named, because the case above is a stand-in for the one
        // that cannot be staged.
        let src = include_str!("commands.rs");
        let body = fn_body(src, "async fn password_opens_brain(");
        assert!(
            body.contains("worker_auth_ok"),
            "the re-check no longer asks whether the password is accepted"
        );
        assert!(
            !body.contains("worker_health_ok"),
            "the re-check is back on the full health contract, so a brain with a \
             degraded vector index tells its owner their password did not change"
        );
    }

    /// Disconnecting the AI tools: the one action whose whole value is that its
    /// report can be believed, and the one command in this module that had no
    /// test of any kind.
    ///
    /// Rotation deliberately does not reach these tools — they hold
    /// provider-issued tokens validated against KV, not the brain's password —
    /// which is why this is offered separately, and why what it reports is the
    /// only evidence the user gets that a door was closed.
    #[tokio::test]
    async fn disconnecting_ai_tools_sends_the_password_and_passes_the_count_through() {
        let brain = crate::demo_brain::scoped_brain();
        const PASSWORD: &str = "the-password-this-revoke-test-sets";
        crate::demo_brain::rotate_to(PASSWORD);

        let body = revoke_all_tools(brain.base_url(), PASSWORD, Locale::En)
            .await
            .expect("the brain's own password opens the route that closes the tools");
        assert_eq!(body["ok"], true);
        assert_eq!(
            body["revoked"], 2,
            "the Worker's own count, passed through rather than summarised: it is \
             what tells the user how many tools were holding access"
        );
        assert_eq!(
            body["failed"], 0,
            "`failed` is the case this control exists for — a tool that kept its \
             access — so it has to survive the trip to the screen"
        );

        // Pressing it a second time reports nothing left, rather than closing the
        // same two again. The pass-through is only worth anything if the number
        // moves.
        let again = revoke_all_tools(brain.base_url(), PASSWORD, Locale::En)
            .await
            .expect("nothing left to close is still a success");
        assert_eq!(again["revoked"], 0);

        // The brain's password is what makes the request. Without it this route
        // 401s like every other, and the user is shown a failure for a door that
        // was never even asked to close — which fails safe, and is why nothing
        // noticed the token was gone.
        let refused = revoke_all_tools(brain.base_url(), "not-this-brains-password", Locale::En)
            .await
            .expect_err("a brain must not revoke anything for a password it refuses");
        assert!(
            refused.contains("401"),
            "the status the brain gave is what makes this diagnosable: {refused}"
        );

        // …and a brain that could not be reached at all says something else
        // again, because the two send the user to different places.
        assert_eq!(
            revoke_all_tools("http://127.0.0.1:1", PASSWORD, Locale::En)
                .await
                .unwrap_err(),
            i18n::t(Locale::En, Key::ErrorReachBrain),
        );
    }

    #[test]
    fn dashboard_credentials_dry_run_uses_the_local_demo_brain() {
        let _brain = crate::demo_brain::scoped_brain();
        let session = SetupSession::new(true);
        *session.outcome.lock().unwrap() = Some(ProvisionOutcome {
            worker_url: "https://second-brain.demo.workers.dev".into(),
            mcp_url: "https://second-brain.demo.workers.dev/mcp".into(),
        });
        let (url, token) = dashboard_credentials(&session, Locale::En).unwrap();
        assert_eq!(url, crate::demo_brain::base_url());
        assert!(url.starts_with("http://127.0.0.1:"), "got {url}");
        assert_eq!(token, "demo");
    }
}
