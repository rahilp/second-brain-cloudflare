//! A bounded, scrubbed log file alongside the stderr stream.
//!
//! Everything the app logs used to go to stderr via `env_logger`, which is
//! invisible to anyone who launched the app normally — double-clicking the
//! icon on Windows or macOS attaches no console. The one moment a user is
//! likeliest to be asked for a log is a failed setup (discussion #315), and
//! until now there was nothing to send: no file, no diagnostics, just a
//! screenshot of an error screen.
//!
//! # One logger, two sinks
//!
//! `log` allows a single global logger, so this replaces `env_logger` rather
//! than joining it: every record that passes the level filter goes to stderr
//! exactly as before (`tauri dev` and terminal launches lose nothing) *and* is
//! appended to the file. The file copy is scrubbed first — see [`scrub`].
//!
//! # What the file may not hold
//!
//! The log travels: a user copies it into a GitHub discussion or emails it.
//! Two things must never survive that trip:
//!
//! * **Credentials.** A bearer token is the brain's password; one leaked line
//!   in a public issue hands over the brain it authenticates. Every
//!   `Bearer <token>` becomes `Bearer [redacted]`.
//! * **The brain's address.** It identifies the user's Cloudflare account and
//!   subdomain, which is theirs to share, not ours to write. URL authorities
//!   are redacted while paths stay — `/health` failing is diagnostic, who owns
//!   the domain is not.
//!
//! # Bounded by construction
//!
//! A logger that can grow forever is a support problem of its own on a disk
//! most users cannot read. One file plus one predecessor, each at most
//! [`MAX_FILE_BYTES`]: when the live file crosses the cap it is renamed aside
//! wholesale and a fresh file starts. Old lines are lost in `MAX_FILE_BYTES`
//! chunks rather than trimmed mid-line, because a half-record is worse than no
//! record.

use log::{LevelFilter, Log, Metadata, Record};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Roughly eight average sessions; old content moves to `.old`, so the last
/// cap's worth of history is always available even after a rotation.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
const FILE_NAME: &str = "second-brain.log";
const OLD_NAME: &str = "second-brain.log.old";

// ── Where the file lives ────────────────────────────────────────────────────

/// The platform's log directory, or `None` when the platform cannot offer one —
/// in which case file logging silently does not happen and stderr carries
/// everything, exactly as before. A missing directory must never block launch.
fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library").join("Logs").join("Second Brain"))
    }
    #[cfg(target_os = "windows")]
    {
        // %LOCALAPPDATA%, where Tauri's own log plugin puts them too.
        dirs::cache_dir().map(|d| d.join("Second Brain").join("logs"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs::state_dir()
            .or_else(dirs::data_dir)
            .map(|d| d.join("second-brain").join("logs"))
    }
}

// ── Scrubbing ───────────────────────────────────────────────────────────────

/// Removes what the file must never hold, leaving the diagnostic shape intact.
///
/// Whitespace-token based, not regex-based: there is no regex engine in this
/// dependency tree, and both patterns are recognisable without one. A token
/// following `Bearer` is a credential whatever it looks like; a token carrying
/// `://` is a URL whose authority names the user's account, redacted up to the
/// path separator. Everything else passes untouched — including numbers,
/// versions and status codes, which are the actual diagnostic payload.
pub fn scrub(line: &str) -> String {
    let mut out: Vec<String> = Vec::with_capacity(line.len());
    let mut redact_next = false;
    for token in line.split(' ') {
        if redact_next && !token.is_empty() {
            out.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        if token == "Bearer" {
            out.push(token.to_string());
            redact_next = true;
            continue;
        }
        match token.find("://") {
            Some(scheme_end) => {
                let rest = &token[scheme_end + 3..];
                let authority_len = rest
                    .find(|c| c == '/' || c == '?' || c == '#' || c == '"')
                    .unwrap_or(rest.len());
                // Rebuilt as ONE token: joining fragments on spaces would
                // shred the very shape being preserved.
                let mut rebuilt = String::with_capacity(token.len());
                rebuilt.push_str(&token[..scheme_end + 3]);
                rebuilt.push_str("[redacted]");
                rebuilt.push_str(&rest[authority_len..]);
                out.push(rebuilt);
            }
            None => out.push(token.to_string()),
        }
    }
    out.join(" ")
}

// ── The file target ─────────────────────────────────────────────────────────

struct FileTarget {
    path: PathBuf,
    /// Held open across writes; `None` until the first write succeeds or after
    /// a rotation reopens it lazily. Every failure degrades to "this line only
    /// went to stderr" — logging must never be able to take the app down.
    file: Mutex<Option<File>>,
    written: Mutex<u64>,
}

impl FileTarget {
    fn new(path: PathBuf) -> Self {
        Self { path, file: Mutex::new(None), written: Mutex::new(0) }
    }

    fn append(&self, line: &str) {
        let mut guard = self.file.lock().unwrap();
        if *self.written.lock().unwrap() > MAX_FILE_BYTES {
            self.rotate(&mut guard);
        }
        let file = match guard.as_mut() {
            Some(file) => file,
            None => match self.open() {
                Ok(file) => {
                    *self.written.lock().unwrap() =
                        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
                    guard.insert(file)
                }
                Err(_) => return,
            },
        };
        let _ = writeln!(file, "{line}");
        *self.written.lock().unwrap() += line.len() as u64 + 1;
    }

    fn open(&self) -> std::io::Result<File> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        OpenOptions::new().create(true).append(true).open(&self.path)
    }

    /// Moves the live file aside whole and lets the next write start fresh.
    /// The rename is allowed to fail (a reader holding the file on Windows);
    /// then the next append simply keeps growing the same file until a later
    /// attempt succeeds — bounded eventually, never broken now.
    fn rotate(&self, guard: &mut Option<File>) {
        *guard = None;
        *self.written.lock().unwrap() = 0;
        let _ = fs::rename(&self.path, self.path.with_file_name(OLD_NAME));
    }
}

// ── The logger ──────────────────────────────────────────────────────────────

struct DualLogger {
    file: Option<FileTarget>,
}

impl DualLogger {
    /// The level filter env_logger was configured with, minus the syntax:
    /// `RUST_LOG` may name one global level, otherwise the old default holds —
    /// debug for this crate's records, info for everything else.
    fn enabled_level(&self, target: &str, level: LevelFilter) -> bool {
        if let Ok(specified) = std::env::var("RUST_LOG") {
            if let Ok(parsed) = specified.trim().parse::<LevelFilter>() {
                return level <= parsed;
            }
        }
        match target.starts_with("second_brain_desktop_lib") {
            true => level <= LevelFilter::Debug,
            false => level <= LevelFilter::Info,
        }
    }
}

impl Log for DualLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.enabled_level(metadata.target(), metadata.level().to_level_filter())
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let line = format!("[{millis} {:5} {}] {}", record.level(), record.target(), record.args());
        eprintln!("{line}");
        if let Some(file) = &self.file {
            file.append(&scrub(&line));
        }
    }

    fn flush(&self) {}
}

