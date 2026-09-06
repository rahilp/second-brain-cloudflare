//! Finding an existing Second Brain in the user's Cloudflare account.
//!
//! Setup used to require the user to open the Cloudflare dashboard, find their
//! Worker, and type its `workers.dev` URL. This asks Cloudflare instead.
//!
//! # Why this asks Cloudflare and not the Worker
//!
//! The obvious design — and the one this issue originally specified — is to build
//! each Worker's `workers.dev` URL and probe it over HTTP for something that
//! looks like a Second Brain: an auth-gated `/health`, the MCP OAuth metadata at
//! `/.well-known/oauth-protected-resource/mcp`, or the `Second Brain` title on
//! `/oauth/authorize`.
//!
//! None of those are safe, because of what happens next. Whatever the user picks
//! is what they then type their brain password into, and the app sends that
//! password to the chosen address as a bearer token. The address therefore has to
//! be trustworthy *before* the password is entered.
//!
//! An HTTP probe cannot establish that, no matter which endpoint it reads or how
//! brand-specific the string it looks for. Every byte of an HTTP response is
//! authored by the candidate itself, so any Worker in the account can serve
//! `401 {"ok":false}`, MCP metadata, or `<title>Second Brain</title>` on purpose
//! — forging it costs nothing. A third-party Worker the user deployed from a
//! template or a "Deploy to Cloudflare" button would then be shown to them under
//! the heading "Is this your Second Brain?", and would be handed their password.
//!
//! So identification happens through the Cloudflare control plane. A Worker
//! cannot lie about its own bindings: those are account state, readable only with
//! the user's Cloudflare token and not writable by the running script. A brain is
//! a script bound to a Vectorize index named `second-brain-vectors` and to a D1
//! database — which is what [`provision`](super::provision) creates.
//!
//! # Why only the conventional script name is offered
//!
//! Discovery deliberately looks at one script — the name this app deploys under —
//! rather than every script in the account, even though the bindings check would
//! happily identify a brain deployed under another name.
//!
//! The reason is what happens *after* connecting. `provision::update_worker`
//! takes its script name from the bundled manifest, not from the stored address,
//! and deploys with a `PUT` — an upsert. So a brain connected as
//! `my-brain.acme.workers.dev` would later be "updated" by writing the bundle to
//! a script named `second-brain` in that account: failing every time if none
//! exists, or overwriting an unrelated Worker if one does.
//!
//! Offering arbitrarily-named Workers as endorsed choices would walk users into
//! that. Someone whose brain has another name can still connect it by hand, which
//! is one of the reasons manual entry is not removable — and fixing the updater
//! to derive its script name from the stored address is tracked separately.

use super::api::CfClient;
use super::types::CfApiError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The Worker's deploy name.
    pub name: String,
    pub url: String,
}

/// Builds the `workers.dev` origin for a script: `<script>.<subdomain>.workers.dev`.
pub fn workers_dev_url(script: &str, subdomain: &str) -> String {
    format!("https://{script}.{subdomain}.workers.dev")
}

