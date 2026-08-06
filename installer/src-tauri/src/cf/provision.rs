//! The idempotent provisioning pipeline behind the "Setting up" screen.
//!
//! Given an authenticated backend + the user's chosen password, this creates
//! (or finds — every step checks before creating, so re-runs never duplicate)
//! the database, key-value namespace, vector index, uploads the dashboard
//! assets and Worker, wires the schedule and web address, and smoke-tests the
//! result. Progress is reported through a callback as coarse, user-friendly
//! steps; raw error detail stays internal.

use super::types::CfApiError;
use crate::worker_bundle::WorkerManifest;
use serde::Serialize;
use std::time::Duration;

pub const KV_TITLE: &str = "second-brain-oauth";
const HEALTH_ATTEMPTS: u32 = 12;
const HEALTH_WAIT: Duration = Duration::from_secs(8);
const SUBDOMAIN_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    /// Account + workers.dev address — "Creating your private space"
    Space,
    /// D1 + KV — "Building your memory store"
    Memory,
    /// Vectorize — "Turning on smart recall"
    Recall,
    /// Assets + Worker + schedule + smoke tests — "Finishing up"
    Finish,
    // The three below belong to a password change (#235) and to nothing else.
    // A rotation is not a shortened setup: it writes one secret and then waits,
    // and the wait is the part the user is being asked to sit through — up to
    // `HEALTH_ATTEMPTS × HEALTH_WAIT`, on a screen that says "Leave this window
    // open". Reusing `Finish` for all of it was tried and is wrong twice over:
    // the rotation screen's checklist is keyed by these ids, so every row would
    // stay a static bullet for the whole run, and "Finishing up" describes the
    // last stage of a deploy rather than the two distinct things that can fail
    // here — the write going out, and the brain accepting what was written.
    /// The secret PUT — "Sending the change to your Second Brain"
    Secret,
    /// Polling `/health` with the new password — "Waiting for it to take effect"
    Confirm,
    /// The local stores — "Updating this computer".
    ///
    /// Emitted by `commands::rotate_password` around `rotate::persist`, never
    /// from here: nothing local may be written until [`rotate_secret`] has
    /// returned, so the step does not exist inside it.
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepEvent {
    pub step: Step,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionOutcome {
    pub worker_url: String,
    pub mcp_url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    #[error(transparent)]
    Api(#[from] CfApiError),
    #[error("the new Second Brain deployed but isn't answering its health check yet")]
    HealthCheckFailed,
    #[error("the end-to-end write test failed")]
    CaptureFailed,
    #[error("could not reserve a web address for this space")]
    SubdomainUnavailable,
    /// The stored address is not a workers.dev address, so there is no script
    /// name to deploy to. Distinct from a generic failure because retrying
    /// cannot help.
    #[error("this Second Brain is on its own web address, so the app can't update it")]
    NotAWorkersDevAddress,
}

/// Everything the pipeline needs from the outside world, so tests can drive
/// it with a fake and the UI can run a dry-run backend.
#[allow(async_fn_in_trait)]
pub trait Backend {
    async fn get_account_subdomain(&self) -> Result<Option<String>, CfApiError>;
    async fn register_account_subdomain(&self, name: &str) -> Result<String, CfApiError>;
    async fn find_d1(&self, name: &str) -> Result<Option<String>, CfApiError>;
    async fn create_d1(&self, name: &str) -> Result<String, CfApiError>;
    async fn find_kv(&self, title: &str) -> Result<Option<String>, CfApiError>;
    async fn create_kv(&self, title: &str) -> Result<String, CfApiError>;
    async fn vectorize_exists(&self, name: &str) -> Result<bool, CfApiError>;
    /// Deletes an index and everything in it. Irreversible, so callers must have
    /// confirmed with the user first — see the embedding migration, which only
    /// reaches this after a rebuild has been verified.
    async fn delete_vectorize(&self, name: &str) -> Result<(), CfApiError>;
    async fn create_vectorize(
        &self,
        name: &str,
        dimensions: u32,
        metric: &str,
    ) -> Result<(), CfApiError>;
    /// Uploads the embedded dashboard assets; returns the completion JWT.
    async fn upload_assets(&self, script: &str) -> Result<String, CfApiError>;
    /// Uploads the embedded Worker module with the given multipart metadata.
    async fn deploy_worker(
        &self,
        script: &str,
        metadata: &serde_json::Value,
    ) -> Result<(), CfApiError>;
    async fn set_cron(&self, script: &str, crons: &[String]) -> Result<(), CfApiError>;
    async fn enable_script_subdomain(&self, script: &str) -> Result<(), CfApiError>;
    /// Writes one secret on a deployed script without redeploying it. Takes
    /// effect at the edge a little after it returns — see [`rotate_secret`],
    /// which is the only caller that may treat it as done.
    async fn put_secret(&self, script: &str, name: &str, text: &str) -> Result<(), CfApiError>;
    /// The full health contract: live *and* its vector index wired. What a
    /// deploy has to wait for.
    async fn health_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError>;
    /// Does this password open this brain — and nothing else. What a *rotation*
    /// has to wait for; see [`super::api::worker_auth_ok`] for why the two must
    /// not be merged, and [`rotate_secret`] for what merging them costs.
    async fn auth_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError>;
    async fn capture_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError>;
    /// The deployed script's current bindings (for a preserve-everything update).
    async fn get_script_bindings(&self, script: &str)
        -> Result<Vec<serde_json::Value>, CfApiError>;
    async fn sleep(&self, duration: Duration);
}

/// workers.dev subdomains are DNS labels: lowercase alphanumerics + dashes,
/// no leading/trailing dash, ≤ 63 chars (we stay well under).
pub fn slugify_subdomain(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true; // suppress leading dash
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "second-brain".to_string()
    } else {
        slug
    }
}

/// The multipart `metadata` part for the Worker upload — bindings must match
/// the names the Worker reads (see wrangler.jsonc / worker_bundle manifest).
pub fn build_worker_metadata(
    manifest: &WorkerManifest,
    d1_id: &str,
    kv_id: &str,
    auth_token: &str,
    assets_jwt: &str,
) -> serde_json::Value {
    let mut bindings = vec![
        serde_json::json!({ "type": "d1", "name": manifest.d1_binding, "database_id": d1_id }),
        serde_json::json!({ "type": "vectorize", "name": manifest.vectorize_binding, "index_name": manifest.vectorize_name }),
        serde_json::json!({ "type": "kv_namespace", "name": manifest.kv_binding, "namespace_id": kv_id }),
        serde_json::json!({ "type": "ai", "name": manifest.ai_binding }),
        serde_json::json!({ "type": "secret_text", "name": "AUTH_TOKEN", "text": auth_token }),
    ];
    for (name, value) in &manifest.vars {
        bindings.push(serde_json::json!({ "type": "plain_text", "name": name, "text": value }));
    }
    serde_json::json!({
        "main_module": "worker.js",
        "compatibility_date": manifest.compatibility_date,
        "compatibility_flags": manifest.compatibility_flags,
        "bindings": bindings,
        "assets": {
            "jwt": assets_jwt,
            "config": {
                "html_handling": "auto-trailing-slash",
                "not_found_handling": "none",
                "run_worker_first": false
            }
        },
        "observability": { "enabled": true }
    })
}

/// Pulls a binding's id/name field out of a deployed script's bindings array
/// (as returned by the settings endpoint), matched by binding type + field.
pub fn binding_field<'a>(
    bindings: &'a [serde_json::Value],
    binding_type: &str,
    field: &str,
) -> Option<&'a str> {
    bindings
        .iter()
        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some(binding_type))
        .and_then(|b| b.get(field))
        .and_then(|v| v.as_str())
}

