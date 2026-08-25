//! OS-secure storage for what setup produces: the Worker URL and the user's
//! AUTH_TOKEN. Backed by the macOS Keychain / Windows Credential Manager via
//! the `keyring` crate. Nothing here ever touches disk in plaintext.
//!
//! The Cloudflare OAuth token is deliberately NOT stored — it's only needed
//! during provisioning and lives in memory for that window.
//!
//! Tests swap the keyring for an in-process map (keyring's mock store scopes
//! credentials to a single Entry instance, so it can't test save→load).

const KEY_WORKER_URL: &str = "worker-url";
const KEY_AUTH_TOKEN: &str = "auth-token";
const KEY_CF_ACCOUNT_ID: &str = "cf-account-id";
const KEY_CF_SUBDOMAIN: &str = "cf-subdomain";
/// The vector index a brain was reading *before* an embedding migration.
///
/// Read from the live binding at the moment of switching, so it is what
/// Cloudflare says rather than a name derived from an assumed size. Kept because
/// after the switch the brain reports the new index as current, and the old one's
/// name is the only thing that identifies what may safely be freed.
///
/// Not a secret: an index name. Stored here rather than in the window because a
/// browser store is lost on a reset and cannot be trusted to name something whose
/// deletion is irreversible.
const KEY_CF_PREVIOUS_INDEX: &str = "cf-previous-index";
/// Which kind of fresh setup this was: [`MODE_PERSONAL`] or [`MODE_TEAM`].
///
/// Not a credential — a flag the Connection window reads to decide whether the
/// team card is shown. Written only by the provisioning path; the "Already have
/// a Second Brain?" path never touches it, because a connected brain's mode is
/// whatever its deployment says, not something this computer gets to guess.
const KEY_TEAM_MODE: &str = "team-mode";
pub const MODE_PERSONAL: &str = "personal";
pub const MODE_TEAM: &str = "team";

#[derive(Debug, Clone)]
pub struct SetupInfo {
    pub worker_url: String,
    pub auth_token: String,
}

/// Non-secret Cloudflare facts worth remembering so later operations can skip
/// account enumeration.
///
/// These are deliberately the *only* Cloudflare values that persist. The OAuth
/// access token is not among them and must never be: the AUTH_TOKEN unlocks one
/// brain, whereas a Cloudflare token carrying `workers:write` + `d1:write` +
/// `vectorize:write` unlocks the whole account. Storing it would turn a stolen
/// laptop from "someone reads my notes" into "someone controls my Cloudflare".
/// The user signs in per operation instead.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // read by tests and by #248; written by discover_brains today
pub struct CfHints {
    pub account_id: String,
    pub subdomain: String,
}

#[derive(Debug, thiserror::Error)]
#[error("secure storage error: {0}")]
pub struct StoreError(String);

#[cfg(not(test))]
mod backend {
    use super::StoreError;
    use keyring::Entry;

    const SERVICE: &str = "com.secondbrain.desktop";

