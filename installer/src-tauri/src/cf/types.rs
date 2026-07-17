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

#[derive(Debug, Clone, Deserialize)]
pub struct VectorizeIndex {
    #[allow(dead_code)] // deserialization target — presence of the record is the signal
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubdomainResult {
    pub subdomain: Option<String>,
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
