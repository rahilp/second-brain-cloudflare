//! Sets up the Second Brain CLI (`brain`) on this computer.
//!
//! Two independent parts:
//!   * write `~/.config/second-brain/config.json` — the same Worker URL + auth
//!     token the app already holds, so `brain` works the moment it's installed.
//!     Existing keys are preserved. This is a plain file write and always works.
//!   * detect / install the npm package. GUI apps on macOS launch with a bare
//!     PATH (`/usr/bin:/bin:…`), so npm, Homebrew, nvm, and Volta are invisible
//!     to a direct `Command::new("npm")`. Both are resolved through the user's
//!     login shell, which loads their real PATH.

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The npm package that provides the `brain` command.
pub const CLI_PACKAGE: &str = "second-brain-cli";

/// The CLI reads this file: `{ "workerUrl": …, "authToken": … }`.
pub fn config_path(home: &Path) -> PathBuf {
    home.join(".config").join("second-brain").join("config.json")
}

#[derive(Debug, thiserror::Error)]
pub enum CliConfigError {
    #[error("could not read the CLI config file: {0}")]
    Io(#[from] std::io::Error),
    #[error("the CLI config file contains something unexpected")]
    Malformed,
}

impl From<serde_json::Error> for CliConfigError {
    fn from(_: serde_json::Error) -> Self {
        CliConfigError::Malformed
    }
}

/// Writes `workerUrl` + `authToken` into the CLI config, preserving any other
/// keys already present (the CLI may store defaults there). Creates the file
/// and parent directory when missing.
pub fn write_config(
    home: &Path,
    worker_url: &str,
    auth_token: &str,
) -> Result<PathBuf, CliConfigError> {
    let path = config_path(home);

    let mut root: Value = match fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|_| CliConfigError::Malformed)?
        }
        _ => Value::Object(Map::new()),
    };
    let obj = root.as_object_mut().ok_or(CliConfigError::Malformed)?;
    obj.insert("workerUrl".to_string(), Value::String(worker_url.to_string()));
    obj.insert("authToken".to_string(), Value::String(auth_token.to_string()));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_string_pretty(&root)? + "\n")?;
    Ok(path)
}

// ── npm / brain resolution ────────────────────────────────────────────────

/// Runs a short probe/command through the user's login shell so it inherits
/// their real PATH. Returns the process output, or an IO error if the shell
/// itself couldn't be launched.
fn login_shell_output(script: &str) -> std::io::Result<std::process::Output> {
    #[cfg(windows)]
    {
        Command::new("cmd").args(["/C", script]).output()
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        Command::new(shell).args(["-lc", script]).output()
    }
}

fn resolves(command: &str) -> bool {
    #[cfg(windows)]
    let probe = format!("where {command}");
    #[cfg(not(windows))]
    let probe = format!("command -v {command}");
    login_shell_output(&probe)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `brain` resolvable in the user's shell → the CLI is already installed.
pub fn cli_installed() -> bool {
    resolves("brain")
}

/// `npm` resolvable → we can offer to install the CLI for them.
pub fn npm_available() -> bool {
    resolves("npm")
}

/// Installs the CLI globally via npm. Returns npm's stdout on success, or an
/// error string suitable for showing the user (they can always run it by hand).
/// Blocking; callers should run it off the UI thread.
pub fn install() -> Result<String, String> {
    let output = login_shell_output(&format!("npm install -g {CLI_PACKAGE}"))
        .map_err(|e| format!("Couldn't start the install: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(if stderr.trim().is_empty() {
            "The install didn't finish. You can run it yourself in a terminal.".to_string()
        } else {
            stderr.trim().to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sb-cli-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const URL: &str = "https://second-brain.demo.workers.dev";
    const TOKEN: &str = "hunter2hunter2";

    #[test]
    fn writes_fresh_config_with_both_keys() {
        let home = temp_home();
        let path = write_config(&home, URL, TOKEN).unwrap();
        assert_eq!(
            path,
            home.join(".config").join("second-brain").join("config.json")
        );
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["workerUrl"], URL);
        assert_eq!(parsed["authToken"], TOKEN);
    }

    #[test]
    fn preserves_other_keys_and_refreshes_stale_values() {
        let home = temp_home();
        let path = config_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"workerUrl":"https://old.workers.dev","authToken":"old","defaultTags":["work"]}"#,
        )
        .unwrap();
        write_config(&home, URL, TOKEN).unwrap();
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["workerUrl"], URL);
        assert_eq!(parsed["authToken"], TOKEN);
        assert_eq!(parsed["defaultTags"][0], "work");
    }

    #[test]
    fn malformed_config_is_not_clobbered() {
        let home = temp_home();
        let path = config_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "not json at all {{{").unwrap();
        let err = write_config(&home, URL, TOKEN).unwrap_err();
        assert!(matches!(err, CliConfigError::Malformed));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "not json at all {{{",
            "the original file must be left untouched"
        );
    }
}