    pub fn set(key: &str, value: &str) -> Result<(), StoreError> {
        Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|e| StoreError(e.to_string()))
    }

    pub fn get(key: &str) -> Option<String> {
        Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    pub fn delete(key: &str) {
        if let Ok(e) = Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(test)]
mod backend {
    use super::StoreError;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    static MAP: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    /// Counts reads so a test can assert that a code path never touches the
    /// keychain at all.
    ///
    /// On a real build every read can raise an OS password prompt, and demo mode
    /// must never do that — but a prompt is not something a unit test can observe,
    /// and a source scan cannot express "not inside the dry-run branch". Counting
    /// the reads can.
    pub static READS: AtomicUsize = AtomicUsize::new(0);

    pub fn reads() -> usize {
        READS.load(Ordering::SeqCst)
    }
    pub fn reset_reads() {
        READS.store(0, Ordering::SeqCst);
    }

    pub fn set(key: &str, value: &str) -> Result<(), StoreError> {
        MAP.lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub fn get(key: &str) -> Option<String> {
        READS.fetch_add(1, Ordering::SeqCst);
        MAP.lock().unwrap().as_ref()?.get(key).cloned()
    }

    pub fn delete(key: &str) {
        if let Some(map) = MAP.lock().unwrap().as_mut() {
            map.remove(key);
        }
    }
}

/// Test-only view of how many keychain reads have happened.
#[cfg(test)]
pub mod probe {
    pub fn reads() -> usize {
        super::backend::reads()
    }
    pub fn reset() {
        super::backend::reset_reads()
    }
}

pub fn save_setup(worker_url: &str, auth_token: &str) -> Result<(), StoreError> {
    backend::set(KEY_WORKER_URL, worker_url)?;
    backend::set(KEY_AUTH_TOKEN, auth_token)?;
    Ok(())
}

/// Both values present ⇒ setup completed ⇒ the app boots in wrapper mode.
pub fn load_setup() -> Option<SetupInfo> {
    Some(SetupInfo {
        worker_url: backend::get(KEY_WORKER_URL)?,
        auth_token: backend::get(KEY_AUTH_TOKEN)?,
    })
}

/// Remembers which account and workers.dev subdomain the brain lives under.
///
/// Stored separately from [`save_setup`] and read separately, so a missing or
/// unreadable hint can never make a connected brain look unconfigured — see
/// [`load_setup`], whose two keys remain the only definition of "set up".
pub fn save_cf_hints(account_id: &str, subdomain: &str) -> Result<(), StoreError> {
    backend::set(KEY_CF_ACCOUNT_ID, account_id)?;
    backend::set(KEY_CF_SUBDOMAIN, subdomain)?;
    Ok(())
}

/// The read half of [`save_cf_hints`]. Exercised by the tests here; the
/// operations that will consume it — skipping account enumeration on a repeat
/// Cloudflare action — land with #248.
#[allow(dead_code)]
pub fn load_cf_hints() -> Option<CfHints> {
    Some(CfHints {
        account_id: backend::get(KEY_CF_ACCOUNT_ID)?,
        subdomain: backend::get(KEY_CF_SUBDOMAIN)?,
    })
}

/// Records what the brain was reading before a migration switched it.
pub fn save_previous_index(name: &str) -> Result<(), StoreError> {
    backend::set(KEY_CF_PREVIOUS_INDEX, name)
}

/// The index left behind by the last migration, if one is outstanding.
pub fn load_previous_index() -> Option<String> {
    backend::get(KEY_CF_PREVIOUS_INDEX).filter(|s| !s.is_empty())
}

/// Called once the old index has actually been freed, so the offer stops being
/// made. Kept separate from [`clear_setup`]: forgetting the note without deleting
/// the index would silently orphan it.
pub fn clear_previous_index() {
    backend::delete(KEY_CF_PREVIOUS_INDEX);
}

/// Records whether provisioning was for one person or a team. Read by the
/// Connection window to decide whether the team card is shown.
pub fn save_team_mode(mode: &str) -> Result<(), StoreError> {
    backend::set(KEY_TEAM_MODE, mode)
}

/// The mode recorded at setup, if any. Absent for brains connected without
/// provisioning — their mode is unknown, and unknown reads as personal.
pub fn load_team_mode() -> Option<String> {
    backend::get(KEY_TEAM_MODE).filter(|s| !s.is_empty())
}

/// The UI gate. Team is opt-in, so anything not explicitly [`MODE_TEAM`] is
/// personal.
pub fn is_team_mode() -> bool {
    load_team_mode().as_deref() == Some(MODE_TEAM)
}

pub fn clear_setup() {
    backend::delete(KEY_WORKER_URL);
    backend::delete(KEY_AUTH_TOKEN);
    backend::delete(KEY_CF_ACCOUNT_ID);
    backend::delete(KEY_CF_SUBDOMAIN);
    backend::delete(KEY_CF_PREVIOUS_INDEX);
    backend::delete(KEY_TEAM_MODE);
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: the backing map is shared process state, so scenarios run
    // sequentially to avoid cross-test races.
    #[test]
    fn roundtrip_clear_and_partial_state() {
        clear_setup();
        assert!(load_setup().is_none());

        save_setup("https://second-brain.demo.workers.dev", "hunter2hunter2").unwrap();
        let info = load_setup().expect("saved setup loads");
        assert_eq!(info.worker_url, "https://second-brain.demo.workers.dev");
        assert_eq!(info.auth_token, "hunter2hunter2");

        clear_setup();
        assert!(load_setup().is_none());

        backend::set(super::KEY_WORKER_URL, "https://x.workers.dev").unwrap();
        assert!(load_setup().is_none(), "URL without token must not count as set up");
        clear_setup();

        // ── Cloudflare hints ────────────────────────────────────────────────
        // In the same test, not a second one: the backing map is process-global,
        // so two tests mutating it race (a concurrent clear_setup() wipes the
        // other's state mid-assertion).
        assert!(load_cf_hints().is_none());
        save_cf_hints("acct-123", "demo").unwrap();
        assert_eq!(
            load_cf_hints(),
            Some(CfHints { account_id: "acct-123".into(), subdomain: "demo".into() })
        );

        // Hints alone must never read as a completed setup, or the app would boot
        // into wrapper mode with no brain to talk to.
        assert!(load_setup().is_none(), "hints are not credentials");

        // And a brain connected without ever signing in to Cloudflare has no
        // hints, which must not stop it being set up.
        clear_setup();
        save_setup("https://b.workers.dev", "hunter2hunter2").unwrap();
        assert!(load_setup().is_some());
        assert!(load_cf_hints().is_none());

        clear_setup();
        assert!(load_cf_hints().is_none(), "disconnect must clear hints too");

        // ── The outstanding-index note ──────────────────────────────────────
        assert!(load_previous_index().is_none());
        save_previous_index("second-brain-vectors").unwrap();
        assert_eq!(load_previous_index().as_deref(), Some("second-brain-vectors"));

        // Freeing the index clears the note without disturbing the setup.
        save_setup("https://b.workers.dev", "hunter2hunter2").unwrap();
        clear_previous_index();
        assert!(load_previous_index().is_none());
        assert!(load_setup().is_some(), "clearing the note must not log the user out");

        // An empty value reads as absent: it must never name an index to delete.
        backend::set(super::KEY_CF_PREVIOUS_INDEX, "").unwrap();
        assert!(load_previous_index().is_none(), "an empty note names nothing");

        clear_setup();
        assert!(load_previous_index().is_none(), "disconnect clears the note too");

        // ── The setup-mode note ─────────────────────────────────────────────
        // Written by provisioning only; connect-existing never sets it, so a
        // fresh map (as after clear_setup) reads as unknown → personal.
        assert!(load_team_mode().is_none());
        save_team_mode(MODE_TEAM).unwrap();
        assert_eq!(load_team_mode().as_deref(), Some(MODE_TEAM));
        assert!(is_team_mode());

        // An empty value is not a team, exactly as an empty index note names
        // nothing.
        backend::set(super::KEY_TEAM_MODE, "").unwrap();
        assert!(!is_team_mode(), "an empty note is not a team");

        clear_setup();
        assert!(load_team_mode().is_none(), "disconnect clears the mode too");
    }

    /// The Cloudflare OAuth token is not persisted anywhere.
    ///
    /// Pins the complete set of keys rather than pattern-matching their names: a
    /// future `KEY_CF_TOKEN` or `KEY_BEARER` would slip past a substring check,
    /// but cannot slip past an exact list. Adding a key here is then a deliberate
    /// act that forces a second look at what is being stored — as it did for
    /// `cf-previous-index`, which is an index name and not a credential.
    #[test]
    fn the_stored_key_set_is_exactly_these_six() {
        let src = include_str!("secure_store.rs");
        let keys: Vec<&str> = src
            .lines()
            .filter(|l| l.trim_start().starts_with("const KEY_"))
            .filter_map(|l| l.split('"').nth(1))
            .collect();
        assert_eq!(
            keys,
            vec![
                "worker-url",
                "auth-token",
                "cf-account-id",
                "cf-subdomain",
                "cf-previous-index",
                // Deliberate addition (v3 team edition): a setup-mode flag, not
                // a credential — see KEY_TEAM_MODE above.
                "team-mode",
            ],
            "secure_store gained or lost a key. A Cloudflare access or refresh \
             token must never be one of them: the AUTH_TOKEN unlocks one brain, \
             a Cloudflare token unlocks the whole account."
        );
    }

}
