//! Thin Cloudflare v4 REST client. Every endpoint the installer touches is
//! listed in installer/README.md ("API audit"); no other endpoints are called.
//! Retries transient failures (network, 429, 5xx) up to three times with
//! backoff. 401s bubble up so the caller can refresh the OAuth token.

use super::types::*;
use crate::worker_bundle::AssetFile;
use base64::Engine;
use reqwest::multipart::{Form, Part};
use serde::de::DeserializeOwned;
use std::time::Duration;

pub const API_BASE: &str = "https://api.cloudflare.com/client/v4";
const MAX_ATTEMPTS: u32 = 3;

pub struct CfClient {
    http: reqwest::Client,
    token: String,
    base: String,
    pub account_id: String,
}

impl CfClient {
    pub fn new(token: String, account_id: String) -> Self {
        Self::with_base(token, account_id, API_BASE.to_string())
    }

    pub fn with_base(token: String, account_id: String, base: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            base,
            account_id,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn account_path(&self, rest: &str) -> String {
        format!("/accounts/{}{}", self.account_id, rest)
    }

    /// Sends a request (rebuilt per attempt so multipart bodies can retry) and
    /// parses the Cloudflare envelope. Returns the envelope `result`, which
    /// some endpoints legitimately leave null. The account token is attached as
    /// the bearer.
    async fn send<T: DeserializeOwned>(
        &self,
        build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<Option<T>, CfApiError> {
        self.send_impl(build, true).await
    }

    /// Like [`send`], but does not attach the account token — the closure must
    /// supply its own `Authorization`. Used for the asset upload, which
    /// authenticates with the upload-session JWT; attaching the account token
    /// too would send two `Authorization` headers and Cloudflare's edge rejects
    /// that with a 400.
    async fn send_no_auth<T: DeserializeOwned>(
        &self,
        build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<Option<T>, CfApiError> {
        self.send_impl(build, false).await
    }

    async fn send_impl<T: DeserializeOwned>(
        &self,
        build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
        account_auth: bool,
    ) -> Result<Option<T>, CfApiError> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let mut req = build(&self.http);
            if account_auth {
                req = req.bearer_auth(&self.token);
            }
            let sent = req.timeout(Duration::from_secs(60)).send().await;
            let retry_wait = Duration::from_millis(800 * (attempt as u64) * (attempt as u64));
            match sent {
                Err(e) => {
                    if attempt >= MAX_ATTEMPTS {
                        return Err(e.into());
                    }
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status == 401 || status == 403 {
                        return Err(CfApiError::Unauthorized);
                    }
                    let retryable = status == 429 || status >= 500;
                    let body = resp.text().await.unwrap_or_default();
                    match serde_json::from_str::<Envelope<T>>(&body) {
                        // Success = no errors reported. `success` defaults true
                        // for endpoints that omit it (Workers assets).
                        Ok(env) if env.success && env.errors.is_empty() => {
                            return Ok(env.result)
                        }
                        Ok(env) => {
                            if !retryable || attempt >= MAX_ATTEMPTS {
                                return Err(CfApiError::from_errors(&env.errors));
                            }
                        }
                        Err(parse_err) => {
                            if !retryable || attempt >= MAX_ATTEMPTS {
                                let mut short = body;
                                short.truncate(600);
                                return Err(CfApiError::Http {
                                    status,
                                    body: format!("[unparseable response: {parse_err}] {short}"),
                                });
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(retry_wait).await;
        }
    }

    fn required<T>(result: Option<T>, what: &str) -> Result<T, CfApiError> {
        result.ok_or_else(|| CfApiError::Other(format!("Cloudflare returned no {what}")))
    }

    // ── Accounts ────────────────────────────────────────────────────────────

    pub async fn list_accounts(token: &str) -> Result<Vec<Account>, CfApiError> {
        let client = CfClient::new(token.to_string(), String::new());
        let url = client.url("/accounts?per_page=50");
        let res = client.send::<Vec<Account>>(|h| h.get(&url)).await?;
        Self::required(res, "account list")
    }

    // ── D1 ──────────────────────────────────────────────────────────────────

    pub async fn find_d1(&self, name: &str) -> Result<Option<String>, CfApiError> {
        let url = self.url(&self.account_path(&format!("/d1/database?name={name}&per_page=100")));
        let dbs: Vec<D1Database> = self
            .send(|h| h.get(&url))
            .await?
            .unwrap_or_default();
        // The name param is a search, not an exact match — filter client-side.
        Ok(dbs.into_iter().find(|d| d.name == name).map(|d| d.uuid))
    }

    pub async fn create_d1(&self, name: &str) -> Result<String, CfApiError> {
        let url = self.url(&self.account_path("/d1/database"));
        let body = serde_json::json!({ "name": name });
        let db: Option<D1Database> = self.send(|h| h.post(&url).json(&body)).await?;
        Ok(Self::required(db, "database")?.uuid)
    }

    // ── KV ──────────────────────────────────────────────────────────────────

    pub async fn find_kv(&self, title: &str) -> Result<Option<String>, CfApiError> {
        let url = self.url(&self.account_path("/storage/kv/namespaces?per_page=100"));
        let namespaces: Vec<KvNamespace> = self
            .send(|h| h.get(&url))
            .await?
            .unwrap_or_default();
        Ok(namespaces.into_iter().find(|n| n.title == title).map(|n| n.id))
    }

    pub async fn create_kv(&self, title: &str) -> Result<String, CfApiError> {
        let url = self.url(&self.account_path("/storage/kv/namespaces"));
        let body = serde_json::json!({ "title": title });
        let ns: Option<KvNamespace> = self.send(|h| h.post(&url).json(&body)).await?;
        Ok(Self::required(ns, "key-value namespace")?.id)
    }

    // ── Vectorize ───────────────────────────────────────────────────────────

    pub async fn vectorize_exists(&self, name: &str) -> Result<bool, CfApiError> {
        let url = self.url(&self.account_path(&format!("/vectorize/v2/indexes/{name}")));
        match self.send::<VectorizeIndex>(|h| h.get(&url)).await {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(CfApiError::Unauthorized) => Err(CfApiError::Unauthorized),
            Err(CfApiError::Network(e)) => Err(CfApiError::Network(e)),
            // Missing index surfaces as an API/HTTP error; treat as "not there"
            // and let create fail loudly if something else is wrong.
            Err(_) => Ok(false),
        }
    }

    pub async fn create_vectorize(
        &self,
        name: &str,
        dimensions: u32,
        metric: &str,
    ) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path("/vectorize/v2/indexes"));
        let body = serde_json::json!({
            "name": name,
            "config": { "dimensions": dimensions, "metric": metric }
        });
        self.send::<serde_json::Value>(|h| h.post(&url).json(&body))
            .await?;
        Ok(())
    }

    // ── Static assets ───────────────────────────────────────────────────────

    /// Runs the full 3-phase asset upload; returns the completion JWT to embed
    /// in the Worker upload metadata.
    pub async fn upload_assets(
        &self,
        script: &str,
        files: &[AssetFile],
    ) -> Result<String, CfApiError> {
        let manifest: serde_json::Map<String, serde_json::Value> = files
            .iter()
            .map(|f| {
                (
                    f.path.clone(),
                    serde_json::json!({ "hash": f.hash, "size": f.size }),
                )
            })
            .collect();
        let url = self.url(&self.account_path(&format!(
            "/workers/scripts/{script}/assets-upload-session"
        )));
        let body = serde_json::json!({ "manifest": manifest });
        let session: UploadSession = Self::required(
            self.send(|h| h.post(&url).json(&body)).await?,
            "asset upload session",
        )?;
        let session_jwt = session
            .jwt
            .ok_or_else(|| CfApiError::Other("asset upload session missing token".into()))?;

        // No buckets ⇒ everything already uploaded; the session JWT doubles as
        // the completion token.
        if session.buckets.is_empty() {
            return Ok(session_jwt);
        }

        let upload_url = self.url(&self.account_path("/workers/assets/upload?base64=true"));
        let mut completion: Option<String> = None;
        for bucket in &session.buckets {
            let parts: Vec<(String, String, &'static str)> = bucket
                .iter()
                .filter_map(|hash| files.iter().find(|f| &f.hash == hash))
                .map(|f| {
                    (
                        f.hash.clone(),
                        base64::engine::general_purpose::STANDARD.encode(f.bytes),
                        f.mime,
                    )
                })
                .collect();
            let jwt = session_jwt.clone();
            let upload_url = upload_url.clone();
            let uploaded: Option<UploadedBucket> = self
                .send_no_auth(move |h| {
                    let mut form = Form::new();
                    for (hash, b64, mime) in &parts {
                        let part = Part::text(b64.clone())
                            .mime_str(mime)
                            .expect("static mime strings are valid");
                        form = form.part(hash.clone(), part);
                    }
                    h.post(&upload_url)
                        .header("Authorization", format!("Bearer {jwt}"))
                        .multipart(form)
                })
                .await?;
            if let Some(done) = uploaded.and_then(|u| u.jwt) {
                completion = Some(done);
            }
        }
        completion.ok_or_else(|| {
            CfApiError::Other("asset upload finished without a completion token".into())
        })
    }

    // ── Worker script ───────────────────────────────────────────────────────

    pub async fn deploy_worker(
        &self,
        script: &str,
        metadata: &serde_json::Value,
        worker_js: &'static [u8],
    ) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path(&format!("/workers/scripts/{script}")));
        let metadata_str = metadata.to_string();
        log::info!(
            "deploy_worker: {} bytes of code, {} bytes of metadata, {} bindings",
            worker_js.len(),
            metadata_str.len(),
            metadata.get("bindings").and_then(|b| b.as_array()).map_or(0, |a| a.len()),
        );
        self.send::<serde_json::Value>(move |h| {
            let form = Form::new()
                .part(
                    "metadata",
                    Part::text(metadata_str.clone())
                        .mime_str("application/json")
                        .expect("valid mime"),
                )
                .part(
                    "worker.js",
                    Part::bytes(worker_js)
                        .file_name("worker.js")
                        .mime_str("application/javascript+module")
                        .expect("valid mime"),
                );
            h.put(&url).multipart(form)
        })
        .await?;
        Ok(())
    }

    /// Reads a deployed script's current bindings (from its settings), so an
    /// update can reuse the *actual* database/namespace/index IDs already
    /// bound rather than guessing by name.
    pub async fn get_script_bindings(
        &self,
        script: &str,
    ) -> Result<Vec<serde_json::Value>, CfApiError> {
        let url = self.url(&self.account_path(&format!("/workers/scripts/{script}/settings")));
        let settings: Option<serde_json::Value> = self.send(|h| h.get(&url)).await?;
        Ok(settings
            .and_then(|s| s.get("bindings").cloned())
            .and_then(|b| b.as_array().cloned())
            .unwrap_or_default())
    }

    pub async fn set_cron(&self, script: &str, crons: &[String]) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path(&format!("/workers/scripts/{script}/schedules")));
        // Body is a bare array, not an object.
        let body: Vec<serde_json::Value> = crons
            .iter()
            .map(|c| serde_json::json!({ "cron": c }))
            .collect();
        self.send::<serde_json::Value>(|h| h.put(&url).json(&body))
            .await?;
        Ok(())
    }

    // ── workers.dev subdomain ───────────────────────────────────────────────

    pub async fn get_account_subdomain(&self) -> Result<Option<String>, CfApiError> {
        let url = self.url(&self.account_path("/workers/subdomain"));
        match self.send::<SubdomainResult>(|h| h.get(&url)).await {
            Ok(Some(r)) => Ok(r.subdomain.filter(|s| !s.is_empty())),
            Ok(None) => Ok(None),
            Err(CfApiError::Unauthorized) => Err(CfApiError::Unauthorized),
            Err(CfApiError::Network(e)) => Err(CfApiError::Network(e)),
            Err(_) => Ok(None),
        }
    }

    pub async fn register_account_subdomain(&self, name: &str) -> Result<String, CfApiError> {
        let url = self.url(&self.account_path("/workers/subdomain"));
        let body = serde_json::json!({ "subdomain": name });
        let res: Option<SubdomainResult> = self.send(|h| h.put(&url).json(&body)).await?;
        Self::required(res, "subdomain")?
            .subdomain
            .ok_or_else(|| CfApiError::Other("subdomain registration returned nothing".into()))
    }

    pub async fn enable_script_subdomain(&self, script: &str) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path(&format!("/workers/scripts/{script}/subdomain")));
        let body = serde_json::json!({ "enabled": true, "previews_enabled": false });
        self.send::<serde_json::Value>(|h| h.post(&url).json(&body))
            .await?;
        Ok(())
    }
}

