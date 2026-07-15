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
    async fn health_ok(&self, worker_url: &str, auth_token: &str) -> Result<bool, CfApiError>;
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
pub fn build_update_metadata(
    manifest: &WorkerManifest,
    d1_id: &str,
    kv_id: &str,
    assets_jwt: &str,
) -> serde_json::Value {
    let mut bindings = vec![
        serde_json::json!({ "type": "d1", "name": manifest.d1_binding, "database_id": d1_id }),
        serde_json::json!({ "type": "vectorize", "name": manifest.vectorize_binding, "index_name": manifest.vectorize_name }),
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
    progress: impl Fn(StepEvent),
) -> Result<(), ProvisionError> {
    let emit = |step: Step, status: StepStatus| progress(StepEvent { step, status });
    let script = manifest.script_name.as_str();

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

    // Recall — make sure the vector index exists (unchanged across updates).
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

    // Finish — upload the newer assets + Worker (password preserved), then verify.
    step!(Step::Finish, async {
        let assets_jwt = backend.upload_assets(script).await?;
        let metadata = build_update_metadata(manifest, &d1_id, &kv_id, &assets_jwt);
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
            "cron": ["0 1 * * *"],
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
            _script: &str,
        ) -> Result<Vec<serde_json::Value>, CfApiError> {
            self.log("get_script_bindings");
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
            let mut failures = self.health_failures.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Ok(false);
            }
            self.log("health_ok");
            Ok(true)
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
        assert!(log.contains(&"set_cron:0 1 * * *".to_string()));
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
            |_| {},
        )
        .await
        .unwrap();

        let log = fake.entries();
        assert!(log.contains(&"get_script_bindings".to_string()));
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
        update_worker(&&fake, &test_manifest(), "https://x.acme.workers.dev", "tok", |_| {})
            .await
            .unwrap();
        let meta = fake.last_deploy_metadata.lock().unwrap().clone().unwrap();
        let bindings = meta["bindings"].as_array().unwrap();
        let find = |ty: &str| bindings.iter().find(|b| b["type"] == ty).unwrap();
        assert_eq!(find("d1")["database_id"], "found-d1");
        assert_eq!(find("kv_namespace")["namespace_id"], "found-kv");
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
