//! Password safety checks for the setup flow.
//!
//! Two layers, both run in Rust so the password never leaves this process
//! except as a 5-character hash prefix:
//!   * zxcvbn — offline strength estimate (catches guessable passwords)
//!   * Have I Been Pwned range API — k-anonymity breach lookup: we SHA-1 the
//!     password locally and send only the first 5 hex characters of the hash;
//!     the full password (and even its full hash) never leaves the machine.
//!
//! The breach check fails open: if the network is unavailable the caller gets
//! `online: false` and setup continues on the offline estimate alone.

use serde::Serialize;
use sha1::{Digest, Sha1};
use std::time::Duration;

const HIBP_RANGE_URL: &str = "https://api.pwnedpasswords.com/range";
const HIBP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordCheck {
    /// Password appeared in known breaches (only meaningful when `online`).
    pub breached: bool,
    /// How many breaches it appeared in.
    pub count: u64,
    /// zxcvbn strength score, 0 (guessable) ..= 4 (strong).
    pub score: u8,
    /// Whether the breach lookup actually reached the service.
    pub online: bool,
}

/// Uppercase hex SHA-1 of the password — the format HIBP's dataset uses.
fn sha1_hex_upper(password: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02X}")).collect()
}

/// Finds our hash suffix in a range response (`SUFFIX:COUNT` per line) and
/// returns its breach count. Lines that don't parse are skipped.
fn count_in_range_response(body: &str, suffix: &str) -> u64 {
    body.lines()
        .filter_map(|line| {
            let (candidate, count) = line.trim().split_once(':')?;
            if candidate.eq_ignore_ascii_case(suffix) {
                count.trim().parse::<u64>().ok()
            } else {
                None
            }
        })
        .next()
        .unwrap_or(0)
}

/// zxcvbn offline strength estimate, 0..=4.
fn strength_score(password: &str) -> u8 {
    zxcvbn::zxcvbn(password, &[]).score() as u8
}

/// Breach count via the HIBP k-anonymity range API. `Ok(None)` means the
/// service couldn't be reached (offline / timeout) — the caller fails open.
async fn pwned_count(password: &str) -> Option<u64> {
    let hash = sha1_hex_upper(password);
    let (prefix, suffix) = hash.split_at(5);
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{HIBP_RANGE_URL}/{prefix}"))
        // Pads the response set so even its size can't fingerprint the query.
        .header("Add-Padding", "true")
        .timeout(HIBP_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    Some(count_in_range_response(&body, suffix))
}

/// Full check: offline strength estimate plus the breach lookup. Runs the
/// lookup in dry-run too — it's anonymous and touches no account — and fails
/// open when the network is unavailable.
pub async fn check(password: &str) -> PasswordCheck {
    let score = strength_score(password);
    let looked_up = pwned_count(password).await;
    let count = looked_up.unwrap_or(0);
    PasswordCheck {
        breached: count > 0,
        count,
        score,
        online: looked_up.is_some(),
    }
}

// ── Password generation ─────────────────────────────────────────────────────

/// Readable, unambiguous alphabet (no 0/o/1/l/i): 31 symbols ≈ 5 bits each.
const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS: usize = 4;
const GROUP_LEN: usize = 5;

/// Generates a `xxxxx-xxxxx-xxxxx-xxxxx` password: 20 random symbols from a
/// 31-symbol alphabet (~99 bits), grouped for easy reading and retyping on a
/// second computer.
pub fn generate() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..GROUPS)
        .map(|_| {
            (0..GROUP_LEN)
                .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_matches_known_vector() {
        // Standard test vector — also the most-breached password there is.
        assert_eq!(
            sha1_hex_upper("password"),
            "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8"
        );
    }

    #[test]
    fn range_response_finds_suffix_case_insensitively() {
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n\
                    1E4C9B93F3F0682250B6CF8331B7EE68FD8:52372427\r\n\
                    011053FD0102E94D6AE2F8B83D76FAF94F6:1";
        assert_eq!(
            count_in_range_response(body, "1e4c9b93f3f0682250b6cf8331b7ee68fd8"),
            52372427
        );
    }

    #[test]
    fn range_response_without_match_is_zero() {
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:3\nBAD-LINE\n:\n";
        assert_eq!(count_in_range_response(body, "FFFFFFFFFFFFFFFFFFFFF"), 0);
    }

    #[test]
    fn weak_passwords_score_low_and_strong_ones_high() {
        assert!(strength_score("password") <= 1);
        assert!(strength_score("qwerty12345") <= 2);
        assert!(strength_score("mqkw3-vt8nj-p5xrd-h29fs") >= 3);
    }

    /// Hits the real HIBP API — run explicitly with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_breach_check_flags_password_and_passes_generated() {
        let bad = check("password").await;
        assert!(bad.online, "HIBP should be reachable");
        assert!(bad.breached);
        assert!(bad.count > 1_000_000);

        let good = check(&generate()).await;
        assert!(good.online);
        assert!(!good.breached);
        assert!(good.score >= 3);
    }

    #[test]
    fn generated_passwords_are_well_formed_and_unique() {
        let a = generate();
        let b = generate();
        assert_ne!(a, b);
        for pw in [&a, &b] {
            let groups: Vec<&str> = pw.split('-').collect();
            assert_eq!(groups.len(), GROUPS);
            for g in &groups {
                assert_eq!(g.len(), GROUP_LEN);
                assert!(g.bytes().all(|c| ALPHABET.contains(&c)));
            }
            // Comfortably clears the 12-character minimum.
            assert!(pw.len() >= 12);
            // And rates as strong offline.
            assert!(strength_score(pw) >= 3);
        }
    }
}