// ── Worker smoke tests (talk to the deployed Worker, not the CF API) ─────────

/// Outcome of probing an address the user claims is an existing Second Brain.
#[derive(Debug, PartialEq, Eq)]
pub enum WorkerProbe {
    /// Authenticated and answered like a Second Brain (even if its vector
    /// index is degraded — the dashboard surfaces that itself).
    Valid,
    WrongPassword,
    /// Reached something, but it doesn't speak the Second Brain health
    /// contract — almost certainly the wrong address.
    NotABrain,
}

/// Validates a user-supplied address for the "connect an existing Second
/// Brain" path. Unlike [`worker_health_ok`], a degraded index still counts as
/// valid: the brain exists and the password is right.
///
/// Tries `/health` first, but falls back to `/count` for brains deployed
/// before the `/health` endpoint existed — those return 404 there, while
/// `/count` has been an auth-gated JSON route since the earliest versions.
pub async fn probe_worker(worker_url: &str, auth_token: &str) -> Result<WorkerProbe, CfApiError> {
    let http = reqwest::Client::new();
    for (path, expected_key) in [("/health", "vectorize"), ("/count", "count")] {
        let resp = http
            .get(format!("{worker_url}{path}"))
            .bearer_auth(auth_token)
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        if resp.status().as_u16() == 401 {
            return Ok(WorkerProbe::WrongPassword);
        }
        if !resp.status().is_success() {
            continue; // e.g. 404 from an older Worker — try the next probe
        }
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if body.get(expected_key).is_some() {
            return Ok(WorkerProbe::Valid);
        }
    }
    Ok(WorkerProbe::NotABrain)
}