/// Update metadata: same bindings as a fresh deploy, but the `AUTH_TOKEN`
/// secret is *preserved* from the previous deployment via `keep_bindings`
/// rather than re-sent (the app never knows the password on an update).
/// Which Vectorize index a deploy should bind, and the shape to create it with
/// if it is missing.
///
/// Carried as a pair because the two must agree: an index's dimensions are fixed
/// at creation and cannot be altered, so a name paired with the wrong size
/// produces an index that rejects every vector written to it. A normal update
/// passes the manifest's values; an embedding migration (#248) passes the new
/// index it is moving to.
#[derive(Debug, Clone, Copy)]
pub struct VectorizeTarget<'a> {
    pub name: &'a str,
    pub dimensions: u32,
}

impl<'a> VectorizeTarget<'a> {
    /// What this build of the app ships with — the right target for every deploy
    /// that is not a migration.
    pub fn shipped(manifest: &'a WorkerManifest) -> Self {
        Self {
            name: &manifest.vectorize_name,
            dimensions: manifest.vectorize_dimensions,
        }
    }
}

pub fn build_update_metadata(
    manifest: &WorkerManifest,
    d1_id: &str,
    kv_id: &str,
    assets_jwt: &str,
    vectorize_index: &str,
) -> serde_json::Value {
    let mut bindings = vec![
        serde_json::json!({ "type": "d1", "name": manifest.d1_binding, "database_id": d1_id }),
        serde_json::json!({ "type": "vectorize", "name": manifest.vectorize_binding, "index_name": vectorize_index }),
        serde_json::json!({ "type": "kv_namespace", "name": manifest.kv_binding, "namespace_id": kv_id }),
        serde_json::json!({ "type": "ai", "name": manifest.ai_binding }),
    ];
    for (name, value) in &manifest.vars {
        bindings.push(serde_json::json!({ "type": "plain_text", "name": name, "text": value }));
    }
    serde_json::json!({
        "main_module": "worker.js",
        "compatibility_date": manifest.compatibility_date,
        "compatibility_flags": manifest.compatibility_flags,
        "bindings": bindings,
        "keep_bindings": ["secret_text", "secret_key"],
        "assets": {
            "jwt": assets_jwt,
            "config": {
                "html_handling": "auto-trailing-slash",
                "not_found_handling": "none",
                "run_worker_first": false
            }
        },
        "observability": { "enabled": true }
    })
}

async fn ensure_account_subdomain<B: Backend>(
    backend: &B,
    account_name: &str,
) -> Result<String, ProvisionError> {
    if let Some(existing) = backend.get_account_subdomain().await? {
        return Ok(existing);
    }
    let base = slugify_subdomain(account_name);
    for attempt in 0..SUBDOMAIN_ATTEMPTS {
        let candidate = if attempt == 0 {
            base.clone()
        } else {
            let mut suffix = [0u8; 2];
            rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut suffix);
            format!("{base}-{:02}{:02}", suffix[0] % 100, suffix[1] % 100)
        };
        match backend.register_account_subdomain(&candidate).await {
            Ok(registered) => return Ok(registered),
            // Taken / rejected names come back as API errors — try another.
            Err(CfApiError::Api { .. }) | Err(CfApiError::Http { .. }) => continue,
            Err(other) => return Err(other.into()),
        }
    }
    Err(ProvisionError::SubdomainUnavailable)
}

pub async fn provision<B: Backend>(
    backend: &B,
    manifest: &WorkerManifest,
    account_name: &str,
    auth_token: &str,
    progress: impl Fn(StepEvent),
) -> Result<ProvisionOutcome, ProvisionError> {
    let emit = |step: Step, status: StepStatus| progress(StepEvent { step, status });
    let script = manifest.script_name.as_str();

    // Wraps a step body so failures mark the step as errored exactly once.
    macro_rules! step {
        ($step:expr, $body:expr) => {{
            emit($step, StepStatus::Running);
            match $body.await {
                Ok(value) => {
                    emit($step, StepStatus::Done);
                    value
                }
                Err(e) => {
                    emit($step, StepStatus::Error);
                    return Err(e);
                }
            }
        }};
    }

    // 1. Space — make sure the account has a workers.dev address.
    let subdomain = step!(Step::Space, ensure_account_subdomain(backend, account_name));

    // 2. Memory — database + key-value namespace (find-before-create).
    let (d1_id, kv_id) = step!(Step::Memory, async {
        let d1_id = match backend.find_d1(&manifest.d1_name).await? {
            Some(id) => id,
            None => backend.create_d1(&manifest.d1_name).await?,
        };
        let kv_id = match backend.find_kv(KV_TITLE).await? {
            Some(id) => id,
            None => backend.create_kv(KV_TITLE).await?,
        };
        Ok::<_, ProvisionError>((d1_id, kv_id))
    });

    // 3. Recall — vector index.
    step!(Step::Recall, async {
        if !backend.vectorize_exists(&manifest.vectorize_name).await? {
            backend
                .create_vectorize(
                    &manifest.vectorize_name,
                    manifest.vectorize_dimensions,
                    &manifest.vectorize_metric,
                )
                .await?;
        }
        Ok::<_, ProvisionError>(())
    });

    // 4. Finish — assets, Worker, schedule, address, smoke tests.
    let worker_url = format!("https://{script}.{subdomain}.workers.dev");
    step!(Step::Finish, async {
        let assets_jwt = backend.upload_assets(script).await?;
        let metadata = build_worker_metadata(manifest, &d1_id, &kv_id, auth_token, &assets_jwt);
        backend.deploy_worker(script, &metadata).await?;
        backend.set_cron(script, &manifest.cron).await?;
        backend.enable_script_subdomain(script).await?;

        // Fresh workers.dev hostnames can take a little while to resolve.
        let mut healthy = false;
        for attempt in 0..HEALTH_ATTEMPTS {
            match backend.health_ok(&worker_url, auth_token).await {
                Ok(true) => {
                    healthy = true;
                    break;
                }
                Ok(false) => {}
                Err(CfApiError::Unauthorized) => return Err(ProvisionError::HealthCheckFailed),
                Err(_) => {} // network/DNS not ready yet — keep waiting
            }
            if attempt + 1 < HEALTH_ATTEMPTS {
                backend.sleep(HEALTH_WAIT).await;
            }
        }
        if !healthy {
            return Err(ProvisionError::HealthCheckFailed);
        }
        // One real write, once, per Appendix A — duplicates on re-run pass.
        if !backend.capture_ok(&worker_url, auth_token).await? {
            return Err(ProvisionError::CaptureFailed);
        }
        Ok::<_, ProvisionError>(())
    });

    Ok(ProvisionOutcome {
        mcp_url: format!("{worker_url}/mcp"),
        worker_url,
    })
}

