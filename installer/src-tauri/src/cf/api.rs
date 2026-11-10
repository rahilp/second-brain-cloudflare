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

    /// Find-before-create probe. Errors other than auth/network collapse to
    /// `false`, which is safe *here* because the only consequence of guessing
    /// wrong is that the following `create_vectorize` fails loudly.
    ///
    /// **Do not copy this error handling.** [`Self::vectorize_config`] and
    /// [`Self::vectorize_info`] answer questions where a swallowed error would
    /// be read as a fact — "the new index isn't ready", "the index holds no
    /// vectors" — and the second of those precedes an irreversible delete. The
    /// asymmetry between these methods is deliberate; making them consistent
    /// would mean choosing between a useless probe and a dangerous one.
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

    /// An index's real dimensions and distance metric, read back from
    /// Cloudflare rather than assumed from the manifest.
    ///
    /// GETs the same path as [`Self::vectorize_exists`], which throws this body
    /// away to answer a bool. Every error propagates — see that method's note
    /// on why the two must not be made consistent. A missing index is an error,
    /// not `None`: callers ask this about an index they believe exists, and
    /// "absent" and "unreadable" must not arrive looking the same.
    #[allow(dead_code)] // called by the #248 embedding migration landing alongside this
    pub async fn vectorize_config(&self, name: &str) -> Result<VectorizeConfig, CfApiError> {
        let url = self.url(&self.account_path(&format!("/vectorize/v2/indexes/{name}")));
        let index: VectorizeIndex =
            Self::required(self.send(|h| h.get(&url)).await?, "vectorize index")?;
        index
            .config
            .ok_or_else(|| CfApiError::Other(format!("index {name} reported no configuration")))
    }

    /// An index's vector count and indexing progress.
    ///
    /// A separate endpoint from the index record on purpose: the record itself
    /// carries no count — Cloudflare exposes it only on this `/info` sibling —
    /// so [`Self::vectorize_config`] cannot answer "is the rebuild complete?".
    /// Errors propagate for the same reason as there, and doubly so: this is
    /// the reading a caller checks before calling [`Self::delete_vectorize`].
    #[allow(dead_code)] // called by the #248 embedding migration landing alongside this
    pub async fn vectorize_info(&self, name: &str) -> Result<VectorizeInfo, CfApiError> {
        let url = self.url(&self.account_path(&format!("/vectorize/v2/indexes/{name}/info")));
        Self::required(self.send(|h| h.get(&url)).await?, "vectorize index info")
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

    /// Property names this index can filter on. Errors propagate: "none" must
    /// mean none, because the caller decides from it whether to create one.
    pub async fn vectorize_metadata_indexes(&self, name: &str) -> Result<Vec<String>, CfApiError> {
        let url = self.url(&self.account_path(&format!("/vectorize/v2/indexes/{name}/metadata_index/list")));
        let list: MetadataIndexList =
            Self::required(self.send(|h| h.get(&url)).await?, "vectorize metadata index list")?;
        Ok(list.metadata_indexes.into_iter().map(|m| m.property_name).collect())
    }

    /// Lets the index filter on `property`. Only vectors written after this
    /// call are filterable on it, so callers create it on an empty index.
    pub async fn create_vectorize_metadata_index(
        &self,
        name: &str,
        property: &str,
        index_type: &str,
    ) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path(&format!("/vectorize/v2/indexes/{name}/metadata_index/create")));
        let body = serde_json::json!({ "propertyName": property, "indexType": index_type });
        self.send::<serde_json::Value>(|h| h.post(&url).json(&body)).await?;
        Ok(())
    }

    /// Deletes an index and every vector in it.
    ///
    /// **Unrecoverable — confirm with the user first.** There is no undo and no
    /// export: rebuilding means re-embedding every entry from D1 at full neuron
    /// cost, and if the entries are gone too the memories are simply lost.
    /// Callers must have verified that whatever replaces this index is populated
    /// and bound before getting here.
    ///
    /// Not idempotent: deleting an index that is already absent returns an error
    /// (Cloudflare answers 404, which `send` neither retries nor softens), so a
    /// resumed migration has to tolerate that rather than assume a second delete
    /// is a no-op.
    #[allow(dead_code)] // called by the #248 embedding migration landing alongside this
    pub async fn delete_vectorize(&self, name: &str) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path(&format!("/vectorize/v2/indexes/{name}")));
        self.send::<serde_json::Value>(|h| h.delete(&url)).await?;
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

    /// Writes one secret on a deployed script, leaving everything else alone.
    ///
    /// The whole of a password change (#235) is this request. The obvious
    /// alternative — redeploy with the new `AUTH_TOKEN` in the upload metadata —
    /// re-uploads every asset and rewrites every binding to change one field, and
    /// it forces a question nobody has an answer to: whether an explicit
    /// `secret_text` binding beats `keep_bindings` when a deploy carries both. A
    /// wrong answer there either drops a secret the user added by hand or keeps
    /// the old password while reporting success, and the second failure stays
    /// invisible until they are locked out.
    ///
    /// An upsert, not an update: the same request sets a secret that was never
    /// there. Cloudflare applies it to the live deployment asynchronously, so the
    /// Worker can still be serving the previous value for a few seconds after
    /// this returns — callers that need the new value to be in force must verify
    /// it themselves (see `provision::rotate_secret`).
    pub async fn put_secret(&self, script: &str, name: &str, text: &str) -> Result<(), CfApiError> {
        let url = self.url(&self.account_path(&format!("/workers/scripts/{script}/secrets")));
        let body = serde_json::json!({ "name": name, "text": text, "type": "secret_text" });
        self.send::<serde_json::Value>(|h| h.put(&url).json(&body))
            .await?;
        Ok(())
    }

    // ── workers.dev subdomain ───────────────────────────────────────────────

    /// Every Worker script in the account, by deploy name.
    ///
    /// Used by brain discovery to build candidate workers.dev URLs. An account
    /// with no Workers is a legitimate empty list, not an error — Cloudflare
    /// returns `result: []`, and a null result is treated the same way.
    pub async fn list_workers(&self) -> Result<Vec<String>, CfApiError> {
        let url = self.url(&self.account_path("/workers/scripts"));
        let res = self.send::<Vec<WorkerScript>>(|h| h.get(&url)).await?;
        Ok(res
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.id)
            .filter(|id| !id.is_empty())
            .collect())
    }

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
            // The brain's own `requireAuth`, not Cloudflare's — see
            // [`CfApiError::WorkerAuthRejected`] for why the two must not share
            // an error.
            return Err(CfApiError::WorkerAuthRejected);
        }
    if !resp.status().is_success() {
        return Ok(false);
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(body["ok"] == true && body["vectorize"]["ok"] == true)
}