/// GET /health — passes only when the Worker is live AND its vector index is
/// wired (`ok && vectorize.ok`), per the Worker's own health contract.
pub async fn worker_health_ok(worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
    let http = reqwest::Client::new();
    let resp = http
        .get(format!("{worker_url}/health"))
        .bearer_auth(auth_token)
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    if resp.status().as_u16() == 401 {
        return Err(CfApiError::Unauthorized);
    }
    if !resp.status().is_success() {
        return Ok(false);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(body["ok"] == true && body["vectorize"]["ok"] == true)
}

/// GET /health and return the Worker's reported `version` (None if the field
/// is absent — e.g. a deployment predating the version echo).
pub async fn worker_version(
    worker_url: &str,
    auth_token: &str,
) -> Result<Option<String>, CfApiError> {
    let http = reqwest::Client::new();
    let resp = http
        .get(format!("{worker_url}/health"))
        .bearer_auth(auth_token)
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    if resp.status().as_u16() == 401 {
        return Err(CfApiError::Unauthorized);
    }
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(body
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

/// POST /capture — end-to-end write test. A `duplicate` response counts as a
/// pass (the Worker is clearly functioning; re-runs hit dedupe by design).
pub async fn worker_capture_ok(worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("{worker_url}/capture"))
        .bearer_auth(auth_token)
        .json(&serde_json::json!({
            "content": "Second Brain setup complete",
            "source": "installer"
        }))
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    if resp.status().as_u16() == 401 {
        return Err(CfApiError::Unauthorized);
    }
    if !resp.status().is_success() {
        return Ok(false);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(body["ok"] == true || body["duplicate"] == true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_parses_success_and_failure() {
        let ok: Envelope<Vec<Account>> = serde_json::from_str(
            r#"{"success":true,"errors":[],"result":[{"id":"abc","name":"My Account"}]}"#,
        )
        .unwrap();
        assert!(ok.success);
        assert_eq!(ok.result.unwrap()[0].id, "abc");

        let err: Envelope<Vec<Account>> = serde_json::from_str(
            r#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"result":null}"#,
        )
        .unwrap();
        assert!(!err.success);
        match CfApiError::from_errors(&err.errors) {
            CfApiError::Api { code, message } => {
                assert_eq!(code, 10000);
                assert_eq!(message, "Authentication error");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn envelope_parses_assets_response_without_success_field() {
        // The Workers assets-upload-session endpoint returns `{ "result": … }`
        // with no top-level `success` — this used to fail parsing and abort the
        // whole deploy. It must now parse and be treated as a success.
        let body = r#"{"result":{"jwt":"cfwau_abc","buckets":[["hash1","hash2"]],"manifest_id":"m-1"}}"#;
        let env: Envelope<UploadSession> = serde_json::from_str(body).unwrap();
        assert!(env.success, "missing `success` must default to true");
        assert!(env.errors.is_empty());
        let session = env.result.unwrap();
        assert_eq!(session.jwt.as_deref(), Some("cfwau_abc"));
        assert_eq!(session.buckets, vec![vec!["hash1".to_string(), "hash2".to_string()]]);

        // The completion response (no buckets) must also parse.
        let done: Envelope<UploadSession> =
            serde_json::from_str(r#"{"result":{"jwt":"cfwau_done"}}"#).unwrap();
        assert!(done.success);
        assert!(done.result.unwrap().buckets.is_empty());

        // Cloudflare sends `null` (not `[]` or missing) for empty collections;
        // both `errors: null` and `buckets: null` must be tolerated.
        let nulls: Envelope<UploadSession> = serde_json::from_str(
            r#"{"result":{"jwt":"cfwau_x","buckets":null},"success":true,"errors":null,"messages":null}"#,
        )
        .unwrap();
        assert!(nulls.success);
        assert!(nulls.errors.is_empty());
        assert!(nulls.result.unwrap().buckets.is_empty());
    }

    #[tokio::test]
    async fn send_retries_transient_errors() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hits = Arc::new(AtomicU32::new(0));
        let hits_bg = hits.clone();
        std::thread::spawn(move || {
            loop {
                let Ok(req) = server.recv() else { return };
                let n = hits_bg.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if n == 0 {
                    (500, r#"{"success":false,"errors":[{"code":1,"message":"boom"}]}"#)
                } else {
                    (200, r#"{"success":true,"errors":[],"result":{"id":"kv1","title":"t"}}"#)
                };
                let resp = tiny_http::Response::from_string(body)
                    .with_status_code(status);
                let _ = req.respond(resp);
            }
        });

        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );
        let url = client.url("/anything");
        let res: Option<KvNamespace> = client.send(|h| h.get(&url)).await.unwrap();
        assert_eq!(res.unwrap().id, "kv1");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn probe_worker_classifies_responses() {
        // One tiny server; the path selects the scenario.
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            loop {
                let Ok(req) = server.recv() else { return };
                let (status, body) = match req.url() {
                    u if u.starts_with("/valid") => {
                        (200, r#"{"ok":false,"vectorize":{"ok":false,"indexName":"second-brain-vectors"}}"#)
                    }
                    u if u.starts_with("/wrongpw") => (401, r#"{"ok":false,"error":"Unauthorized"}"#),
                    // Pre-/health Worker: 404 there, but /count answers.
                    u if u.starts_with("/old/health") => (404, "Not found"),
                    u if u.starts_with("/old/count") => (200, r#"{"count":42}"#),
                    // Pre-/health Worker + wrong password: 404 then 401.
                    u if u.starts_with("/oldpw/health") => (404, "Not found"),
                    u if u.starts_with("/oldpw/count") => (401, r#"{"ok":false,"error":"Unauthorized"}"#),
                    _ => (200, r#"<html>welcome to my blog</html>"#),
                };
                let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
            }
        });
        let base = format!("http://127.0.0.1:{port}");

        // Degraded index still authenticates ⇒ Valid.
        assert_eq!(
            probe_worker(&format!("{base}/valid"), "pw").await.unwrap(),
            WorkerProbe::Valid
        );
        assert_eq!(
            probe_worker(&format!("{base}/wrongpw"), "pw").await.unwrap(),
            WorkerProbe::WrongPassword
        );
        // Older deployment without /health falls back to /count.
        assert_eq!(
            probe_worker(&format!("{base}/old"), "pw").await.unwrap(),
            WorkerProbe::Valid
        );
        assert_eq!(
            probe_worker(&format!("{base}/oldpw"), "pw").await.unwrap(),
            WorkerProbe::WrongPassword
        );
        assert_eq!(
            probe_worker(&format!("{base}/blog"), "pw").await.unwrap(),
            WorkerProbe::NotABrain
        );
        assert!(probe_worker("http://127.0.0.1:1/nothing", "pw").await.is_err());
    }

    #[tokio::test]
    async fn send_does_not_retry_client_errors() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hits = Arc::new(AtomicU32::new(0));
        let hits_bg = hits.clone();
        std::thread::spawn(move || {
            loop {
                let Ok(req) = server.recv() else { return };
                hits_bg.fetch_add(1, Ordering::SeqCst);
                let resp = tiny_http::Response::from_string(
                    r#"{"success":false,"errors":[{"code":7003,"message":"no such route"}]}"#,
                )
                .with_status_code(400);
                let _ = req.respond(resp);
            }
        });

        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );
        let url = client.url("/anything");
        let err = client
            .send::<KvNamespace>(|h| h.get(&url))
            .await
            .unwrap_err();
        match err {
            CfApiError::Api { code, .. } => assert_eq!(code, 7003),
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
