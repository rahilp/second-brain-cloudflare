//! Serde types for the Cloudflare v4 API envelope and the handful of
//! resources the installer provisions.

use serde::{Deserialize, Deserializer};

#[derive(Debug, Deserialize)]
pub struct Envelope<T> {
    // The classic v4 envelope always includes `success`, but some newer
    // endpoints (Workers assets: assets-upload-session, /assets/upload) return
    // `{ "result": … }` with no `success`. Default to true when absent — a real
    // error still carries `success: false` and/or a non-empty `errors` array.
    #[serde(default = "default_true")]
    pub success: bool,
    // Cloudflare sometimes sends `"errors": null` rather than omitting it or
    // sending `[]`; treat null the same as missing/empty.
    #[serde(default, deserialize_with = "null_default")]
    pub errors: Vec<CfError>,
    pub result: Option<T>,
}

fn default_true() -> bool {
    true
}

/// Deserializes a value that may be `null` into its `Default` — for fields
/// Cloudflare sends as `null` instead of an empty collection.
pub fn null_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, Deserialize)]
pub struct CfError {
    #[serde(default)]
    pub code: i64,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct D1Database {
    pub uuid: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KvNamespace {
    pub id: String,
    pub title: String,
}

/// One index record, as returned by `GET .../vectorize/v2/indexes/{name}`.
///
/// Cloudflare's v4 schema marks *every* field on this record optional, but
/// `name` is kept required here: the provisioning find-or-create path has
/// always parsed this record successfully, and a parse failure there would
/// have made it try to create an index that already exists and fail loudly.
/// The other documented fields (`created_on`, `modified_on`, `description`)
/// are deliberately not modelled — nothing needs them.
#[derive(Debug, Clone, Deserialize)]
pub struct VectorizeIndex {
    #[allow(dead_code)] // deserialization target — presence of the record is the signal
    pub name: String,
    /// Optional per Cloudflare's schema. `CfClient::vectorize_config` turns
    /// an absent config into an error rather than a default: a fabricated
    /// `dimensions: 0` would quietly pass for "not the dimensions I wanted"
    /// while looking like a real answer.
    pub config: Option<VectorizeConfig>,
}

/// `GET .../vectorize/v2/indexes/{name}/metadata_index/list`.
#[derive(Debug, Clone, Deserialize)]
pub struct MetadataIndexList {
    #[serde(rename = "metadataIndexes", default)]
    pub metadata_indexes: Vec<MetadataIndex>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MetadataIndex {
    #[serde(rename = "propertyName")]
    pub property_name: String,
}

/// The immutable half of a Vectorize index. Cloudflare fixes both values at
/// creation — "the configuration of an index cannot be changed after
/// creation" — which is the whole reason an embedding-model switch needs a new
/// index and a redeploy rather than a config edit.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct VectorizeConfig {
    pub dimensions: u32,
    pub metric: String,
}

/// `GET .../vectorize/v2/indexes/{name}/info` — the *sibling* of the index
/// record, and the only documented place a vector count is exposed.
///
/// Note the casing flip: the index record uses snake_case (`created_on`),
/// this endpoint uses camelCase. That is Cloudflare's schema, not a typo,
/// hence the explicit renames. `processedUpToDatetime` is also documented but
/// not modelled — the mutation id is the useful settling signal.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // read by tests and by the #248 migration flow landing alongside this
pub struct VectorizeInfo {
    /// `None` means Cloudflare did not report a count — **not** that the index
    /// is empty. Never collapse it to 0 to decide a rebuild finished, because
    /// that reads as "verified empty" right before an irreversible delete.
    #[serde(rename = "vectorCount")]
    pub vector_count: Option<u64>,
    pub dimensions: Option<u32>,
    /// Id of the last mutation batch folded into the index. Vectorize applies
    /// upserts asynchronously, so a count can lag a just-finished re-embed.
    #[serde(rename = "processedUpToMutation")]
    pub processed_up_to_mutation: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubdomainResult {
    pub subdomain: Option<String>,
}

/// An entry from `GET /accounts/{id}/workers/scripts`. Cloudflare names the
/// script in `id`; the field is the deploy name, which is also the workers.dev
/// hostname label.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkerScript {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadSession {
    pub jwt: Option<String>,
    // Cloudflare returns `"buckets": null` when there's nothing to upload.
    #[serde(default, deserialize_with = "null_default")]
    pub buckets: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadedBucket {
    pub jwt: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CfApiError {
    #[error("network problem talking to Cloudflare: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Cloudflare sign-in expired")]
    Unauthorized,
    /// A 401 that came from the *deployed brain*, not from Cloudflare. The
    /// worker probes (`worker_health_ok` and friends) talk to the user's own
    /// Worker over workers.dev, and its `requireAuth` answers 401 for "that
    /// password does not open this brain" — which has nothing to do with the
    /// Cloudflare OAuth session the app holds, and must never be shown as
    /// "your Cloudflare sign-in expired". Kept apart from [`Self::Unauthorized`]
    /// so the two cannot drift back together: a setup failure that blames the
    /// sign-in sends a user re-authorising Cloudflare to fix a password
    /// problem (discussion #315).
    #[error("the Second Brain rejected the password the app sent it")]
    WorkerAuthRejected,
    #[error("Cloudflare error {code}: {message}")]
    Api { code: i64, message: String },
    #[error("Cloudflare returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("{0}")]
    Other(String),
}

impl CfApiError {
    pub fn from_errors(errors: &[CfError]) -> Self {
        match errors.first() {
            Some(e) => CfApiError::Api {
                code: e.code,
                message: e.message.clone(),
            },
            None => CfApiError::Other("Cloudflare reported failure without details".into()),
        }
    }
}