/// GET /health with **no credentials** — one question: is whatever is listening
/// a brain that demands authentication?
///
/// This is the control arm the authenticated probes cannot provide for
/// themselves. A 401 with a bearer token means *something* refused the
/// password — but not whether that something is the current deployment (a real
/// password problem) or a stale edge node still serving the previous one,
/// holding the previous secret (a wait-it-out problem, invisible once setup has
/// already given up). Asking the same URL unauthenticated separates them: a
/// 401 there means the live version demands auth, so the refusal was real;
/// anything else means the answering version would not have refused anyone, so
/// what the poll talked to was not the deployment just uploaded.
pub async fn worker_requires_auth(worker_url: &str) -> Result<bool, CfApiError> {
    let http = reqwest::Client::new();
    let resp = http
        .get(format!("{worker_url}/health"))
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    Ok(resp.status().as_u16() == 401)
}

/// GET /health, asking one question only: **does this password open this
/// brain?**
///
/// Every answer other than a 401 is a pass — a 500, a 404, a body that is not
/// JSON at all. That is the whole difference from [`worker_health_ok`], and it
/// is deliberate: the Worker runs `requireAuth` before any route body
/// (`src/lib/http.ts`), so anything that is not a 401 is proof the token was
/// accepted, whatever went wrong afterwards.
///
/// This exists for [`super::provision::rotate_secret`], whose gate is "has the
/// new password taken effect", not "is this brain healthy". Gating a rotation on
/// full health makes a brain with a degraded vector index **permanently
/// unrotatable**: `vectorize.ok` is false, so the poll can never go green, so
/// nothing local is ever written — the keychain keeps the old password while the
/// brain is already on the new one, and "Try again" lands on the identical
/// screen forever. The password change succeeded on the first attempt and
/// nothing in the app is able to say so.
///
/// [`worker_health_ok`] stays as it is, and `provision`/`update_worker` keep
/// using it. There a 401 means a secret was dropped and a degraded index means
/// the deploy is not finished, so both legitimately want the whole contract.
///
/// Never answers `Ok(false)`. A refusal comes back as [`CfApiError::WorkerAuthRejected`]
/// because the caller has to tell "the edge is still serving the old secret"
/// apart from a network error, and a bool cannot carry that; the `bool` is here
/// so the [`super::provision::Backend`] method mirrors `health_ok` and a dry run can
/// wave through an address with no server behind it.
pub async fn worker_auth_ok(worker_url: &str, auth_token: &str) -> Result<bool, CfApiError> {
    let http = reqwest::Client::new();
    let resp = http
        .get(format!("{worker_url}/health"))
        .bearer_auth(auth_token)
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    if resp.status().as_u16() == 401 {
        return Err(CfApiError::WorkerAuthRejected);
    }
    Ok(true)
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
        return Err(CfApiError::WorkerAuthRejected);
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
        // The brain's own `requireAuth`, not Cloudflare's — see
        // [`CfApiError::WorkerAuthRejected`].
        return Err(CfApiError::WorkerAuthRejected);
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

    /// Brain discovery builds candidate addresses from this list, so an
    /// account with no Workers and an account Cloudflare answers with
    /// `result: null` must both come back as an empty list rather than an error
    /// — otherwise discovery reports a failure for a perfectly normal account.
    #[tokio::test]
    async fn list_workers_returns_script_names_and_tolerates_empty_accounts() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let body = match req.url() {
                u if u.contains("/accounts/full/") => {
                    r#"{"success":true,"errors":[],"result":[{"id":"second-brain"},{"id":"unrelated-api"},{"id":""}]}"#
                }
                u if u.contains("/accounts/empty/") => {
                    r#"{"success":true,"errors":[],"result":[]}"#
                }
                // Cloudflare sends a null result on some endpoints rather than
                // an empty array.
                _ => r#"{"success":true,"errors":[],"result":null}"#,
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(200));
        });
        let base = format!("http://127.0.0.1:{port}");

        let full = CfClient::with_base("tok".into(), "full".into(), base.clone());
        // The blank id is dropped: it would build "https://.sub.workers.dev".
        assert_eq!(
            full.list_workers().await.unwrap(),
            vec!["second-brain".to_string(), "unrelated-api".to_string()]
        );

        let empty = CfClient::with_base("tok".into(), "empty".into(), base.clone());
        assert!(empty.list_workers().await.unwrap().is_empty());

        let nulled = CfClient::with_base("tok".into(), "nulled".into(), base);
        assert!(nulled.list_workers().await.unwrap().is_empty());
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

    /// `delete_vectorize` is the file's first DELETE, so the stub records the
    /// method as well as the path and only answers success for the exact pair.
    /// A delete that quietly went out as a POST, or to the collection instead
    /// of the index, would otherwise still look like a passing test.
    /// The two metadata-index calls go to the paths and body wrangler's own
    /// `create-metadata-index` and `list-metadata-index` use.
    #[tokio::test]
    async fn metadata_index_calls_match_the_vectorize_api() {
        use std::sync::{Arc, Mutex};

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_bg = seen.clone();
        std::thread::spawn(move || loop {
            let Ok(mut req) = server.recv() else { return };
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let line = format!("{} {}", req.method().as_str(), req.url());
            seen_bg.lock().unwrap().push(format!("{line} {body}").trim_end().to_string());
            let (status, reply) = match line.as_str() {
                "GET /accounts/acct/vectorize/v2/indexes/idx/metadata_index/list" => (
                    200,
                    r#"{"success":true,"errors":[],"result":{"metadataIndexes":[{"propertyName":"workspace_id","indexType":"String"}]}}"#,
                ),
                "POST /accounts/acct/vectorize/v2/indexes/idx/metadata_index/create" => (
                    200,
                    r#"{"success":true,"errors":[],"result":{"mutationId":"m-1"}}"#,
                ),
                _ => (405, r#"{"success":false,"errors":[{"code":7003,"message":"no route"}]}"#),
            };
            let _ = req.respond(tiny_http::Response::from_string(reply).with_status_code(status));
        });

        let client = CfClient::with_base("tok".into(), "acct".into(), format!("http://127.0.0.1:{port}"));
        assert_eq!(client.vectorize_metadata_indexes("idx").await.unwrap(), vec!["workspace_id".to_string()]);
        client.create_vectorize_metadata_index("idx", "workspace_id", "string").await.unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen[0], "GET /accounts/acct/vectorize/v2/indexes/idx/metadata_index/list");
        let (line, body) = seen[1].split_once(" {").unwrap();
        assert_eq!(line, "POST /accounts/acct/vectorize/v2/indexes/idx/metadata_index/create");
        let body: serde_json::Value = serde_json::from_str(&format!("{{{body}")).unwrap();
        assert_eq!(body, serde_json::json!({ "propertyName": "workspace_id", "indexType": "string" }));
    }

    #[tokio::test]
    async fn delete_vectorize_sends_a_delete_to_the_index_path() {
        use std::sync::{Arc, Mutex};

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_bg = seen.clone();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let line = format!("{} {}", req.method().as_str(), req.url());
            seen_bg.lock().unwrap().push(line.clone());
            let (status, body) = match line.as_str() {
                // The documented success shape: `result` is an empty object.
                "DELETE /accounts/acct/vectorize/v2/indexes/second-brain-vectors-384" => {
                    (200, r#"{"success":true,"errors":[],"messages":[],"result":{}}"#)
                }
                // Cloudflare nulls empty results on some endpoints; a delete
                // ignores the body either way.
                "DELETE /accounts/acct/vectorize/v2/indexes/nulled" => {
                    (200, r#"{"success":true,"errors":[],"result":null}"#)
                }
                // Any other verb or path is a failure, not a pass.
                _ => (
                    405,
                    r#"{"success":false,"errors":[{"code":7003,"message":"no route for that method and path"}]}"#,
                ),
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        });

        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );
        client
            .delete_vectorize("second-brain-vectors-384")
            .await
            .unwrap();
        client.delete_vectorize("nulled").await.unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "DELETE /accounts/acct/vectorize/v2/indexes/second-brain-vectors-384".to_string(),
                "DELETE /accounts/acct/vectorize/v2/indexes/nulled".to_string(),
            ]
        );
    }

    /// Deleting an index that is already gone is **not** a no-op: Cloudflare
    /// answers 404 and [`CfClient::send`] neither retries nor softens it, so the
    /// call returns an error. Asserted as the behaviour that actually happens
    /// rather than the more convenient idempotent one, because a resumed
    /// migration has to be written against the former.
    ///
    /// The numeric code in the fixture is the fixture's own: Cloudflare's public
    /// docs do not publish the code for a missing Vectorize index, and what this
    /// pins is that the client reads the envelope's error rather than inventing
    /// one.
    #[tokio::test]
    async fn delete_vectorize_surfaces_a_missing_index_without_retrying() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hits = Arc::new(AtomicU32::new(0));
        let hits_bg = hits.clone();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            hits_bg.fetch_add(1, Ordering::SeqCst);
            let resp = tiny_http::Response::from_string(
                r#"{"success":false,"errors":[{"code":4001,"message":"vectorize index not found"}],"result":null}"#,
            )
            .with_status_code(404);
            let _ = req.respond(resp);
        });

        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );
        match client.delete_vectorize("already-gone").await {
            Err(CfApiError::Api { code, message }) => {
                assert_eq!(code, 4001);
                assert!(message.contains("not found"), "lost the message: {message}");
            }
            other => panic!("a missing index must not read as success: {other:?}"),
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "a 404 is not transient — retrying it wastes the user's time"
        );
    }

    /// The point of the accessor over `vectorize_exists`: it reads the index's
    /// *real* dimensions back instead of trusting the manifest's assumed 384.
    #[tokio::test]
    async fn vectorize_config_reads_back_real_dimensions() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let body = match req.url() {
                "/accounts/acct/vectorize/v2/indexes/bge-large" => {
                    r#"{"success":true,"errors":[],"result":{"name":"bge-large","config":{"dimensions":1024,"metric":"cosine"},"created_on":"2026-07-30T00:00:00Z","modified_on":"2026-07-30T00:00:00Z"}}"#
                }
                // Cloudflare's schema marks every field on the record optional,
                // so a record without a config is representable.
                "/accounts/acct/vectorize/v2/indexes/configless" => {
                    r#"{"success":true,"errors":[],"result":{"name":"configless"}}"#
                }
                _ => r#"{"success":true,"errors":[],"result":null}"#,
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(200));
        });
        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );

        assert_eq!(
            client.vectorize_config("bge-large").await.unwrap(),
            VectorizeConfig {
                dimensions: 1024,
                metric: "cosine".into()
            }
        );

        // A config-less record is an error, not `dimensions: 0`. A zero would
        // compare unequal to every real dimension while looking like an answer.
        match client.vectorize_config("configless").await {
            Err(CfApiError::Other(m)) => {
                assert!(m.contains("no configuration"), "unexpected message: {m}")
            }
            other => panic!("a config-less record must not yield a default: {other:?}"),
        }
        // Nor does a null result.
        match client.vectorize_config("missing").await {
            Err(CfApiError::Other(m)) => {
                assert!(m.contains("vectorize index"), "unexpected message: {m}")
            }
            other => panic!("a null result must not yield a default: {other:?}"),
        }
    }

    /// The count lives on the `/info` sibling, not on the index record — the
    /// exact-path stub fails the test if the suffix is ever dropped. `None`
    /// (Cloudflare said nothing) and `Some(0)` (Cloudflare said empty) must stay
    /// distinguishable: the first is ignorance, the second is a fact, and one of
    /// them precedes an irreversible delete.
    #[tokio::test]
    async fn vectorize_info_reports_a_count_and_keeps_unknown_apart_from_zero() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let body = match req.url() {
                "/accounts/acct/vectorize/v2/indexes/rebuilt/info" => {
                    r#"{"success":true,"errors":[],"result":{"vectorCount":2048,"dimensions":768,"processedUpToDatetime":"2026-07-30T00:00:00Z","processedUpToMutation":"mut-7"}}"#
                }
                "/accounts/acct/vectorize/v2/indexes/emptied/info" => {
                    r#"{"success":true,"errors":[],"result":{"vectorCount":0,"dimensions":768}}"#
                }
                // Every field is optional; a silent payload must stay silent.
                "/accounts/acct/vectorize/v2/indexes/quiet/info" => {
                    r#"{"success":true,"errors":[],"result":{}}"#
                }
                _ => r#"{"success":false,"errors":[{"code":7003,"message":"wrong path"}]}"#,
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(200));
        });
        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );

        let rebuilt = client.vectorize_info("rebuilt").await.unwrap();
        assert_eq!(rebuilt.vector_count, Some(2048));
        assert_eq!(rebuilt.dimensions, Some(768));
        assert_eq!(rebuilt.processed_up_to_mutation.as_deref(), Some("mut-7"));

        assert_eq!(
            client.vectorize_info("emptied").await.unwrap().vector_count,
            Some(0),
            "a reported zero is a fact and must survive"
        );
        assert_eq!(
            client.vectorize_info("quiet").await.unwrap().vector_count,
            None,
            "an unreported count must not become zero"
        );
    }

    /// `vectorize_exists` is *allowed* to swallow errors — find-before-create
    /// only needs a hint, and a wrong guess makes the create fail loudly. The
    /// accessors are not allowed to, because their answers are read as facts:
    /// "the new index has no config yet", "the old index holds no vectors".
    ///
    /// This test exists to make "let's make these three consistent" go red
    /// rather than turn an outage into a green light for deleting a brain.
    #[tokio::test]
    async fn vectorize_accessors_do_not_swallow_errors_that_the_probe_does() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let (status, body) = match req.url() {
                // A real API error…
                u if u.contains("/outage") => (
                    400,
                    r#"{"success":false,"errors":[{"code":10000,"message":"internal error"}]}"#,
                ),
                // …and an edge that answers HTML instead of the envelope.
                _ => (200, "<html>gateway</html>"),
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        });
        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );

        for name in ["outage", "htmlwall"] {
            assert!(
                !client.vectorize_exists(name).await.unwrap(),
                "the probe is deliberately allowed to call {name} absent"
            );
            assert!(
                client.vectorize_config(name).await.is_err(),
                "vectorize_config swallowed the {name} failure"
            );
            assert!(
                client.vectorize_info(name).await.is_err(),
                "vectorize_info swallowed the {name} failure"
            );
        }
    }

    /// The body shape is the whole risk here. Cloudflare accepts the request and
    /// answers `success: true` for a payload that names the wrong field, and the
    /// only symptom is that the user's password did not change — discovered the
    /// next time they try to sign in, from a machine that no longer works. A
    /// compiler cannot check a `json!` literal, so the assertion is an exact
    /// value comparison: an extra key or a renamed one fails it.
    ///
    /// The method matters as much: `POST` to the same path is a different
    /// operation, and the account bearer proves this went through `send` rather
    /// than the JWT-authenticated `send_no_auth` used for asset uploads.
    #[tokio::test]
    async fn put_secret_sends_the_documented_body_to_the_script_secrets_path() {
        use std::sync::{Arc, Mutex};

        #[derive(Debug)]
        struct Seen {
            method: String,
            path: String,
            auth: String,
            body: String,
        }

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_bg = seen.clone();
        std::thread::spawn(move || loop {
            let Ok(mut req) = server.recv() else { return };
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let auth = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .map(|h| h.value.as_str().to_string())
                .unwrap_or_default();
            seen_bg.lock().unwrap().push(Seen {
                method: req.method().as_str().to_string(),
                path: req.url().to_string(),
                auth,
                body,
            });
            // What Cloudflare answers: the secret it stored, never its value.
            let _ = req.respond(
                tiny_http::Response::from_string(
                    r#"{"success":true,"errors":[],"messages":[],"result":{"name":"AUTH_TOKEN","type":"secret_text"}}"#,
                )
                .with_status_code(200),
            );
        });

        let client = CfClient::with_base(
            "tok".into(),
            "acct".into(),
            format!("http://127.0.0.1:{port}"),
        );
        client
            .put_secret("my-brain", "AUTH_TOKEN", "correct horse battery staple")
            .await
            .unwrap();

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "one write, not a retry loop: {seen:?}");
        assert_eq!(seen[0].method, "PUT");
        assert_eq!(seen[0].path, "/accounts/acct/workers/scripts/my-brain/secrets");
        assert_eq!(seen[0].auth, "Bearer tok");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&seen[0].body).unwrap(),
            serde_json::json!({
                "name": "AUTH_TOKEN",
                "text": "correct horse battery staple",
                "type": "secret_text"
            }),
            "exact body shape, not a superset"
        );
    }

    /// The three ways the write can be refused, which a rotation has to tell
    /// apart. Until now the stub only ever answered `200 {"success":true}`, so
    /// the whole error mapping was unexercised — and `commands::rotation_failure`
    /// routes `Unauthorized` to a different screen ("sign in to Cloudflare
    /// again") from everything else, so getting it wrong sends a user to fix a
    /// problem they do not have.
    ///
    /// The 403 is not a duplicate of the 401. Cloudflare answers 403 for a
    /// session that is signed in but whose token lacks Workers Scripts:Edit, and
    /// re-authorising is the fix for both — so both must reach the same screen.
    ///
    /// The 500 pins the other half: a server error must *not* look like an auth
    /// problem, or a Cloudflare incident tells the user their sign-in expired.
    /// It costs the retry ladder's ~4s of backoff, which is the price of
    /// asserting that a 5xx really is retried and a 4xx really is not.
    #[tokio::test]
    async fn put_secret_maps_the_refusals_a_rotation_has_to_tell_apart() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hits = Arc::new(AtomicU32::new(0));
        let hits_bg = hits.clone();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            hits_bg.fetch_add(1, Ordering::SeqCst);
            // The account id selects the scenario; the path is otherwise the
            // one real path, so nothing here passes by hitting a stub route.
            let (status, body) = match req.url() {
                u if u.starts_with("/accounts/expired/") => (
                    401,
                    r#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}"#,
                ),
                u if u.starts_with("/accounts/scopeless/") => (
                    403,
                    r#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}"#,
                ),
                _ => (
                    500,
                    r#"{"success":false,"errors":[{"code":10013,"message":"workers.api.error.internal"}]}"#,
                ),
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        });
        let base = format!("http://127.0.0.1:{port}");
        let client_for = |account: &str| {
            CfClient::with_base("tok".into(), account.to_string(), base.clone())
        };

        for account in ["expired", "scopeless"] {
            match client_for(account).put_secret("my-brain", "AUTH_TOKEN", "pw").await {
                Err(CfApiError::Unauthorized) => {}
                other => panic!("{account} must route to the re-authorise screen: {other:?}"),
            }
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "a refusal is not transient — retrying it only delays the truth"
        );

        match client_for("outage").put_secret("my-brain", "AUTH_TOKEN", "pw").await {
            Err(CfApiError::Api { code, message }) => {
                assert_eq!(code, 10013);
                assert!(message.contains("internal"), "lost the message: {message}");
            }
            other => panic!("a server error must not read as an auth problem: {other:?}"),
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2 + MAX_ATTEMPTS,
            "a 5xx is transient and must be retried before it is believed"
        );
    }

    /// The probe a rotation is gated on, asserted next to the one it must *not*
    /// be gated on.
    ///
    /// A brain whose vector index is degraded answers 200 with
    /// `vectorize.ok: false`. `worker_health_ok` calls that unhealthy, which is
    /// right for a deploy. If a rotation asked the same question the poll could
    /// never go green: the secret would be written, the confirmation would fail
    /// on every one of its twelve attempts, nothing local would be written, and
    /// the user would be locked out of their own brain by an index problem that
    /// has nothing to do with their password — with "Try again" landing on the
    /// same screen forever.
    ///
    /// The last case is what keeps the probe from being vacuous: a connection
    /// that never reached a server is not a pass. "Any non-401 answer" means an
    /// answer.
    #[tokio::test]
    async fn the_auth_probe_passes_everything_that_is_not_a_refusal() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || loop {
            let Ok(req) = server.recv() else { return };
            let (status, body) = match req.url() {
                // Live, authenticating, vector index broken.
                u if u.starts_with("/degraded") => (
                    200,
                    r#"{"ok":false,"version":"2.2.0","vectorize":{"ok":false,"error":"index not found"}}"#,
                ),
                // Authenticated, then fell over inside the route.
                u if u.starts_with("/broken") => (500, r#"{"ok":false,"error":"boom"}"#),
                // Something that is not the health contract at all.
                u if u.starts_with("/html") => (200, "<html>gateway</html>"),
                _ => (401, r#"{"ok":false,"error":"Unauthorized"}"#),
            };
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        });
        let base = format!("http://127.0.0.1:{port}");

        assert!(
            matches!(worker_auth_ok(&format!("{base}/degraded"), "pw").await, Ok(true)),
            "a degraded index is not a wrong password"
        );
        // …and the difference from the full check is the point of having two.
        assert!(
            matches!(worker_health_ok(&format!("{base}/degraded"), "pw").await, Ok(false)),
            "worker_health_ok must keep failing a degraded index — provision and \
             update_worker are gated on it"
        );
        for path in ["/broken", "/html"] {
            assert!(
                matches!(worker_auth_ok(&format!("{base}{path}"), "pw").await, Ok(true)),
                "{path}: the token was accepted, whatever happened next"
            );
        }
        assert!(
            matches!(
                worker_auth_ok(&format!("{base}/refused"), "pw").await,
                Err(CfApiError::WorkerAuthRejected)
            ),
            "only a 401 means the new secret has not landed yet — and the refusal \
             is the brain's own, never dressed up as a Cloudflare sign-in problem"
        );
        assert!(
            worker_auth_ok("http://127.0.0.1:1/nothing", "pw").await.is_err(),
            "nothing answered, so nothing accepted the password"
        );
    }

    /// The control arm: the same `/health` with no credentials, answering one
    /// question — would this address refuse anyone? This is what separates
    /// "the live brain rejected its password" from "a stale edge node still
    /// serving the previous deployment answered the poll".
    #[tokio::test]
    async fn the_unauthenticated_control_probe_classifies_the_same_two_ways() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            loop {
                let Ok(req) = server.recv() else { return };
                let status = if req.url().starts_with("/demanding") { 401 } else { 200 };
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"ok":true}"#).with_status_code(status),
                );
            }
        });
        let base = format!("http://127.0.0.1:{port}");

        assert!(
            matches!(worker_requires_auth(&format!("{base}/demanding")).await, Ok(true)),
            "a 401 with no credentials is a brain demanding auth"
        );
        assert!(
            matches!(worker_requires_auth(&format!("{base}/permissive")).await, Ok(false)),
            "any other answer means this version would not have refused the poll"
        );
        assert!(
            worker_requires_auth("http://127.0.0.1:1/nothing").await.is_err(),
            "nothing listening is an error, not an answer"
        );
    }
}
