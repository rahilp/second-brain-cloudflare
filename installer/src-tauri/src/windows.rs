//! Window construction for the app's three windows:
//!   main    — the bundled setup flow (first run only)
//!   brain   — the user's remote dashboard, wrapped (every run after setup)
//!   details — the local "Connection details" panel
//!
//! The `brain` window is remote content: it gets NO Tauri IPC (it isn't listed
//! in any capability). The only things injected are the dashboard's own
//! localStorage auth keys, guarded so they're set solely on the user's own
//! Worker origin, and the Connections sidebar button below.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Clicking the injected Connections button navigates here. The navigation is
/// cancelled in `on_navigation` and turned into a native window instead, so the
/// remote page still needs no IPC to reach it. The path is one the dashboard
/// does not route, so nothing is lost if the interception ever fails.
const CONNECTIONS_PATH: &str = "/__sb-connections";

/// Adds a "Connections" entry to the dashboard's own sidebar footer, next to
/// Settings, reusing the dashboard's `sb-footer-btn` class so it inherits the
/// real styling rather than floating over the page. Injected rather than shipped
/// in the dashboard so it appears regardless of which Worker version the user
/// has deployed. Polls because the init script runs at document-start, and is
/// idempotent so a re-render cannot produce two buttons. The label is English to
/// match the surrounding dashboard, which is not localized.
const CONNECTIONS_BUTTON_JS: &str = r#"(function () {
  var ID = 'sb-desktop-connections';
  var tries = 0;
  var iv = setInterval(function () {
    if (document.getElementById(ID)) { clearInterval(iv); return; }
    var footer = document.querySelector('.sb-footer');
    if (footer) {
      var b = document.createElement('button');
      b.id = ID;
      b.className = 'sb-footer-btn';
      b.title = 'Connection details, AI tools, and integrations';
      b.innerHTML = '<i class="ti ti-plug"></i><span>Connections</span>';
      b.addEventListener('click', function () { location.assign('__CONNECTIONS_PATH__'); });
      footer.appendChild(b);
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

pub fn open_setup_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Second Brain")
        .inner_size(940.0, 700.0)
        .min_inner_size(760.0, 560.0)
        .build()?;
    Ok(())
}

pub fn open_wrapper_window(
    app: &AppHandle,
    worker_url: &str,
    auth_token: &str,
) -> tauri::Result<()> {
    open_wrapper_window_impl(app, worker_url, auth_token, false)
}

/// Same wrapper, but once the dashboard has loaded it opens the Integrations
/// panel — used by the "Set up Notion" / "Manage" deep-links.
pub fn open_wrapper_window_integrations(
    app: &AppHandle,
    worker_url: &str,
    auth_token: &str,
) -> tauri::Result<()> {
    open_wrapper_window_impl(app, worker_url, auth_token, true)
}

/// Calls the dashboard's own `openIntegrations()` once it exists. The wrapper's
/// init script runs at document-start, so it polls until the page defines the
/// function rather than assuming it's ready.
const OPEN_INTEGRATIONS_JS: &str = r#"(function () {
  var tries = 0;
  var iv = setInterval(function () {
    if (typeof openIntegrations === 'function') {
      try { openIntegrations(); } catch (_) {}
      clearInterval(iv);
    } else if (++tries > 60) {
      clearInterval(iv);
    }
  }, 100);
})();"#;

fn open_wrapper_window_impl(
    app: &AppHandle,
    worker_url: &str,
    auth_token: &str,
    open_integrations: bool,
) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("brain") {
        if open_integrations {
            let _ = w.eval("try { openIntegrations() } catch (_) {}");
        }
        let _ = w.set_focus();
        return Ok(());
    }
    let origin = worker_url.trim_end_matches('/');
    // serde_json turns the values into safely-escaped JS string literals.
    let origin_js = serde_json::to_string(origin).expect("string serializes");
    let token_js = serde_json::to_string(auth_token).expect("string serializes");
    let mut init = format!(
        r#"(function () {{
  try {{
    if (location.origin === {origin_js}) {{
      localStorage.setItem('sb_url', {origin_js});
      localStorage.setItem('sb_token', {token_js});
    }}
  }} catch (_) {{}}
}})();"#
    );
    if open_integrations {
        init.push('\n');
        init.push_str(OPEN_INTEGRATIONS_JS);
    }
    init.push('\n');
    init.push_str(&CONNECTIONS_BUTTON_JS.replace("__CONNECTIONS_PATH__", CONNECTIONS_PATH));

    let url: tauri::Url = format!("{origin}/")
        .parse()
        .map_err(|_| tauri::Error::WindowNotFound)?;
    let nav_handle = app.clone();
    WebviewWindowBuilder::new(app, "brain", WebviewUrl::External(url))
        .title("Second Brain")
        .inner_size(1180.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(&init)
        // The injected Connections button asks for a path the dashboard does not
        // route; turn that request into the native window and let the page stay
        // where it is.
        .on_navigation(move |target| {
            if target.path() == CONNECTIONS_PATH {
                open_details_window(&nav_handle);
                return false;
            }
            true
        })
        .build()?;
    Ok(())
}

pub fn open_details_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("details") {
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "details", WebviewUrl::App("details.html".into()))
        .title("Connections")
        .inner_size(960.0, 680.0)
        .min_inner_size(820.0, 560.0)
        .build();
}