/// Redeploys the bundled (newer) Worker over an existing one, preserving the
/// user's data, password, and connections. Reuses the deployed script's real
/// binding IDs; the password rides along via `keep_bindings`. Idempotent and
/// safe to retry. Reports progress through the Memory/Recall/Finish steps
/// (Space is skipped — the account already has its address).
pub async fn update_worker<B: Backend>(
    backend: &B,
    manifest: &WorkerManifest,
    worker_url: &str,
    auth_token: &str,
    vectorize: VectorizeTarget<'_>,
    progress: impl Fn(StepEvent),
) -> Result<(), ProvisionError> {
    let emit = |step: Step, status: StepStatus| progress(StepEvent { step, status });

    // The script to deploy to comes from the address being updated, NOT from the
    // bundled manifest.
    //
    // #257: deploys are a PUT, so taking the name from the manifest meant a brain
    // connected as `my-brain.acme.workers.dev` was "updated" by writing the
    // bundle to a script called `second-brain` in that account — creating a
    // Worker the user never asked for, or silently overwriting an unrelated one
    // that happened to hold the name. Every call below (`upload_assets`,
    // `deploy_worker`, `set_cron`, `enable_script_subdomain`) targets this one
    // value, so deriving it here fixes all of them at once.
    let script = crate::worker_url::script_of(worker_url)
        .ok_or(ProvisionError::NotAWorkersDevAddress)?;
    let script = script.as_str();

    macro_rules! step {
        ($step:expr, $body:expr) => {{
            emit($step, StepStatus::Running);
            match $body.await {
                Ok(value) => {
                    emit($step, StepStatus::Done);
                    value
                }
                Err(e) => {
                    emit($step, StepStatus::Error);
                    return Err(e);
                }
            }
        }};
    }

    // Memory — reuse the database + key-value namespace already bound to the
    // deployed script; fall back to find-or-create only if a binding is absent.
    let (d1_id, kv_id) = step!(Step::Memory, async {
        let bindings = backend.get_script_bindings(script).await?;
        let d1_id = match binding_field(&bindings, "d1", "database_id") {
            Some(id) => id.to_string(),
            None => match backend.find_d1(&manifest.d1_name).await? {
                Some(id) => id,
                None => backend.create_d1(&manifest.d1_name).await?,
            },
        };
        let kv_id = match binding_field(&bindings, "kv_namespace", "namespace_id") {
            Some(id) => id.to_string(),
            None => match backend.find_kv(KV_TITLE).await? {
                Some(id) => id,
                None => backend.create_kv(KV_TITLE).await?,
            },
        };
        Ok::<_, ProvisionError>((d1_id, kv_id))
    });

    // Recall — make sure the index this deploy is about to bind exists.
    //
    // Deliberately the *target*, not the manifest's index. A migration (#248)
    // redeploys against a differently sized index, and checking the manifest here
    // would recreate the index being abandoned while never creating the one the
    // binding points at.
    step!(Step::Recall, async {
        if !backend.vectorize_exists(vectorize.name).await? {
            backend
                .create_vectorize(
                    vectorize.name,
                    vectorize.dimensions,
                    &manifest.vectorize_metric,
                )
                .await?;
        }
        Ok::<_, ProvisionError>(())
    });

    // Finish — upload the newer assets + Worker (password preserved), then verify.
    step!(Step::Finish, async {
        let assets_jwt = backend.upload_assets(script).await?;
        let metadata = build_update_metadata(manifest, &d1_id, &kv_id, &assets_jwt, vectorize.name);
        backend.deploy_worker(script, &metadata).await?;
        backend.set_cron(script, &manifest.cron).await?;
        backend.enable_script_subdomain(script).await?;

        let mut healthy = false;
        for attempt in 0..HEALTH_ATTEMPTS {
            match backend.health_ok(worker_url, auth_token).await {
                Ok(true) => {
                    healthy = true;
                    break;
                }
                // A wrong token here means the secret was NOT preserved — fail
                // rather than silently locking the user out.
                Err(CfApiError::Unauthorized) => return Err(ProvisionError::HealthCheckFailed),
                Ok(false) | Err(_) => {}
            }
            if attempt + 1 < HEALTH_ATTEMPTS {
                backend.sleep(HEALTH_WAIT).await;
            }
        }
        if !healthy {
            return Err(ProvisionError::HealthCheckFailed);
        }
        Ok::<_, ProvisionError>(())
    });

    Ok(())
}

