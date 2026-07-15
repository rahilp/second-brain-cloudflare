//! Minimal semver comparison for Worker update detection. Only needs to answer
//! "is the deployed version behind the bundled one?" — a full semver crate
//! would be overkill for `MAJOR.MINOR.PATCH` strings.

/// Parses `MAJOR.MINOR.PATCH` (ignoring any pre-release/build suffix). Returns
/// `None` if it doesn't look like a version at all.
fn parse(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// True when `deployed` is a valid version strictly older than `bundled`.
/// An unparseable or absent `deployed` version returns `false` — we never nag
/// about a Worker whose version we can't read (e.g. a pre-version deployment).
pub fn is_behind(deployed: Option<&str>, bundled: &str) -> bool {
    match (deployed.and_then(parse), parse(bundled)) {
        (Some(d), Some(b)) => d < b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn behind_is_detected() {
        assert!(is_behind(Some("2.0.0"), "2.1.0"));
        assert!(is_behind(Some("2.0.0"), "2.0.1"));
        assert!(is_behind(Some("1.9.9"), "2.0.0"));
        assert!(is_behind(Some("2.0"), "2.0.1")); // missing patch treated as .0
    }

    #[test]
    fn equal_or_ahead_is_not_behind() {
        assert!(!is_behind(Some("2.0.0"), "2.0.0"));
        assert!(!is_behind(Some("2.1.0"), "2.0.0"));
        assert!(!is_behind(Some("3.0.0"), "2.9.9"));
    }

    #[test]
    fn unknown_deployed_version_never_nags() {
        assert!(!is_behind(None, "2.0.0"));
        assert!(!is_behind(Some(""), "2.0.0"));
        assert!(!is_behind(Some("not-a-version"), "2.0.0"));
    }

    #[test]
    fn tolerates_prerelease_and_build_suffixes() {
        assert!(is_behind(Some("2.0.0-beta"), "2.0.1"));
        assert!(!is_behind(Some("2.0.0+build7"), "2.0.0"));
    }
}