/// Whether a value is safe to interpolate as one label of a hostname.
///
/// Checked rather than assumed. Both halves of a workers.dev address come from a
/// remote API, and a value containing `?`, `#`, `/` or `@` would move the request
/// to an entirely different host — `evil.com?` yields
/// `https://second-brain.evil.com?.workers.dev`, whose host is `evil.com`.
pub fn is_safe_dns_label(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Whether a script's bindings are the ones this app provisions.
///
/// The Vectorize index names are the distinguishing part: they are specific to
/// this project (including names created by embedding migrations), and a binding
/// is account state rather than something the Worker's own code can assert.
///
/// The `AUTH_TOKEN` secret is deliberately *not* required. Cloudflare does not
/// promise to list secret bindings when reading a script's settings, and a check
/// depending on one would risk silently matching nothing at all.
pub fn bindings_look_like_a_brain(
    bindings: &[serde_json::Value],
    vectorize_names: &[String],
) -> bool {
    let type_of = |b: &serde_json::Value| {
        b.get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let vectorize_index_matches = bindings.iter().any(|b| {
        type_of(b) == "vectorize"
            && b
                .get("index_name")
                .and_then(|n| n.as_str())
                .is_some_and(|name| vectorize_names.iter().any(|candidate| candidate == name))
    });
    let has_database = bindings.iter().any(|b| type_of(b) == "d1");
    vectorize_index_matches && has_database
}

/// What a scan of one account produced. The subdomain comes back alongside the
/// matches because the caller persists it as a hint, and re-fetching it would be
/// a second round trip for something already known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovery {
    pub subdomain: String,
    pub brains: Vec<Candidate>,
}

/// Why a scan could not run. Kept separate from "ran and matched nothing", which
/// is a `Discovery` with an empty list — the two need different messages.
#[derive(Debug)]
pub enum DiscoverFailure {
    /// The account has never registered a workers.dev subdomain, so there are no
    /// addresses to construct.
    NoSubdomain,
    Api(CfApiError),
}

/// Scans one Cloudflare account for Second Brains.
///
/// `conventional_name` and `vectorize_names` come from the bundled Worker
/// manifest plus its migration catalog, so the check recognises every index a
/// brain managed by this build may legitimately use.
pub async fn discover_in_account(
    client: &CfClient,
    conventional_name: &str,
    vectorize_names: &[String],
) -> Result<Discovery, DiscoverFailure> {
    let subdomain = client
        .get_account_subdomain()
        .await
        .map_err(DiscoverFailure::Api)?
        .filter(|s| is_safe_dns_label(s))
        .ok_or(DiscoverFailure::NoSubdomain)?;

    let scripts: Vec<String> = client
        .list_workers()
        .await
        .map_err(DiscoverFailure::Api)?
        .into_iter()
        .filter(|name| is_safe_dns_label(name))
        .collect();

    let brains = find_brains(
        client,
        scripts,
        conventional_name,
        vectorize_names,
        &subdomain,
    )
    .await;
    Ok(Discovery { subdomain, brains })
}

/// The check itself, split from the API preamble so it is testable.
///
/// One script, one settings read, whatever the size of the account — see the
/// module docs for why the search is not widened.
async fn find_brains(
    client: &CfClient,
    scripts: Vec<String>,
    conventional_name: &str,
    vectorize_names: &[String],
    subdomain: &str,
) -> Vec<Candidate> {
    if !scripts.iter().any(|s| s == conventional_name) {
        return Vec::new();
    }
    if !is_brain(client, conventional_name, vectorize_names).await {
        // A script squatting the name without the bindings is not a brain.
        return Vec::new();
    }
    vec![Candidate {
        name: conventional_name.to_string(),
        url: workers_dev_url(conventional_name, subdomain),
    }]
}

/// One script, one control-plane read. A failure counts as "not a brain": the
/// scan must survive a single unreadable script rather than abandon the account.
async fn is_brain(client: &CfClient, script: &str, vectorize_names: &[String]) -> bool {
    match client.get_script_bindings(script).await {
        Ok(bindings) => bindings_look_like_a_brain(&bindings, vectorize_names),
        Err(e) => {
            log::debug!("could not read a script's bindings: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectorize(index: &str) -> serde_json::Value {
        serde_json::json!({ "type": "vectorize", "name": "VECTORIZE", "index_name": index })
    }
    fn d1() -> serde_json::Value {
        serde_json::json!({ "type": "d1", "name": "DB", "database_id": "abc" })
    }
    fn index_names() -> Vec<String> {
        vec!["second-brain-vectors".to_string()]
    }

    #[test]
    fn recognises_the_bindings_this_app_provisions() {
        let bindings = vec![
            d1(),
            vectorize("second-brain-vectors"),
            serde_json::json!({ "type": "kv_namespace", "name": "OAUTH_KV" }),
            serde_json::json!({ "type": "ai", "name": "AI" }),
        ];
        assert!(bindings_look_like_a_brain(&bindings, &index_names()));
    }

    /// Cloudflare may or may not list secret bindings, so the check must not
    /// depend on the AUTH_TOKEN secret appearing.
    #[test]
    fn does_not_require_the_auth_token_secret_to_be_listed() {
        let bindings = vec![d1(), vectorize("second-brain-vectors")];
        assert!(bindings_look_like_a_brain(&bindings, &index_names()));
    }

    /// The property that HTTP probing could not provide: a Worker cannot assert
    /// its own bindings, so an unrelated script in the same account fails to
    /// match however it chooses to answer over HTTP.
    #[test]
    fn rejects_an_unrelated_worker_in_the_same_account() {
        for bindings in [
            vec![],
            vec![serde_json::json!({ "type": "kv_namespace", "name": "CACHE" })],
            // Vectorize, but somebody else's index.
            vec![d1(), vectorize("my-rag-index")],
            // The right index, but no database — not a brain.
            vec![vectorize("second-brain-vectors")],
            // A binding that merely mentions the name in the wrong field.
            vec![
                d1(),
                serde_json::json!({ "type": "vectorize", "name": "second-brain-vectors" }),
            ],
        ] {
            assert!(
                !bindings_look_like_a_brain(&bindings, &index_names()),
                "wrongly matched: {bindings:?}"
            );
        }
    }

    #[test]
    fn builds_the_cloudflare_workers_dev_hostname() {
        assert_eq!(
            workers_dev_url("second-brain", "demo"),
            "https://second-brain.demo.workers.dev"
        );
    }

    /// A script name becomes a hostname, so a name carrying URL syntax would
    /// silently retarget the request: `evil.com?` yields
    /// `https://evil.com?.acme.workers.dev`, whose host is `evil.com`.
    #[test]
    fn refuses_hostname_labels_that_would_move_the_host() {
        for bad in [
            "",
            "-lead",
            "trail-",
            "evil.com?",
            "a#b",
            "a/b",
            "a@b",
            "a b",
            "UPPER",
            "a:b",
            "sub.domain",
        ] {
            assert!(!is_safe_dns_label(bad), "accepted unsafe label: {bad:?}");
        }
        for good in ["second-brain", "my_brain2", "brain-2", "a", "acme-corp-s-account"] {
            assert!(is_safe_dns_label(good), "rejected valid label: {good:?}");
        }
    }

    // ── Against a fake Cloudflare API ───────────────────────────────────────

    /// `scripts` is the account's script list; `brains` are those whose settings
    /// come back carrying brain bindings. The returned counter records how many
    /// per-script settings reads the scan performed.
    fn spawn_cf_api(
        subdomain: Option<&'static str>,
        scripts: &'static [&'static str],
        brains: &'static [&'static str],
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        spawn_cf_api_with_index(subdomain, scripts, brains, "second-brain-vectors")
    }

    fn spawn_cf_api_with_index(
        subdomain: Option<&'static str>,
        scripts: &'static [&'static str],
        brains: &'static [&'static str],
        brain_index: &'static str,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let settings_reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = settings_reads.clone();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let url = req.url().to_string();
            let body = if url.contains("/workers/subdomain") {
                match subdomain {
                    Some(s) => {
                        format!(r#"{{"success":true,"errors":[],"result":{{"subdomain":"{s}"}}}}"#)
                    }
                    None => {
                        r#"{"success":true,"errors":[],"result":{"subdomain":null}}"#.to_string()
                    }
                }
            } else if let Some(rest) = url.split("/workers/scripts/").nth(1) {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let script = rest.trim_end_matches("/settings");
                let bindings = if brains.contains(&script) {
                    format!(
                        r#"[{{"type":"d1","database_id":"x"}},{{"type":"vectorize","index_name":"{brain_index}"}}]"#
                    )
                } else {
                    r#"[{"type":"kv_namespace","namespace_id":"y"}]"#.to_string()
                };
                format!(r#"{{"success":true,"errors":[],"result":{{"bindings":{bindings}}}}}"#)
            } else {
                let list = scripts
                    .iter()
                    .map(|s| format!(r#"{{"id":"{s}"}}"#))
                    .collect::<Vec<_>>()
                    .join(",");
                format!(r#"{{"success":true,"errors":[],"result":[{list}]}}"#)
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(200));
        });
        (format!("http://127.0.0.1:{port}"), settings_reads)
    }

    fn client(base: String) -> CfClient {
        CfClient::with_base("tok".into(), "acct".into(), base)
    }

    const CONVENTIONAL: &str = "second-brain";

    #[tokio::test]
    async fn finds_the_brain_and_reports_the_subdomain_it_used() {
        let (base, _) = spawn_cf_api(Some("acme"), &["second-brain", "blog"], &["second-brain"]);
        let found = discover_in_account(&client(base), CONVENTIONAL, &index_names())
            .await
            .expect("scan runs");
        assert_eq!(found.subdomain, "acme");
        assert_eq!(
            found.brains,
            vec![Candidate {
                name: "second-brain".into(),
                url: "https://second-brain.acme.workers.dev".into(),
            }]
        );
    }

    #[tokio::test]
    async fn finds_a_brain_bound_to_a_migrated_index_name() {
        let (base, _) = spawn_cf_api_with_index(
            Some("acme"),
            &["second-brain"],
            &["second-brain"],
            "second-brain-vectors-768",
        );
        let known_indexes = vec![
            "second-brain-vectors".to_string(),
            "second-brain-vectors-768".to_string(),
        ];

        let found = discover_in_account(&client(base), CONVENTIONAL, &known_indexes)
            .await
            .expect("scan runs");

        assert_eq!(found.brains.len(), 1);
        assert_eq!(found.brains[0].name, "second-brain");
    }

    /// The conventional name is checked alone first, so the common case costs one
    /// settings read however large the account is.
    #[tokio::test]
    async fn a_conventionally_named_brain_costs_a_single_lookup() {
        let (base, reads) = spawn_cf_api(
            Some("acme"),
            &["second-brain", "a", "b", "c", "d", "e", "f", "g", "h"],
            &["second-brain"],
        );
        discover_in_account(&client(base), CONVENTIONAL, &index_names())
            .await
            .unwrap();
        assert_eq!(
            reads.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the fast path must not read every script in the account"
        );
    }

    /// A brain deployed under another name is deliberately NOT offered, even
    /// though the bindings check would recognise it.
    ///
    /// `update_worker` derives its script name from the bundled manifest and
    /// deploys with a `PUT`, so connecting `my-memory` would later write the
    /// bundle to a script named `second-brain` in that account — failing forever
    /// if none exists, or overwriting an unrelated Worker if one does. Manual
    /// entry remains the route for these users.
    #[tokio::test]
    async fn a_brain_under_another_name_is_not_offered() {
        let (base, _) = spawn_cf_api(Some("acme"), &["notes", "my-memory"], &["my-memory"]);
        let found = discover_in_account(&client(base), CONVENTIONAL, &index_names())
            .await
            .unwrap();
        assert!(
            found.brains.is_empty(),
            "offering this would break the user's future updates"
        );
    }

    /// A script holding the conventional name without the bindings is not a
    /// brain, and must not be offered just because its name matches.
    #[tokio::test]
    async fn a_script_squatting_the_name_without_the_bindings_is_not_offered() {
        let (base, _) = spawn_cf_api(Some("acme"), &["second-brain", "blog"], &[]);
        let found = discover_in_account(&client(base), CONVENTIONAL, &index_names())
            .await
            .unwrap();
        assert!(found.brains.is_empty());
    }

    #[tokio::test]
    async fn an_account_with_no_brain_returns_an_empty_list_not_an_error() {
        let (base, _) = spawn_cf_api(Some("acme"), &["blog", "api"], &[]);
        let found = discover_in_account(&client(base), CONVENTIONAL, &index_names())
            .await
            .unwrap();
        assert!(found.brains.is_empty());
    }

    #[tokio::test]
    async fn an_empty_account_scans_cleanly() {
        let (base, _) = spawn_cf_api(Some("acme"), &[], &[]);
        let found = discover_in_account(&client(base), CONVENTIONAL, &index_names())
            .await
            .unwrap();
        assert!(found.brains.is_empty());
    }

    /// A subdomain Cloudflare should never return, but which would build a URL
    /// pointing somewhere else, must not produce an address at all.
    #[tokio::test]
    async fn an_unsafe_subdomain_never_becomes_an_address() {
        let (base, _) = spawn_cf_api(Some("evil.com?"), &["second-brain"], &["second-brain"]);
        match discover_in_account(&client(base), CONVENTIONAL, &index_names()).await {
            Err(DiscoverFailure::NoSubdomain) => {}
            other => panic!("expected the unsafe subdomain to be refused, got {other:?}"),
        }
    }

    /// An account that never registered a workers.dev subdomain cannot be scanned
    /// at all, which is not the same as holding no brains.
    #[tokio::test]
    async fn an_account_without_a_subdomain_fails_distinctly() {
        let (base, _) = spawn_cf_api(None, &["second-brain"], &["second-brain"]);
        match discover_in_account(&client(base), CONVENTIONAL, &index_names()).await {
            Err(DiscoverFailure::NoSubdomain) => {}
            other => panic!("expected NoSubdomain, got {other:?}"),
        }
    }

    /// The address discovery builds must be one `start_worker_update` can resolve
    /// back to an account. It calls the real `subdomain_of` rather than
    /// re-implementing it, so a change to *either* function breaks this.
    #[test]
    fn a_discovered_address_resolves_back_to_its_account_subdomain() {
        for (script, subdomain) in [
            ("second-brain", "acme"),
            ("my-brain-2", "dad-piranifam-com-s-account"),
        ] {
            let url = workers_dev_url(script, subdomain);
            assert_eq!(
                crate::worker_url::subdomain_of(&url).as_deref(),
                Some(subdomain),
                "start_worker_update would not find the account for {url}"
            );
        }
    }

    // ── The setup UI wired to this ──────────────────────────────────────────
    //
    // Read from installer/src/main.ts, following the convention in settings.rs:
    // the Rust core and the webview are separate build units, so nothing but a
    // source check catches the UI drifting from the commands it must call.

    fn setup_ui() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/main.ts");
        std::fs::read_to_string(path).expect("read installer/src/main.ts")
    }

    /// The sign-in footnote points the uneasy user at the manual route by
    /// quoting that button's label. Two strings in two locales have to agree, so
    /// renaming the button would silently leave the footnote naming something
    /// that is no longer on screen.
    #[test]
    fn the_signin_footnote_names_the_manual_button_that_exists() {
        for locale in ["en.ts", "it.ts"] {
            let path = format!("{}/../src/i18n/{}", env!("CARGO_MANIFEST_DIR"), locale);
            let src = std::fs::read_to_string(&path).expect("read locale file");

            let label = string_value(&src, "manualButton");
            let footnote = string_value(&src, "signInFootnote");
            assert!(!label.is_empty(), "{locale}: no manualButton label");
            assert!(!footnote.is_empty(), "{locale}: no signInFootnote");
            assert!(
                footnote.contains(&label),
                "{locale}: the footnote must name the button the user can actually \
                 click. Footnote says {footnote:?}, button is {label:?}"
            );
        }
    }

    /// The value of `key:` in a locale file, joining the concatenated string
    /// literals that make it up.
    ///
    /// Scoped to that one entry — reading every literal in the file would make
    /// the assertion above vacuous, since the label's own declaration is a
    /// literal too.
    fn string_value(src: &str, key: &str) -> String {
        let lines: Vec<&str> = src.lines().collect();
        let Some(first) = lines
            .iter()
            .position(|l| l.trim_start().starts_with(&format!("{key}:")))
        else {
            return String::new();
        };
        // The entry runs until the next sibling key or the end of the block. A
        // value written across several concatenated lines is continuation, not a
        // new key, because it opens with a quote.
        let mut block = String::new();
        for (n, line) in lines[first..].iter().enumerate() {
            let trimmed = line.trim_start();
            let is_new_key = n > 0
                && !trimmed.starts_with('"')
                && trimmed
                    .split(':')
                    .next()
                    .is_some_and(|k| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric()))
                && trimmed.contains(':');
            if n > 0 && (is_new_key || trimmed.starts_with('}')) {
                break;
            }
            block.push_str(line);
        }
        block
            .split('"')
            .skip(1)
            .step_by(2)
            .collect::<Vec<_>>()
            .join("")
    }

    /// The sign-in button must actually reach the scan.
    ///
    /// An earlier version of this test asserted only that the two command names
    /// appeared *somewhere* in the file. That could not distinguish a wired
    /// button from a dead one: replacing the click handler with a no-op breaks
    /// the entire feature while leaving both `invoke` calls sitting in the
    /// source, so every test stayed green. Assert the chain instead.
    #[test]
    fn the_sign_in_button_is_wired_through_to_the_scan() {
        let ui = setup_ui();

        // 1. The button reaches the sign-in screen.
        assert!(
            ui.contains(r#"signIn.addEventListener("click", () => void discoverScreen())"#),
            "the sign-in button must be wired to discoverScreen"
        );

        // 2. That screen signs in to Cloudflare, and
        // 3. hands off to the scan, which calls discover_brains.
        let sign_in = fn_body(&ui, "async function discoverScreen(");
        assert!(
            sign_in.contains(r#"invoke<Account[]>("connect_cloudflare""#),
            "discoverScreen must sign in to Cloudflare"
        );
        // Both branches, named separately. A bare contains("runDiscovery()")
        // passes while one of them is broken, because the other still mentions
        // it — and the single-account branch is the common case.
        assert!(
            sign_in.contains("await runDiscovery();"),
            "the single-account path must scan straight away"
        );
        assert!(
            sign_in.contains("() => void runDiscovery()"),
            "the multi-account path must scan once an account is picked"
        );

        let scan = fn_body(&ui, "async function runDiscovery(");
        assert!(
            scan.contains(r#"invoke<DiscoveredBrain[]>("discover_brains""#),
            "the scan must call discover_brains, or nothing is ever discovered"
        );
    }

    /// The body of a top-level function in main.ts, up to the next one.
    fn fn_body<'a>(ui: &'a str, signature: &str) -> &'a str {
        let start = ui
            .find(signature)
            .unwrap_or_else(|| panic!("main.ts has no {signature}"));
        let rest = &ui[start..];
        let end = rest
            .find("\nfunction ")
            .into_iter()
            .chain(rest.find("\nasync function "))
            .filter(|i| *i > 0)
            .min()
            .unwrap_or(rest.len());
        &rest[..end]
    }

    /// Manual entry cannot be removed. A custom domain, a brain in another
    /// party's account, and a user unwilling to grant access all depend on it,
    /// and none of them are recoverable if the field is gone.
    #[test]
    fn manual_address_entry_survives() {
        let ui = setup_ui();
        assert!(ui.contains("function manualEntryScreen("));
        assert!(ui.contains(r#"t("connectExisting.addressPlaceholder")"#));
        // Counting occurrences of the name would pass even with every button
        // deleted — the definition, the re-render closure and the error-retry
        // recursion all mention it. Only a click handler makes it reachable, so
        // count handler bodies instead. The argument-less call is the load-
        // bearing part: re-entries that carry an error or a prefill address
        // (`manualEntryScreen(undefined, err.url)`) are reachable only once the
        // user is already past the door, so they must not stand in for one.
        // The chooser sets the rail path before calling, hence the body scan
        // rather than a match on one exact spelling of the arrow.
        let clickable = ui
            .split(r#"addEventListener("click","#)
            .skip(1)
            .filter(|body: &&str| {
                let end = body.find(");").map_or(body.len(), |i| i + 2);
                body[..end].contains("manualEntryScreen()")
            })
            .count();
        assert!(
            clickable >= 2,
            "manual entry must be clickable from the chooser and the pick-list; \
             found {clickable} handlers"
        );
    }

    /// Discovery hands the picked address to `connect_existing`, the same command
    /// manual entry uses, which is what keeps the stored state identical however
    /// the brain was found. `start_worker_update` reads exactly that state, so a
    /// path that saved differently would break updates.
    #[test]
    fn a_discovered_brain_connects_through_the_same_command_as_a_typed_one() {
        let ui = setup_ui();
        let start = ui.find("function unlockBrainScreen(").expect("unlock screen");
        let block = &ui[start..];
        let block = &block[..block.find("\nfunction ").unwrap_or(block.len())];
        assert!(block.contains(r#"invoke<ConnectionDetails>("connect_existing""#));
        assert!(block.contains("address: brain.url"));
    }

    /// The password is collected only once an address is chosen. Nothing in
    /// discovery needs it, and a password gathered earlier could only have been
    /// sent somewhere not yet identified.
    #[test]
    fn no_screen_before_the_pick_collects_a_password() {
        let ui = setup_ui();
        // Every screen from the chooser up to (but excluding) the unlock screen.
        let from = ui.find("function connectExistingScreen(").expect("chooser");
        let to = ui.find("function unlockBrainScreen(").expect("unlock screen");
        assert!(from < to, "unlock screen must come after the chooser");
        let before_pick = &ui[from..to];
        assert!(
            !before_pick.contains(r#"type: "password""#),
            "no screen before the address is chosen may render a password field"
        );
    }
}
