//! The Worker bundle baked into this binary at build time.
//!
//! `npm run bundle-worker` produces `worker-dist/` (single-file Worker module,
//! dashboard assets, binding manifest derived from wrangler.jsonc); this module
//! embeds it and exposes what the provisioning pipeline needs, including asset
//! hashes computed the way Cloudflare's upload API expects.

use base64::Engine;
use include_dir::{include_dir, Dir};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::LazyLock;

static WORKER_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/worker-dist");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerManifest {
    pub script_name: String,
    /// Version of the bundled Worker (its `SB_VERSION`), for update detection.
    pub worker_version: String,
    pub compatibility_date: String,
    pub compatibility_flags: Vec<String>,
    pub vars: BTreeMap<String, String>,
    pub cron: Vec<String>,
    pub d1_binding: String,
    pub d1_name: String,
    pub vectorize_binding: String,
    pub vectorize_name: String,
    pub vectorize_dimensions: u32,
    pub vectorize_metric: String,
    pub kv_binding: String,
    pub ai_binding: String,
}

static MANIFEST: LazyLock<WorkerManifest> = LazyLock::new(|| {
    let raw = WORKER_DIST
        .get_file("manifest.json")
        .expect("worker-dist/manifest.json embedded")
        .contents_utf8()
        .expect("manifest.json is utf8");
    serde_json::from_str(raw).expect("manifest.json matches WorkerManifest")
});

pub fn manifest() -> &'static WorkerManifest {
    &MANIFEST
}

pub fn worker_script() -> &'static [u8] {
    WORKER_DIST
        .get_file("worker.js")
        .expect("worker-dist/worker.js embedded")
        .contents()
}

/// One dashboard file, ready for the assets-upload-session manifest.
pub struct AssetFile {
    /// Path key as the upload API wants it: absolute, e.g. `/index.html`.
    pub path: String,
    /// Cloudflare asset hash (see [`asset_hash`]).
    pub hash: String,
    pub size: usize,
    pub mime: &'static str,
    pub bytes: &'static [u8],
}

/// Cloudflare's asset hash: hex(sha256(base64(contents) + extension-without-dot))
/// truncated to 32 chars — verified against the official direct-upload example.
pub fn asset_hash(bytes: &[u8], ext: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut hasher = Sha256::new();
    hasher.update(b64.as_bytes());
    hasher.update(ext.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..32].to_string()
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn collect(dir: &'static Dir<'static>, strip: &str, out: &mut Vec<AssetFile>) {
    for file in dir.files() {
        let rel = file
            .path()
            .to_str()
            .expect("asset paths are utf8")
            .strip_prefix(strip)
            .expect("asset paths live under assets/");
        let ext = file
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        out.push(AssetFile {
            path: format!("/{rel}"),
            hash: asset_hash(file.contents(), ext),
            size: file.contents().len(),
            mime: mime_for(ext),
            bytes: file.contents(),
        });
    }
    for sub in dir.dirs() {
        collect(sub, strip, out);
    }
}

pub fn asset_files() -> Vec<AssetFile> {
    let assets = WORKER_DIST
        .get_dir("assets")
        .expect("worker-dist/assets embedded");
    let mut out = Vec::new();
    collect(assets, "assets/", &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_matches_worker_expectations() {
        let m = manifest();
        assert_eq!(m.script_name, "second-brain");
        assert!(
            m.worker_version.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "worker_version should be a semver string, got {:?}",
            m.worker_version
        );
        assert_eq!(m.d1_binding, "DB");
        assert_eq!(m.vectorize_binding, "VECTORIZE");
        assert_eq!(m.vectorize_name, "second-brain-vectors");
        assert_eq!(m.vectorize_dimensions, 384);
        assert_eq!(m.vectorize_metric, "cosine");
        assert_eq!(m.kv_binding, "OAUTH_KV");
        assert_eq!(m.ai_binding, "AI");
        assert!(m.compatibility_flags.contains(&"nodejs_compat".to_string()));
        assert_eq!(m.cron, vec!["0 1 * * *"]);
    }

    #[test]
    fn asset_hash_matches_cloudflare_algorithm() {
        // Independently computed with node:
        //   createHash("sha256").update(Buffer.from("hello").toString("base64") + "html")
        //     .digest("hex").slice(0, 32)
        assert_eq!(asset_hash(b"hello", "html"), "5deeda9d2277e0ed541bfc03adafb3cf");
    }

    #[test]
    fn asset_files_cover_dashboard() {
        let files = asset_files();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"/index.html"));
        assert!(paths.contains(&"/utils.js"));
        for f in &files {
            assert_eq!(f.hash.len(), 32);
            assert!(f.size > 0);
            assert!(f.path.starts_with('/'));
        }
    }

    #[test]
    fn worker_script_is_single_module() {
        let js = std::str::from_utf8(worker_script()).unwrap();
        assert!(js.contains("export"));
        // Bundled output may only import workerd-native or cloudflare-provided modules.
        for line in js.lines().filter(|l| l.trim_start().starts_with("import ")) {
            assert!(
                line.contains("\"node:") || line.contains("\"cloudflare:"),
                "unexpected unbundled import: {line}"
            );
        }
    }
}