/// Replaces the brain's password and waits for it to take effect.
///
/// Returns only once the Worker authenticates the NEW token, so a caller may
/// treat success as "safe to persist locally".
///
/// The deployment is otherwise untouched: no assets are re-uploaded, no bindings
/// are rewritten, and no code is redeployed. Progress is reported as
/// [`Step::Secret`] then [`Step::Confirm`] — the two things that can fail, and
/// the two rows the rotation screen draws.
///
/// A failure here is *not* proof that the password is unchanged. The write and
/// the confirmation are two separate operations, and only the second one can
/// time out, so a caller must present the failure as "your new password may
/// already be live" rather than "nothing happened".
#[allow(dead_code)] // called by the #235 rotation flow landing alongside this
pub async fn rotate_secret<B: Backend>(
    backend: &B,
    worker_url: &str,
    new_token: &str,
    progress: impl Fn(StepEvent),
) -> Result<(), ProvisionError> {
    let emit = |step: Step, status: StepStatus| progress(StepEvent { step, status });

    // #257, and it bites harder here than it did there. The script name comes
    // from the address the user is actually connected to, never from the bundled
    // manifest: a brain reached at `my-brain.acme.workers.dev` would otherwise
    // have its password "changed" by writing AUTH_TOKEN onto a script called
    // `second-brain` — leaving the real brain on the old password (the user is
    // then locked out of nothing, but believes they rotated) while handing an
    // unrelated Worker a secret it never asked for.
    //
    // Derived before anything is emitted or written, so a brain on a custom
    // domain is refused without a half-started progress screen.
    let script =
        crate::worker_url::script_of(worker_url).ok_or(ProvisionError::NotAWorkersDevAddress)?;

    emit(Step::Secret, StepStatus::Running);
    if let Err(e) = backend.put_secret(&script, "AUTH_TOKEN", new_token).await {
        emit(Step::Secret, StepStatus::Error);
        return Err(e.into());
    }
    emit(Step::Secret, StepStatus::Done);

    // The write is asynchronous at the edge, so the point of this loop is to wait
    // out the propagation with the *new* token. The secret is PUT once, above:
    // re-sending it on every attempt would be a second write racing the first,
    // and would tell us nothing new.
    emit(Step::Confirm, StepStatus::Running);
    for attempt in 0..HEALTH_ATTEMPTS {
        // `auth_ok`, not `health_ok`, and the difference is the difference
        // between a recoverable rotation and an unrecoverable one.
        //
        // The full health check requires `ok && vectorize.ok`. A brain whose
        // vector index is degraded fails it on every attempt forever — so a
        // rotation gated on it writes the secret, never confirms, never persists,
        // and leaves the keychain on the old password while the brain is on the
        // new one. "Try again" then repeats that exact sequence for as long as
        // the index stays broken. All this gate has to establish is that the new
        // password opens the brain; the dashboard is where a degraded index gets
        // reported, and it is not this flow's business.
        match backend.auth_ok(worker_url, new_token).await {
            Ok(true) => {
                emit(Step::Confirm, StepStatus::Done);
                return Ok(());
            }
            // Read this next to `update_worker`'s health poll before changing
            // it: the two treat a 401 in opposite ways, on purpose.
            //
            // There, the poll uses the token the app already had, so a 401
            // means the redeploy dropped the secret — retrying would only
            // delay telling the user they are locked out, and it is terminal.
            //
            // Here the poll uses the token that was just written, so a 401
            // means the edge is still serving the *old* secret and the change
            // has not landed yet. It is the expected answer for the first few
            // seconds of every rotation. Making it terminal turns any deploy
            // slower than one probe into a reported failure — of a rotation
            // that then succeeds seconds later, leaving the user with a
            // password the app told them was not applied.
            Err(CfApiError::Unauthorized) => {}
            // Nothing answered yet — DNS/network still catching up.
            Ok(false) | Err(_) => {}
        }
        if attempt + 1 < HEALTH_ATTEMPTS {
            backend.sleep(HEALTH_WAIT).await;
        }
    }
    // Every attempt used up. The password may still be in force — see the note on
    // this function.
    emit(Step::Confirm, StepStatus::Error);
    Err(ProvisionError::HealthCheckFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn test_manifest() -> WorkerManifest {
        serde_json::from_value(serde_json::json!({
            "scriptName": "second-brain",
            "workerVersion": "2.0.0",
            "compatibilityDate": "2026-06-17",
            "compatibilityFlags": ["nodejs_compat"],
            "vars": { "VECTORIZE_GRACE_MS": "300000" },
            // Both schedules: nightly maintenance and the hourly integration sync,
            // which runs on its own budget (#290). The app has to register every
            // entry, not just the first.
            "cron": ["0 1 * * *", "30 * * * *"],
            "d1Binding": "DB",
            "d1Name": "second-brain-db",
            "vectorizeBinding": "VECTORIZE",
            "vectorizeName": "second-brain-vectors",
            "vectorizeDimensions": 384,
            "vectorizeMetric": "cosine",
            "kvBinding": "OAUTH_KV",
            "aiBinding": "AI"
        }))
        .unwrap()
    }

    #[derive(Default)]
    struct Fake {
        log: Mutex<Vec<String>>,
        existing_subdomain: Option<String>,
        existing_d1: Option<String>,
        existing_kv: Option<String>,
        existing_vectorize: bool,
        subdomain_rejections: Mutex<u32>,
        health_failures: Mutex<u32>,
        /// Probes to answer with a 401 before anything else, standing in for a
        /// secret that has not propagated to the edge yet.
        health_unauthorized: Mutex<u32>,
        /// Every probe of either kind, answered or not — a count the log cannot
        /// give, since the log only records the ones that pass.
        probe_calls: Mutex<u32>,
        /// A brain that is up and authenticating with a broken vector index:
        /// `health_ok` answers no for as long as it lasts, `auth_ok` still says
        /// the password is good. This is the state that made a rotation gated on
        /// full health permanently unrecoverable.
        degraded_vector_index: bool,
        script_bindings: Vec<serde_json::Value>,
        last_deploy_metadata: Mutex<Option<serde_json::Value>>,
    }

    impl Fake {
        fn log(&self, entry: impl Into<String>) {
            self.log.lock().unwrap().push(entry.into());
        }
        fn entries(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
        /// The half both probes share: the scripted refusals, spent in order, and
        /// the call count. `None` means nothing was scripted and the probe is
        /// free to answer for itself.
        fn scripted_probe(&self) -> Option<Result<bool, CfApiError>> {
            *self.probe_calls.lock().unwrap() += 1;
            let mut unauthorized = self.health_unauthorized.lock().unwrap();
            if *unauthorized > 0 {
                *unauthorized -= 1;
                return Some(Err(CfApiError::Unauthorized));
            }
            let mut failures = self.health_failures.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Some(Ok(false));
            }
            None
        }
    }

    impl Backend for &Fake {
        async fn get_account_subdomain(&self) -> Result<Option<String>, CfApiError> {
            self.log("get_subdomain");
            Ok(self.existing_subdomain.clone())
        }
        async fn register_account_subdomain(&self, name: &str) -> Result<String, CfApiError> {
            let mut rejections = self.subdomain_rejections.lock().unwrap();
            if *rejections > 0 {
                *rejections -= 1;
                self.log(format!("register_subdomain_rejected:{name}"));
                return Err(CfApiError::Api {
                    code: 10000,
                    message: "taken".into(),
                });
            }
            self.log(format!("register_subdomain:{name}"));
            Ok(name.to_string())
        }
        async fn find_d1(&self, _name: &str) -> Result<Option<String>, CfApiError> {
            Ok(self.existing_d1.clone())
        }
        async fn create_d1(&self, name: &str) -> Result<String, CfApiError> {
            self.log(format!("create_d1:{name}"));
            Ok("d1-uuid-new".into())
        }
        async fn find_kv(&self, _title: &str) -> Result<Option<String>, CfApiError> {
            Ok(self.existing_kv.clone())
        }
        async fn create_kv(&self, title: &str) -> Result<String, CfApiError> {
            self.log(format!("create_kv:{title}"));
            Ok("kv-id-new".into())
        }
        async fn vectorize_exists(&self, _name: &str) -> Result<bool, CfApiError> {
            Ok(self.existing_vectorize)
        }
        async fn delete_vectorize(&self, name: &str) -> Result<(), CfApiError> {
            self.log(format!("delete_vectorize:{name}"));
            Ok(())
        }
        async fn create_vectorize(
            &self,
            name: &str,
            dimensions: u32,
            metric: &str,
        ) -> Result<(), CfApiError> {
            self.log(format!("create_vectorize:{name}:{dimensions}:{metric}"));
            Ok(())
        }
        async fn upload_assets(&self, script: &str) -> Result<String, CfApiError> {
            self.log(format!("upload_assets:{script}"));
            Ok("jwt-completion".into())
        }
        async fn deploy_worker(
            &self,
            script: &str,
            metadata: &serde_json::Value,
        ) -> Result<(), CfApiError> {
            self.log(format!(
                "deploy:{script}:{}",
                metadata["bindings"].as_array().unwrap().len()
            ));
            *self.last_deploy_metadata.lock().unwrap() = Some(metadata.clone());
            Ok(())
        }
        async fn get_script_bindings(
            &self,
            script: &str,
        ) -> Result<Vec<serde_json::Value>, CfApiError> {
            self.log(format!("get_script_bindings:{script}"));
            Ok(self.script_bindings.clone())
        }
        async fn set_cron(&self, _script: &str, crons: &[String]) -> Result<(), CfApiError> {
            self.log(format!("set_cron:{}", crons.join(",")));
            Ok(())
        }
        async fn enable_script_subdomain(&self, script: &str) -> Result<(), CfApiError> {
            self.log(format!("enable_subdomain:{script}"));
            Ok(())
        }
        async fn health_ok(&self, _url: &str, _token: &str) -> Result<bool, CfApiError> {
            if let Some(scripted) = self.scripted_probe() {
                return scripted;
            }
            if self.degraded_vector_index {
                // `ok && vectorize.ok` is what the real check requires, and this
                // half of it never recovers on its own.
                return Ok(false);
            }
            self.log("health_ok");
            Ok(true)
        }
        async fn auth_ok(&self, _url: &str, _token: &str) -> Result<bool, CfApiError> {
            if let Some(scripted) = self.scripted_probe() {
                return scripted;
            }
            // Deliberately blind to `degraded_vector_index`: the only question
            // this probe answers is whether the password was accepted.
            self.log("auth_ok");
            Ok(true)
        }
        async fn put_secret(
            &self,
            script: &str,
            name: &str,
            text: &str,
        ) -> Result<(), CfApiError> {
            self.log(format!("put_secret:{script}:{name}:{text}"));
            Ok(())
        }
        async fn capture_ok(&self, _url: &str, _token: &str) -> Result<bool, CfApiError> {
            self.log("capture_ok");
            Ok(true)
        }
        async fn sleep(&self, _duration: Duration) {}
    }

    #[tokio::test]
    async fn fresh_account_provisions_everything() {
        let fake = Fake::default();
        let outcome = provision(&&fake, &test_manifest(), "My Account", "pw-123456789012", |_| {})
            .await
            .unwrap();
        assert_eq!(
            outcome.worker_url,
            "https://second-brain.my-account.workers.dev"
        );
        assert_eq!(outcome.mcp_url, format!("{}/mcp", outcome.worker_url));
        let log = fake.entries();
        assert!(log.contains(&"register_subdomain:my-account".to_string()));
        assert!(log.contains(&"create_d1:second-brain-db".to_string()));
        assert!(log.contains(&"create_kv:second-brain-oauth".to_string()));
        assert!(log.contains(&"create_vectorize:second-brain-vectors:384:cosine".to_string()));
        // 5 fixed bindings + 1 var
        assert!(log.contains(&"deploy:second-brain:6".to_string()));
        assert!(log.contains(&"set_cron:0 1 * * *,30 * * * *".to_string()));
        assert!(log.contains(&"health_ok".to_string()));
        assert!(log.contains(&"capture_ok".to_string()));
    }

    #[tokio::test]
    async fn rerun_reuses_existing_resources() {
        let fake = Fake {
            existing_subdomain: Some("already-there".into()),
            existing_d1: Some("d1-existing".into()),
            existing_kv: Some("kv-existing".into()),
            existing_vectorize: true,
            ..Default::default()
        };
        let outcome = provision(&&fake, &test_manifest(), "ignored", "pw-123456789012", |_| {})
            .await
            .unwrap();
        assert_eq!(
            outcome.worker_url,
            "https://second-brain.already-there.workers.dev"
        );
        let log = fake.entries();
        assert!(!log.iter().any(|l| l.starts_with("create_")));
        assert!(!log.iter().any(|l| l.starts_with("register_subdomain")));
        // Deploy still runs (that's the idempotent redeploy path).
        assert!(log.iter().any(|l| l.starts_with("deploy:")));
    }

    #[tokio::test]
    async fn taken_subdomain_retries_with_suffix() {
        let fake = Fake {
            subdomain_rejections: Mutex::new(1),
            ..Default::default()
        };
        provision(&&fake, &test_manifest(), "Taken Name", "pw-123456789012", |_| {})
            .await
            .unwrap();
        let log = fake.entries();
        assert!(log.contains(&"register_subdomain_rejected:taken-name".to_string()));
        assert!(log
            .iter()
            .any(|l| l.starts_with("register_subdomain:taken-name-")));
    }

    #[tokio::test]
    async fn health_check_retries_until_live() {
        let fake = Fake {
            health_failures: Mutex::new(3),
            ..Default::default()
        };
        provision(&&fake, &test_manifest(), "acct", "pw-123456789012", |_| {})
            .await
            .unwrap();
        assert!(fake.entries().contains(&"capture_ok".to_string()));
    }

    #[tokio::test]
    async fn progress_events_cover_all_steps() {
        let fake = Fake::default();
        let events = Mutex::new(Vec::new());
        provision(&&fake, &test_manifest(), "acct", "pw-123456789012", |e| {
            events.lock().unwrap().push((e.step, e.status));
        })
        .await
        .unwrap();
        let events = events.into_inner().unwrap();
        for step in [Step::Space, Step::Memory, Step::Recall, Step::Finish] {
            assert!(events.contains(&(step, StepStatus::Running)));
            assert!(events.contains(&(step, StepStatus::Done)));
        }
    }

    #[test]
    fn metadata_has_exact_binding_shape() {
        let m = test_manifest();
        let meta = build_worker_metadata(&m, "d1-uuid", "kv-id", "secret-pw", "jwt-1");
        assert_eq!(meta["main_module"], "worker.js");
        assert_eq!(meta["compatibility_date"], "2026-06-17");
        let bindings = meta["bindings"].as_array().unwrap();
        let find = |ty: &str| bindings.iter().find(|b| b["type"] == ty).unwrap();
        assert_eq!(find("d1")["name"], "DB");
        assert_eq!(find("d1")["database_id"], "d1-uuid");
        assert_eq!(find("vectorize")["index_name"], "second-brain-vectors");
        assert_eq!(find("kv_namespace")["namespace_id"], "kv-id");
        assert_eq!(find("ai")["name"], "AI");
        assert_eq!(find("secret_text")["text"], "secret-pw");
        assert_eq!(find("plain_text")["name"], "VECTORIZE_GRACE_MS");
        assert_eq!(meta["assets"]["jwt"], "jwt-1");
    }

    #[tokio::test]
    async fn update_reuses_deployed_bindings_and_preserves_secret() {
        let fake = Fake {
            script_bindings: vec![
                serde_json::json!({ "type": "d1", "name": "DB", "database_id": "real-d1-id" }),
                serde_json::json!({ "type": "kv_namespace", "name": "OAUTH_KV", "namespace_id": "real-kv-id" }),
                serde_json::json!({ "type": "vectorize", "name": "VECTORIZE", "index_name": "second-brain-vectors" }),
                serde_json::json!({ "type": "secret_text", "name": "AUTH_TOKEN" }),
            ],
            existing_vectorize: true,
            ..Default::default()
        };
        update_worker(
            &&fake,
            &test_manifest(),
            "https://second-brain.acme.workers.dev",
            "stored-token",
            VectorizeTarget::shipped(&test_manifest()),
            |_| {},
        )
        .await
        .unwrap();

        let log = fake.entries();
        assert!(log.contains(&"get_script_bindings:second-brain".to_string()));
        // Never re-created the resources that already exist.
        assert!(!log.iter().any(|l| l.starts_with("create_")));

        let meta = fake.last_deploy_metadata.lock().unwrap().clone().unwrap();
        // Reused the real binding IDs from the deployed script.
        let bindings = meta["bindings"].as_array().unwrap();
        let find = |ty: &str| bindings.iter().find(|b| b["type"] == ty).unwrap();
        assert_eq!(find("d1")["database_id"], "real-d1-id");
        assert_eq!(find("kv_namespace")["namespace_id"], "real-kv-id");
        // Password preserved, not re-sent.
        assert!(!bindings.iter().any(|b| b["type"] == "secret_text"));
        assert_eq!(meta["keep_bindings"], serde_json::json!(["secret_text", "secret_key"]));
    }

    /// #257 — the update deploys to the script named by the address it was
    /// given, never to the one in the bundled manifest.
    ///
    /// Deploys are a `PUT`. Taking the name from the manifest meant a brain
    /// connected as `my-brain.acme.workers.dev` was "updated" by writing the
    /// bundle to a script called `second-brain` in that account: creating a
    /// Worker the user never asked for, or silently overwriting an unrelated one
    /// that happened to hold the name.
    #[tokio::test]
    async fn update_targets_the_script_named_by_the_address() {
        let fake = Fake {
            script_bindings: vec![
                serde_json::json!({ "type": "d1", "name": "DB", "database_id": "d1" }),
                serde_json::json!({ "type": "kv_namespace", "name": "OAUTH_KV", "namespace_id": "kv" }),
            ],
            existing_vectorize: true,
            ..Default::default()
        };
        update_worker(
            &&fake,
            &test_manifest(),
            "https://my-brain.acme.workers.dev",
            "tok",
            VectorizeTarget::shipped(&test_manifest()),
            |_| {},
        )
        .await
        .unwrap();

        let log = fake.entries();
        for expected in [
            "get_script_bindings:my-brain",
            "upload_assets:my-brain",
            "enable_subdomain:my-brain",
        ] {
            assert!(
                log.contains(&expected.to_string()),
                "expected {expected} in {log:?}"
            );
        }
        assert!(
            log.iter().any(|l| l.starts_with("deploy:my-brain:")),
            "the bundle must be deployed to my-brain: {log:?}"
        );

        // And the manifest's name was never touched. Checked per call rather than
        // as a substring search, because the Vectorize index is legitimately
        // named `second-brain-vectors`.
        for forbidden in [
            "get_script_bindings:second-brain",
            "upload_assets:second-brain",
            "enable_subdomain:second-brain",
            "deploy:second-brain",
        ] {
            assert!(
                !log.iter().any(|l| l.starts_with(forbidden)),
                "the update reached for the manifest name: {forbidden} in {log:?}"
            );
        }
    }

    /// #248 — a migration redeploy binds the index it is moving *to*, and creates
    /// that one if it is missing.
    ///
    /// The step used to check the manifest's index. On a migration that is exactly
    /// backwards: it would recreate the index being abandoned and never create the
    /// one the binding is about to point at, leaving the brain reading an index
    /// that does not exist.
    #[tokio::test]
    async fn a_migration_redeploy_binds_and_creates_the_target_index() {
        let fake = Fake {
            script_bindings: vec![
                serde_json::json!({ "type": "d1", "name": "DB", "database_id": "d1" }),
                serde_json::json!({ "type": "kv_namespace", "name": "OAUTH_KV", "namespace_id": "kv" }),
            ],
            // The target does not exist yet — this is the first move to it.
            existing_vectorize: false,
            ..Default::default()
        };
        update_worker(
            &&fake,
            &test_manifest(),
            "https://second-brain.acme.workers.dev",
            "tok",
            VectorizeTarget { name: "second-brain-vectors-768", dimensions: 768 },
            |_| {},
        )
        .await
        .unwrap();

        let log = fake.entries();
        assert!(
            log.contains(&"create_vectorize:second-brain-vectors-768:768:cosine".to_string()),
            "must create the target index at its own size: {log:?}"
        );
        assert!(
            !log.iter().any(|l| l.starts_with("create_vectorize:second-brain-vectors:")),
            "must not recreate the index being abandoned: {log:?}"
        );

        let meta = fake.last_deploy_metadata.lock().unwrap().clone().unwrap();
        let bindings = meta["bindings"].as_array().unwrap();
        let vectorize = bindings.iter().find(|b| b["type"] == "vectorize").unwrap();
        assert_eq!(vectorize["index_name"], "second-brain-vectors-768");

        // Updating an existing install has to re-register the whole schedule set.
        // A user who installed before the integration sync got its own trigger
        // only picks it up here, and only if every entry is sent.
        assert!(
            log.contains(&"set_cron:0 1 * * *,30 * * * *".to_string()),
            "update must set every schedule the manifest carries: {log:?}"
        );
    }

    /// A routine update must keep binding what the build ships with, or every
    /// update would quietly move users between indexes.
    #[tokio::test]
    async fn a_routine_update_binds_the_shipped_index() {
        let manifest = test_manifest();
        let fake = Fake { existing_vectorize: true, ..Default::default() };
        update_worker(
            &&fake,
            &manifest,
            "https://second-brain.acme.workers.dev",
            "tok",
            VectorizeTarget::shipped(&manifest),
            |_| {},
        )
        .await
        .unwrap();

        let meta = fake.last_deploy_metadata.lock().unwrap().clone().unwrap();
        let bindings = meta["bindings"].as_array().unwrap();
        let vectorize = bindings.iter().find(|b| b["type"] == "vectorize").unwrap();
        assert_eq!(vectorize["index_name"], "second-brain-vectors");
    }

    /// A brain on its own domain has no script name to derive, so the update
    /// refuses *before* touching the account rather than guessing one.
    #[tokio::test]
    async fn update_refuses_an_address_with_no_derivable_script() {
        let fake = Fake::default();
        let err = update_worker(
            &&fake,
            &test_manifest(),
            "https://brain.example.com",
            "tok",
            VectorizeTarget::shipped(&test_manifest()),
            |_| {},
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, ProvisionError::NotAWorkersDevAddress),
            "expected NotAWorkersDevAddress, got {err:?}"
        );
        assert!(
            fake.entries().is_empty(),
            "a refused update must not call Cloudflare at all: {:?}",
            fake.entries()
        );
    }

    #[tokio::test]
    async fn update_falls_back_when_bindings_absent() {
        // An older deployment whose settings don't expose the ids → find-or-create.
        let fake = Fake {
            script_bindings: vec![],
            existing_d1: Some("found-d1".into()),
            existing_kv: Some("found-kv".into()),
            existing_vectorize: true,
            ..Default::default()
        };
        update_worker(&&fake, &test_manifest(), "https://x.acme.workers.dev", "tok", VectorizeTarget::shipped(&test_manifest()),
            |_| {})
            .await
            .unwrap();
        let meta = fake.last_deploy_metadata.lock().unwrap().clone().unwrap();
        let bindings = meta["bindings"].as_array().unwrap();
        let find = |ty: &str| bindings.iter().find(|b| b["type"] == ty).unwrap();
        assert_eq!(find("d1")["database_id"], "found-d1");
        assert_eq!(find("kv_namespace")["namespace_id"], "found-kv");
    }

    /// Counts the secret writes in a fake's log — a rotation is one PUT, and
    /// several of the tests below are about how many times it happened.
    fn secret_writes(fake: &Fake) -> Vec<String> {
        fake.entries()
            .into_iter()
            .filter(|l| l.starts_with("put_secret:"))
            .collect()
    }

    #[tokio::test]
    async fn rotation_writes_the_password_and_confirms_it() {
        let fake = Fake::default();
        let events = Mutex::new(Vec::new());
        rotate_secret(
            &&fake,
            "https://second-brain.acme.workers.dev",
            "new-pw-123456789",
            |e| events.lock().unwrap().push((e.step, e.status)),
        )
        .await
        .unwrap();

        assert_eq!(
            secret_writes(&fake),
            vec!["put_secret:second-brain:AUTH_TOKEN:new-pw-123456789".to_string()]
        );
        // Confirmed against the Worker, not just written. Success is the caller's
        // signal that the new password is safe to store locally.
        assert!(fake.entries().contains(&"auth_ok".to_string()));

        // The two things that can fail, reported as two steps, in order. The
        // rotation screen draws a row per step id and moves it on each status, so
        // this sequence is the screen: collapsing it back to one event leaves the
        // user watching static bullets for up to
        // `HEALTH_ATTEMPTS × HEALTH_WAIT`.
        let events = events.into_inner().unwrap();
        assert_eq!(
            events,
            vec![
                (Step::Secret, StepStatus::Running),
                (Step::Secret, StepStatus::Done),
                (Step::Confirm, StepStatus::Running),
                (Step::Confirm, StepStatus::Done),
            ]
        );
    }

    /// What actually crosses the IPC boundary. `installer/src/main.ts` keys the
    /// rotation checklist by these exact strings, and until now nothing asserted
    /// any of them — which is how a rotation shipped emitting `"finish"` at a
    /// screen listening for `"secret"`, `"confirm"` and `"local"`, leaving every
    /// row a static bullet for the whole run under copy reading "Leave this
    /// window open".
    ///
    /// Renaming a variant or dropping the `rename_all` is a silent break: Rust
    /// stays happy, the front end still compiles, and the only symptom is a
    /// progress screen that never moves.
    #[test]
    fn the_step_ids_on_the_wire_are_the_ones_the_screens_key_on() {
        assert_eq!(
            serde_json::to_value(StepEvent {
                step: Step::Secret,
                status: StepStatus::Running,
            })
            .unwrap(),
            serde_json::json!({ "step": "secret", "status": "running" }),
            "the whole event shape, field names included"
        );

        for (step, id) in [
            (Step::Space, "space"),
            (Step::Memory, "memory"),
            (Step::Recall, "recall"),
            (Step::Finish, "finish"),
            (Step::Secret, "secret"),
            (Step::Confirm, "confirm"),
            // Emitted by `commands::rotate_password`, not by this module — the
            // string still has to be right, and this is where the wire format is
            // pinned.
            (Step::Local, "local"),
        ] {
            let event = StepEvent { step, status: StepStatus::Done };
            assert_eq!(
                serde_json::to_value(&event).unwrap()["step"],
                serde_json::json!(id),
                "{step:?} must reach the front end as {id:?}"
            );
        }

        for (status, id) in [
            (StepStatus::Running, "running"),
            (StepStatus::Done, "done"),
            (StepStatus::Error, "error"),
        ] {
            let event = StepEvent { step: Step::Secret, status };
            assert_eq!(
                serde_json::to_value(&event).unwrap()["status"],
                serde_json::json!(id),
                "{status:?} must reach the front end as {id:?}"
            );
        }
    }

    /// A brain whose vector index is broken must still be rotatable.
    ///
    /// This is the unrecoverable one. `health_ok` requires `ok && vectorize.ok`,
    /// so against a degraded index the confirmation can *never* go green: the
    /// secret is written on the first attempt and accepted, the poll fails twelve
    /// times, `persist` never runs, and the keychain keeps the old password while
    /// the brain is already on the new one. Every "Try again" repeats exactly
    /// that, and nothing in the app can tell the user their password did change.
    ///
    /// So the gate asks the only question it needs answered — does the new
    /// password open the brain — and this fake answers the two questions
    /// differently to prove which one it asked.
    #[tokio::test]
    async fn a_rotation_completes_against_a_brain_whose_vector_index_is_unhealthy() {
        let fake = Fake {
            degraded_vector_index: true,
            ..Default::default()
        };
        rotate_secret(
            &&fake,
            "https://second-brain.acme.workers.dev",
            "new-pw-123456789",
            |_| {},
        )
        .await
        .expect("a broken vector index is not a wrong password");

        assert_eq!(
            *fake.probe_calls.lock().unwrap(),
            1,
            "the auth probe passed first time — there was nothing to retry"
        );
        assert!(
            fake.entries().contains(&"auth_ok".to_string()),
            "the gate must be the auth-only probe: {:?}",
            fake.entries()
        );
        assert!(
            !fake.entries().contains(&"health_ok".to_string()),
            "the full health check would never go green here: {:?}",
            fake.entries()
        );
    }

    /// The inversion guard. In `update_worker` a 401 during the health poll means
    /// the redeploy dropped the secret and is terminal; here it means the new
    /// secret has not reached the edge yet, which is the *normal* answer for the
    /// first seconds of a rotation.
    ///
    /// This test fails the moment someone "fixes" the two functions to agree.
    #[tokio::test]
    async fn rotation_retries_through_unauthorized_until_the_secret_propagates() {
        let fake = Fake {
            health_unauthorized: Mutex::new(3),
            ..Default::default()
        };
        rotate_secret(
            &&fake,
            "https://second-brain.acme.workers.dev",
            "new-pw-123456789",
            |_| {},
        )
        .await
        .expect("a 401 while the secret propagates is not a failed rotation");

        assert_eq!(*fake.probe_calls.lock().unwrap(), 4, "3 × 401, then green");
        // Waiting is what fixes a 401 here — re-writing the secret would be a
        // second write racing the first and would tell us nothing new.
        assert_eq!(secret_writes(&fake).len(), 1);
    }

    /// A rotation that never confirms fails, rather than waiting forever — but it
    /// still only ever wrote once, so the caller's "your new password may already
    /// be live" message stays true.
    #[tokio::test]
    async fn rotation_gives_up_after_health_attempts_and_writes_only_once() {
        let fake = Fake {
            health_unauthorized: Mutex::new(HEALTH_ATTEMPTS + 5),
            ..Default::default()
        };
        let events = Mutex::new(Vec::new());
        let err = rotate_secret(
            &&fake,
            "https://second-brain.acme.workers.dev",
            "new-pw-123456789",
            |e| events.lock().unwrap().push((e.step, e.status)),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, ProvisionError::HealthCheckFailed),
            "expected HealthCheckFailed, got {err:?}"
        );
        assert_eq!(
            *fake.probe_calls.lock().unwrap(),
            HEALTH_ATTEMPTS,
            "every attempt is used, and no more"
        );
        assert_eq!(secret_writes(&fake).len(), 1, "one PUT, not one per poll");

        // The write succeeded and the confirmation did not, and the screen has to
        // show exactly that: it is the difference between "nothing happened" and
        // "your new password may already be live", which are opposite
        // instructions to the person reading them.
        let events = events.into_inner().unwrap();
        assert!(
            events.contains(&(Step::Secret, StepStatus::Done)),
            "the change did go out: {events:?}"
        );
        assert!(
            events.contains(&(Step::Confirm, StepStatus::Error)),
            "the confirmation is what failed: {events:?}"
        );
    }

    /// A brain on its own domain yields no script name, so there is nothing to
    /// write the secret to. The refusal has to come *before* the write: guessing
    /// at a name would set AUTH_TOKEN on some other Worker in the account.
    ///
    /// And before any progress is reported, which is the half the events are
    /// captured for. The documented property is that this is refused "without a
    /// half-started progress screen"; with the callback thrown away, moving the
    /// first emit above the refusal left this test green while the user got a
    /// checklist that starts, stops on a spinner and is then replaced by an error
    /// screen — the flicker that makes people believe something was written.
    #[tokio::test]
    async fn rotation_refuses_a_custom_domain_before_touching_the_password() {
        let fake = Fake::default();
        let events = Mutex::new(Vec::new());
        let err = rotate_secret(&&fake, "https://brain.example.com", "new-pw-123456789", |e| {
            events.lock().unwrap().push((e.step, e.status))
        })
        .await
        .unwrap_err();

        assert!(
            matches!(err, ProvisionError::NotAWorkersDevAddress),
            "expected NotAWorkersDevAddress, got {err:?}"
        );
        assert!(
            fake.entries().is_empty(),
            "a refused rotation must not call Cloudflare at all: {:?}",
            fake.entries()
        );
        let events = events.into_inner().unwrap();
        assert!(
            events.is_empty(),
            "a refusal must not start a progress screen it cannot finish: {events:?}"
        );
    }

    /// #257, applied to the password. The secret goes to the script named by the
    /// address the user is connected to, never to the bundled manifest's name —
    /// which here is `second-brain` and would be a different Worker entirely.
    ///
    /// Getting this wrong is worse than the update bug it mirrors: the real brain
    /// would keep the old password while the app reported a successful change,
    /// and an unrelated script would quietly gain an AUTH_TOKEN.
    #[tokio::test]
    async fn rotation_writes_to_the_script_named_by_the_address() {
        let fake = Fake::default();
        rotate_secret(
            &&fake,
            "https://my-brain.acme.workers.dev",
            "new-pw-123456789",
            |_| {},
        )
        .await
        .unwrap();

        assert_eq!(
            secret_writes(&fake),
            vec!["put_secret:my-brain:AUTH_TOKEN:new-pw-123456789".to_string()],
            "the manifest's script name must never be reached for"
        );
    }

    #[test]
    fn slugify_handles_awkward_names() {
        assert_eq!(slugify_subdomain("My Account"), "my-account");
        assert_eq!(slugify_subdomain("rahil@example.com's Account"), "rahil-example-com-s-account");
        assert_eq!(slugify_subdomain("---"), "second-brain");
        assert_eq!(slugify_subdomain(""), "second-brain");
        assert!(slugify_subdomain(&"x".repeat(100)).len() <= 40);
    }
}