/// Installs the dual-sink logger. Fails silently into stderr-only mode: if the
/// platform offers no log directory or another logger won the race, the app
/// runs exactly as it did before this module existed.
pub fn init() {
    let file = log_dir().and_then(|dir| {
        fs::create_dir_all(&dir).ok()?;
        Some(FileTarget::new(dir.join(FILE_NAME)))
    });
    if let Ok(()) = log::set_boxed_logger(Box::new(DualLogger { file })) {
        // The logger filters internally per-target; the global gate stays open.
        log::set_max_level(LevelFilter::Trace);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── scrub ───────────────────────────────────────────────────────────────

    #[test]
    fn bearer_tokens_are_redacted_but_the_word_bearer_stays() {
        let scrubbed = scrub(
            "password re-check could not reach the brain sending Bearer sk-live-9f8e7d6c today",
        );
        assert!(
            scrubbed.contains("Bearer [redacted]"),
            "the scheme survives, its value does not: {scrubbed}"
        );
        assert!(
            !scrubbed.contains("sk-live-9f8e7d6c"),
            "a credential reached the log file: {scrubbed}"
        );
        assert!(
            scrubbed.contains("re-check could not reach"),
            "the surrounding words must survive: {scrubbed}"
        );
    }

    #[test]
    fn url_authorities_are_redacted_while_paths_survive() {
        let scrubbed =
            scrub("launch probe of https://second-brain.acme.workers.dev/health returned 503");
        assert!(scrubbed.contains("https://[redacted]/health"), "{scrubbed}");
        assert!(!scrubbed.contains("acme.workers.dev"), "{scrubbed}");
        assert!(scrubbed.contains("returned 503"), "{scrubbed}");
    }

    #[test]
    fn a_url_with_no_path_is_redacted_whole() {
        let scrubbed = scrub("deployed to https://my-brain.example.com\"");
        assert!(scrubbed.contains("https://[redacted]"), "{scrubbed}");
        assert!(scrubbed.ends_with('"'), "a trailing quote is not part of the host");
    }

    #[test]
    fn ordinary_lines_pass_through_untouched() {
        let line = "[1719000000000 INFO second_brain_desktop_lib::cf] deploy:second-brain:6";
        assert_eq!(scrub(line), line);
    }

    // ── the file target ─────────────────────────────────────────────────────

    /// A temp-dir target that has actually been written through. Returns the
    /// target, its path, and a snapshot of the file's contents.
    fn written_target(dir: &std::path::Path) -> (FileTarget, PathBuf, String) {
        let path = dir.join(FILE_NAME);
        let target = FileTarget::new(path.clone());
        target.append("first line");
        target.append("second line");
        let contents = fs::read_to_string(&path).unwrap();
        (target, path, contents)
    }

    #[test]
    fn lines_land_in_the_file_and_keep_their_order() {
        let dir = std::env::temp_dir().join(format!("sb-log-test-{}", std::process::id()));
        let (_target, _path, contents) = written_target(&dir);
        assert_eq!(contents, "first line\nsecond line\n", "append order is log order");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn crossing_the_cap_moves_the_file_aside_whole() {
        let dir = std::env::temp_dir().join(format!("sb-log-rot-{}", std::process::id()));
        let (target, path, _) = written_target(&dir);

        *target.written.lock().unwrap() = MAX_FILE_BYTES + 1;
        target.append("fresh after rotation");

        let old = fs::read_to_string(path.with_file_name(OLD_NAME)).unwrap();
        assert_eq!(
            old, "first line\nsecond line\n",
            "the predecessor must hold the pre-cap history, untrimmed"
        );
        let fresh = fs::read_to_string(&path).unwrap();
        assert_eq!(fresh, "fresh after rotation\n", "the live file starts empty");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_directory_is_created_not_a_failure() {
        let dir = std::env::temp_dir()
            .join(format!("sb-log-mkdir-{}", std::process::id()))
            .join("nested")
            .join("deeper");
        let target = FileTarget::new(dir.join(FILE_NAME));
        target.append("creates its own home");
        assert_eq!(
            fs::read_to_string(dir.join(FILE_NAME)).unwrap(),
            "creates its own home\n"
        );
        fs::remove_dir_all(&dir).ok();
    }
}
