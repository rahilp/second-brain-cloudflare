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

/// Breach count via the HIBP k-anonymity range API. `None` means the service
/// couldn't be reached or refused (offline / timeout / rate limit) — the
/// caller fails open. `base_url` is a seam so the fail-open and mapping paths
/// can be exercised without a network.
async fn pwned_count_at(base_url: &str, password: &str) -> Option<u64> {
    let hash = sha1_hex_upper(password);
    let (prefix, suffix) = hash.split_at(5);
    // `Client::new` panics when the TLS backend won't initialise. A panic in
    // an async command sends no response at all, and the password screen keeps
    // Continue disabled until this call settles — so that panic would strand
    // setup with no way forward. Build fallibly and fail open instead.
    let client = reqwest::Client::builder().build().ok()?;
    let response = client
        .get(format!("{base_url}/{prefix}"))
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
    check_at(HIBP_RANGE_URL, password).await
}

/// `check` against an arbitrary range endpoint — the injectable form.
async fn check_at(base_url: &str, password: &str) -> PasswordCheck {
    let score = strength_score(password);
    let looked_up = pwned_count_at(base_url, password).await;
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
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

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

    /// A one-shot stand-in for the HIBP range endpoint. Hands back its base
    /// URL and a channel carrying the path it was asked for, so a test can
    /// prove what left the machine as well as what came back.
    fn stub_range_service(status: u16, body: &'static str) -> (String, Receiver<String>) {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub range service");
        let port = server.server_addr().to_ip().expect("stub bound to an ip").port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok(request) = server.recv() {
                let _ = tx.send(request.url().to_string());
                let _ = request.respond(
                    tiny_http::Response::from_string(body).with_status_code(status),
                );
            }
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    /// The k-anonymity promise in this module's header: the service learns a
    /// 5-character hash prefix and nothing else. The suffix that identifies
    /// the password among that range must never appear in the request.
    #[tokio::test]
    async fn only_the_hash_prefix_leaves_the_machine() {
        let (base, paths) = stub_range_service(200, "");
        let _ = check_at(&base, "password").await;
        let path = paths.recv().expect("the stub was asked for something");
        assert_eq!(path, "/5BAA6", "only the 5-character prefix may be sent");
        assert!(
            !path.contains("1E4C9B93F3F0682250B6CF8331B7EE68FD8"),
            "the identifying suffix must stay on this machine"
        );
    }

    #[tokio::test]
    async fn a_breached_password_comes_back_with_its_count() {
        let (base, _paths) =
            stub_range_service(200, "1E4C9B93F3F0682250B6CF8331B7EE68FD8:52372427\r\n");
        let result = check_at(&base, "password").await;
        assert!(result.online);
        assert!(result.breached);
        assert_eq!(result.count, 52372427);
        assert!(result.score <= 1, "the offline estimate runs regardless");
    }

    #[tokio::test]
    async fn a_password_absent_from_the_range_is_online_and_clean() {
        let (base, _paths) = stub_range_service(200, "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n");
        let result = check_at(&base, "password").await;
        assert!(result.online, "the lookup did reach the service");
        assert!(!result.breached);
        assert_eq!(result.count, 0);
    }

    /// A refusal is not a clean bill of health. Reporting `online` here would
    /// tell the user their password was checked against the breach corpus when
    /// it never was.
    #[tokio::test]
    async fn a_refused_lookup_is_not_a_clean_bill_of_health() {
        let (base, _paths) = stub_range_service(429, "rate limited");
        let result = check_at(&base, "password").await;
        assert!(!result.online);
        assert!(!result.breached);
        assert_eq!(result.count, 0);
    }

    /// The fail-open contract, and the reason it has to be bounded: the
    /// password screen keeps Continue disabled until this call settles, so a
    /// lookup that outlives its timeout strands setup with no way forward.
    #[tokio::test]
    async fn an_unreachable_service_fails_open_within_its_timeout() {
        let started = Instant::now();
        let result = check_at("https://10.255.255.1", "password").await;
        assert!(!result.online, "an unreachable service is not a verdict");
        assert!(!result.breached);
        assert_eq!(result.count, 0);
        assert!(result.score <= 1, "the offline estimate still stands alone");
        assert!(
            started.elapsed() < HIBP_TIMEOUT * 2,
            "the check must not outlive its own timeout; took {:?}",
            started.elapsed()
        );
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
