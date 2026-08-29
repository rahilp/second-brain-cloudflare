//! A local stand-in for a real Second Brain, so demo mode has data to operate on.
//!
//! `SECOND_BRAIN_DRY_RUN=1` used to point the app at
//! `https://second-brain.demo.workers.dev`, which does not resolve. Every
//! Worker-backed screen therefore failed with "Couldn't reach your Second
//! Brain" — the Advanced Settings window would not open at all, and the
//! embedding-migration pane could not be exercised even once.
//!
//! # Why a real server rather than a `dry_run` branch
//!
//! The obvious fix is an `if session.dry_run` early return inside
//! [`crate::settings::fetch_settings`] and friends. That would prove nothing: the
//! request, the JSON parsing, the status mapping and the error copy would all be
//! skipped, so a clean demo run would say only that the short-circuit works.
//!
//! Instead this binds a real `tiny_http` listener on `127.0.0.1:0` and demo mode
//! is handed its address. `fetch_settings`, `apply_settings`, `reset_control`,
//! `fetch_estimate`, `run_batch` and `fetch_status` then execute completely
//! unchanged — real HTTP, real bearer auth, real deserialisation, real error
//! mapping. A demo run is evidence about the shipping code path.
//!
//! `tiny_http` is already a production dependency: [`crate::cf::oauth`] uses it
//! for the Cloudflare loopback callback. Nothing new is pulled in.
//!
//! # The config is derived, never typed out
//!
//! [`shipped_config`] is built from [`crate::settings::DEFAULT_LEVELS`] and the
//! levels in [`crate::settings::CONTROLS`], so the demo brain reports exactly the
//! keys and values the controls write. A hardcoded blob would drift the moment a
//! level was retuned, and the window would open showing "Custom" for a brain that
//! is in fact untouched — the single most misleading thing this could do.

use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The owner's own brain size, so the numbers on screen are plausible rather
/// than obviously synthetic.
pub const ENTRIES: u64 = 1620;
/// A lower bound, the way the Worker reports it.
pub const CHUNKS_AT_LEAST: u64 = 2100;

/// Entries per re-embed batch. Close to what the Worker actually manages —
/// `MIGRATION_CHUNK_BUDGET` is 20 chunks and most entries are one chunk — which
/// is what makes a demo rebuild take ~80 batches instead of finishing in one and
/// leaving the progress bar untested.
const BATCH_ENTRIES: u64 = 20;

/// Enough that progress is visible on screen, small enough that a full rebuild
/// of 1,620 entries takes about 20 seconds.
const BATCH_PAUSE: Duration = Duration::from_millis(250);

/// Set to a batch count to make the rebuild pause once, as it does when the
/// day's embedding allowance runs out. The "Paused for today" screen is
/// otherwise unreachable in a demo.
const STALL_ENV: &str = "SECOND_BRAIN_DEMO_STALL_AFTER";

/// Set to an attempt count to make a rotated password take that many refusals
/// before it works, the way a Cloudflare secret takes time to propagate.
///
/// A demo brain that switches instantly never exercises the health gate's retry
/// loop, and that loop is the one thing rotation does differently from
/// `update_worker`: there a 401 during the health poll is terminal, here it
/// means "not landed yet, keep asking". A brain that lands the new password on
/// the first request would pass either implementation, so the difference the
/// gate exists for would go untested. Off by default, because every other demo
/// flow wants the rotation over with.
///
/// **Rotation only** — see [`Demo::deployed_with`]. A password that arrives with
/// a deploy propagates through [`DEPLOY_ENV`] instead.
const ROTATE_ENV: &str = "SECOND_BRAIN_DEMO_ROTATE_AFTER";

/// Set to an attempt count to make a *deployed* password take that many
/// refusals before it works.
///
/// A real redeploy is not atomic at the edge: every node keeps serving the
/// previous version, holding the previous `AUTH_TOKEN`, until the new upload
/// reaches it. The installer's health poll can therefore hit a brain that
/// genuinely refuses the password the upload metadata carried — the state
/// behind discussion #315 — and what the poll does with that refusal is exactly
/// what had to change. Off by default: a deploy really does carry the secret
/// with it, and every other demo flow wants setup over with on the first ask.
const DEPLOY_ENV: &str = "SECOND_BRAIN_DEMO_DEPLOY_AFTER";

/// Shipped in `src/config.ts` DEFAULTS. All three must be values the pickers
/// offer, or the settings window shows a model that is not in its own dropdown
/// and the migration pane cannot read the current dimensions — asserted in
/// tests.
const DEMO_LLM_MODEL: &str = "@cf/meta/llama-4-scout-17b-16e-instruct";
const DEMO_INSIGHT_LLM_MODEL: &str = "@cf/openai/gpt-oss-120b";
const DEMO_EMBEDDING_MODEL: &str = "@cf/baai/bge-small-en-v1.5";

/// Returned when loopback cannot be bound at all. Port 1 refuses instantly, so
/// the app reports "Couldn't reach your Second Brain" — the truth — rather than
/// hanging.
const UNREACHABLE: &str = "http://127.0.0.1:1";

/// What demo mode hands the windows as the brain's password until a rotation
/// sets another one. Only a default: an unrotated brain accepts anything
/// non-empty, so nothing breaks if a caller uses a different string.
pub const DEFAULT_TOKEN: &str = "demo";

/// AI tools a demo brain starts out believing are connected — the two the app
/// can connect, Claude Code and Cursor.
const OAUTH_CONNECTIONS: u32 = 2;

const THREADS: usize = 3;

// ── Options ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Options {
    pub entries: u64,
    pub chunks_at_least: u64,
    pub batch_entries: u64,
    /// Deliberate delay per batch, so a demo rebuild is watchable. Zero in tests.
    pub batch_pause: Duration,
    /// Pause the rebuild once, after this many batches.
    pub stall_after: Option<u64>,
    /// Refuse a newly rotated password this many times before honouring it, so
    /// the health gate's retry loop has something to retry through.
    pub rotate_after: Option<u64>,
    /// Refuse a freshly *deployed* password this many times, standing in for
    /// edge nodes still serving the previous deployment — see [`DEPLOY_ENV`].
    pub deploy_after: Option<u64>,
    /// How many AI tools this brain believes are connected through the browser
    /// OAuth flow, before anything disconnects them.
    ///
    /// Two, because that is what the app can connect: Claude Code and Cursor.
    /// A count rather than a fixed reply so the route can report what it
    /// actually closed and then report nothing left, which is the sequence a
    /// user sees when they press the button twice.
    pub oauth_connections: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            entries: ENTRIES,
            chunks_at_least: CHUNKS_AT_LEAST,
            batch_entries: BATCH_ENTRIES,
            batch_pause: BATCH_PAUSE,
            stall_after: parse_stall_after(std::env::var(STALL_ENV).ok().as_deref()),
            rotate_after: parse_pending_attempts(std::env::var(ROTATE_ENV).ok().as_deref()),
            deploy_after: parse_pending_attempts(std::env::var(DEPLOY_ENV).ok().as_deref()),
            oauth_connections: OAUTH_CONNECTIONS,
        }
    }
}

/// Split out from the env read so it can be tested without `set_var`, which
/// races every other test in the process.
fn parse_stall_after(raw: Option<&str>) -> Option<u64> {
    // 0 would stall before the first batch, leaving no progress to resume from —
    // which is not the state the paused screen is for.
    positive_count(raw)
}

/// Split out from the env read for the same reason as [`parse_stall_after`].
/// Shared by both password knobs — rotation's and deploy's — since the shape
/// (attempts of refusal, zero means off) is the same.
fn parse_pending_attempts(raw: Option<&str>) -> Option<u64> {
    // 0 refusals is the default behaviour — the new password lands at once — so
    // it reads as "off" rather than as a delay of no length.
    positive_count(raw)
}

/// A count read from the environment. Absent, unparseable and zero all mean the
/// gate is off: a demo must never be made stranger by a typo in a variable.
fn positive_count(raw: Option<&str>) -> Option<u64> {
    let n = raw?.trim().parse::<u64>().ok()?;
    (n > 0).then_some(n)
}

// ── Config ──────────────────────────────────────────────────────────────────

/// The effective config a fresh brain reports, built from the controls
/// themselves.
///
/// Every key each control owns is present at its default level, so the settings
/// window renders every control at a named level. A control reading "Custom" on
/// an untouched demo brain would be a lie about what the user is looking at.
pub fn shipped_config() -> Map<String, Value> {
    let mut out = Map::new();
    for (control_id, level_id) in crate::settings::DEFAULT_LEVELS {
        // `settings.rs` asserts every entry here names a real control and a real
        // level of it, and that a level writes exactly that control's keys.
        let patch = crate::settings::patch_for(control_id, level_id)
            .expect("DEFAULT_LEVELS names a control and a level it has");
        out.extend(patch);
    }
    out.insert("LLM_MODEL".into(), json!(DEMO_LLM_MODEL));
    out.insert("INSIGHT_LLM_MODEL".into(), json!(DEMO_INSIGHT_LLM_MODEL));
    out.insert("EMBEDDING_MODEL".into(), json!(DEMO_EMBEDDING_MODEL));
    out
}

fn effective(overrides: &Map<String, Value>) -> Map<String, Value> {
    let mut cfg = shipped_config();
    for (key, value) in overrides {
        cfg.insert(key.clone(), value.clone());
    }
    cfg
}

fn embedding_model(overrides: &Map<String, Value>) -> String {
    effective(overrides)
        .get("EMBEDDING_MODEL")
        .and_then(|v| v.as_str())
        .unwrap_or(DEMO_EMBEDDING_MODEL)
        .to_string()
}

// ── State ───────────────────────────────────────────────────────────────────

/// The KV ledger `src/migration/embedding.ts` keeps, minus the parts only D1
/// needs. Held in memory so a PATCH is visible to the next GET and a rebuild
/// survives across the many requests it takes — the point of the exercise is
/// that saving a setting and reopening the window shows the saved value.
struct Ledger {
    model: String,
    started_at: u64,
    cursor_created_at: Option<u64>,
    cursor_id: Option<String>,
    processed: u64,
    failed: u64,
    total_at_start: u64,
    finished_at: Option<u64>,
    /// Batches completed, for the stall gate.
    batches: u64,
    /// The allowance is only exhausted once per demo, so Resume finishes the
    /// rebuild instead of pausing again on every click.
    stalled_once: bool,
}

impl Ledger {
    fn new(model: String, total: u64) -> Self {
        Self {
            model,
            started_at: now_ms(),
            cursor_created_at: None,
            cursor_id: None,
            processed: 0,
            failed: 0,
            total_at_start: total,
            finished_at: None,
            batches: 0,
            stalled_once: false,
        }
    }

    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("model".into(), json!(self.model));
        out.insert("startedAt".into(), json!(self.started_at));
        out.insert("cursorCreatedAt".into(), json!(self.cursor_created_at));
        out.insert("cursorId".into(), json!(self.cursor_id));
        out.insert("processed".into(), json!(self.processed));
        out.insert("failed".into(), json!(self.failed));
        out.insert("totalAtStart".into(), json!(self.total_at_start));
        // Absent rather than null until the rebuild finishes, matching
        // `MigrationState.finishedAt?`.
        if let Some(at) = self.finished_at {
            out.insert("finishedAt".into(), json!(at));
        }
        Value::Object(out)
    }
}

/// The `AUTH_TOKEN` secret, once a rotation has set one.
///
/// A real secret is not swapped atomically: the PUT returns before every edge
/// running the Worker has the new value, which is why the health gate polls
/// instead of trusting the write. `pending` models that window — until it
/// reaches zero the new password is refused and whatever it replaced still
/// works, exactly the order a rotation has to survive.
struct Password {
    /// The value the brain will accept once the write has propagated.
    value: String,
    /// What it replaced, still live while `pending` lasts. `None` means the
    /// brain was in its permissive state before this rotation.
    previous: Option<String>,
    /// Attempts with `value` left to refuse before it takes effect.
    pending: u64,
}

impl Password {
    /// What this brain accepts *right now*: the new value once it has landed,
    /// and whatever it replaced until then. `None` means "any non-empty token",
    /// the state a brain that has never been rotated is in.
    fn accepted_now(&self) -> Option<&str> {
        if self.pending > 0 {
            self.previous.as_deref()
        } else {
            Some(&self.value)
        }
    }
}

#[derive(Default)]
struct State {
    /// Sparse, exactly like `config:overrides` in KV.
    overrides: Map<String, Value>,
    ledger: Option<Ledger>,
    /// `None` until something disconnects the AI tools, after which it is
    /// whatever is left. Kept apart from [`Options::oauth_connections`] so the
    /// seeded count stays readable while the live one changes.
    oauth_connections: Option<u32>,
    /// `None` until something rotates this brain — see [`is_authenticated`] for
    /// why the default is permissive.
    password: Option<Password>,
}

struct Demo {
    options: Options,
    state: Mutex<State>,
}

// ── Routes ──────────────────────────────────────────────────────────────────

impl Demo {
    fn new(options: Options) -> Self {
        Self { options, state: Mutex::new(State::default()) }
    }

    fn handle(&self, method: &str, path: &str, body: &str) -> (u16, Value) {
        match (method, path) {
            ("GET", "/health") => (200, self.health()),
            // The demo brain is its own owner: it answers to one token and that
            // token is the deployment's. Shaped exactly like src/routes/admin.ts
            // returns it, because the Connection details window reads this to
            // decide whether to offer a password change.
            ("GET", "/team/me") => (
                200,
                json!({ "ok": true, "profile": { "role": "admin", "owner": true } }),
            ),
            ("POST", "/capture") => (200, json!({ "ok": true })),
            ("GET", "/config") => (200, self.config_body()),
            ("PATCH", "/config") => self.patch_config(body),
            ("DELETE", p) if p.starts_with("/config/") => {
                self.reset_key(&p["/config/".len()..])
            }
            ("GET", "/migration/estimate") => (200, self.estimate()),
            ("GET", "/migration/status") => (200, self.status()),
            ("POST", "/migration/reembed") => (200, self.reembed()),
            ("POST", "/migration/reset") => {
                self.state.lock().unwrap().ledger = None;
                (200, json!({ "ok": true }))
            }
            ("POST", "/oauth/revoke-all") => (200, self.revoke_all()),
            _ => (404, json!({ "ok": false, "error": "Not found" })),
        }
    }

    /// `{ ok, revoked, failed }`, as `src/routes/oauth-revoke.ts` returns it.
    ///
    /// Rotation deliberately leaves OAuth-connected tools working, so the app
    /// offers this as a separate action — and an action whose whole purpose is
    /// to close a door has to be demonstrable, or the one screen that must not
    /// lie is the one nobody ever sees.
    ///
    /// Counts down rather than replying with a fixed number: pressing the button
    /// twice reports two connections closed and then none left, which is the
    /// real sequence. A constant `{ ok: true, revoked: 2 }` would report closing
    /// connections that were already closed.
    fn revoke_all(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        let live = state.oauth_connections.unwrap_or(self.options.oauth_connections);
        state.oauth_connections = Some(0);
        json!({ "ok": true, "revoked": live, "failed": 0 })
    }

    /// `{ ok, version, vectorize }`, as `src/routes/admin.ts` returns it. The
    /// index it names follows the model in force, so a demo migration changes
    /// what health reports the way a real one does.
    fn health(&self) -> Value {
        let manifest = crate::worker_bundle::manifest();
        let model = embedding_model(&self.state.lock().unwrap().overrides);
        let dimensions =
            crate::migration::dimensions_for(&model).unwrap_or(manifest.vectorize_dimensions);
        json!({
            "ok": true,
            "version": manifest.worker_version,
            "vectorize": {
                "ok": true,
                "indexName": crate::migration::index_name_for(
                    &manifest.vectorize_name,
                    dimensions,
                    manifest.vectorize_dimensions,
                ),
                "dimensions": dimensions,
                "vectorCount": self.options.chunks_at_least,
            }
        })
    }

    /// Three things, not one: a settings UI needs the effective values, the
    /// sparse overrides and the shipped defaults to say "changed from 0.7 to
    /// 0.45" and to know whether a reset control should be live at all.
    fn config_body(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({
            "ok": true,
            "config": effective(&state.overrides),
            "overrides": state.overrides,
            "defaults": shipped_config(),
        })
    }

    /// Sparse merge. The whole patch is rejected if any key is unknown, so a
    /// batch that names one bad setting writes nothing.
    fn patch_config(&self, body: &str) -> (u16, Value) {
        let Ok(Value::Object(patch)) = serde_json::from_str::<Value>(body) else {
            return (
                400,
                json!({ "ok": false, "error": "Body must be an object of setting → value" }),
            );
        };
        let known = shipped_config();
        for key in patch.keys() {
            if !known.contains_key(key) {
                return (400, json!({ "ok": false, "error": format!("{key} is not a known setting") }));
            }
        }
        let mut state = self.state.lock().unwrap();
        for (key, value) in patch {
            state.overrides.insert(key, value);
        }
        (200, json!({ "ok": true, "config": effective(&state.overrides) }))
    }

    /// Per-setting reset: drop the override so the value rejoins the shipped
    /// default, rather than writing that default back.
    fn reset_key(&self, key: &str) -> (u16, Value) {
        if !shipped_config().contains_key(key) {
            return (404, json!({ "ok": false, "error": format!("{key} is not a known setting") }));
        }
        let mut state = self.state.lock().unwrap();
        state.overrides.remove(key);
        (200, json!({ "ok": true, "config": effective(&state.overrides) }))
    }

    fn estimate(&self) -> Value {
        let model = embedding_model(&self.state.lock().unwrap().overrides);
        json!({
            "ok": true,
            "entries": self.options.entries,
            "chunksAtLeast": self.options.chunks_at_least,
            "model": model,
        })
    }

    /// `state` is null until a rebuild has ever been started for this brain.
    fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({
            "ok": true,
            "state": state.ledger.as_ref().map(Ledger::to_json).unwrap_or(Value::Null),
            "model": embedding_model(&state.overrides),
        })
    }

    /// One bounded batch, the shape the app loops on.
    ///
    /// Mirrors `runBatch`: a target change mid-run restarts from the beginning,
    /// because entries before the cursor hold vectors from the previous target;
    /// `remaining` is recomputed every call; and `done` is only ever true once
    /// `remaining` has reached 0.
    fn reembed(&self) -> Value {
        // Outside the lock: holding it across the sleep would serialise an
        // unrelated /config read behind a batch.
        if !self.options.batch_pause.is_zero() {
            std::thread::sleep(self.options.batch_pause);
        }

        let total = self.options.entries;
        let mut state = self.state.lock().unwrap();
        let target = embedding_model(&state.overrides);

        let restart = state.ledger.as_ref().map(|l| l.model != target).unwrap_or(true);
        if restart {
            state.ledger = Some(Ledger::new(target, total));
        }
        let pause_after = self.options.stall_after;
        let batch = self.options.batch_entries;
        let ledger = state.ledger.as_mut().expect("just ensured");

        // The day's allowance running out. The cursor is kept, so resuming costs
        // nothing already paid for.
        if let Some(after) = pause_after {
            if ledger.batches >= after && !ledger.stalled_once && ledger.processed < total {
                ledger.stalled_once = true;
                ledger.failed += 1;
                return json!({
                    "ok": true,
                    "processed": 0,
                    "failed": 1,
                    "remaining": total - ledger.processed,
                    "total": ledger.total_at_start.max(ledger.processed + (total - ledger.processed)),
                    "done": false,
                    "stalled": true,
                    "stalledReason": "budget",
                });
            }
        }

        let processed = batch.min(total.saturating_sub(ledger.processed));
        ledger.processed += processed;
        ledger.batches += 1;
        let remaining = total.saturating_sub(ledger.processed);
        if processed > 0 {
            ledger.cursor_created_at = Some(cursor_time(ledger.processed, total, now_ms()));
            ledger.cursor_id = Some(format!("demo-entry-{:05}", ledger.processed));
        }
        let done = remaining == 0;
        if done && ledger.finished_at.is_none() {
            ledger.finished_at = Some(now_ms());
        }

        json!({
            "ok": true,
            "processed": processed,
            // Per batch, not cumulative — the ledger carries the running total.
            "failed": 0,
            "remaining": remaining,
            "total": ledger.total_at_start.max(ledger.processed + remaining),
            "done": done,
            "stalled": false,
        })
    }
}

/// Entries are spread over the last three years, so the keyset cursor advances
/// through time the way a real one does.
fn cursor_time(processed: u64, entries: u64, now: u64) -> u64 {
    const SPAN_MS: u64 = 3 * 365 * 86_400_000;
    now.saturating_sub(SPAN_MS) + SPAN_MS * processed / entries.max(1)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

// ── Password ────────────────────────────────────────────────────────────────

impl Demo {
    /// Whether `token` — already known to be non-empty — opens this brain.
    /// [`is_authenticated`] carries the reasoning for the two states.
    ///
    /// Takes the lock for writing because the check *is* a write while a
    /// rotation is propagating: spending the pending counter is what makes the
    /// new password land after N refusals rather than never.
    fn accepts(&self, token: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(password) = state.password.as_mut() else {
            return true;
        };
        // The new value, still propagating: refuse it and spend one attempt.
        if password.pending > 0 && token == password.value {
            password.pending -= 1;
            return false;
        }
        match password.accepted_now() {
            Some(accepted) => token == accepted,
            None => true,
        }
    }

    /// Makes `token` the only password this brain accepts, once any configured
    /// propagation delay has been spent.
    fn rotate_to(&self, token: &str) {
        self.set_password(token, self.options.rotate_after.unwrap_or(0));
    }

    /// Makes `token` the only password this brain accepts, **now**.
    ///
    /// A fresh deploy carries `AUTH_TOKEN` as a binding in its upload metadata,
    /// so the Worker comes up already holding it: normally there is no
    /// propagation window, because there was no separate secret write to
    /// propagate. [`DEPLOY_ENV`] reintroduces one on purpose — real edge nodes
    /// keep serving the previous deployment for a few seconds — so the health
    /// poll's treatment of a refusal is exercised rather than assumed.
    ///
    /// Split from [`Self::rotate_to`] because each knob must reach one and not
    /// the other.
    fn deployed_with(&self, token: &str) {
        self.set_password(token, self.options.deploy_after.unwrap_or(0));
    }

    fn set_password(&self, token: &str, pending: u64) {
        let mut state = self.state.lock().unwrap();
        // What is live now, not what was written last: rotating again while an
        // earlier rotation is still propagating must not resurrect a password
        // that never worked.
        let previous = state
            .password
            .as_ref()
            .and_then(|p| p.accepted_now().map(str::to_string));
        state.password = Some(Password {
            value: token.to_string(),
            previous,
            pending,
        });
    }

    /// The password that works against this brain at this moment, for callers
    /// that have to hand one to a window.
    fn auth_token(&self) -> String {
        self.state
            .lock()
            .unwrap()
            .password
            .as_ref()
            .and_then(Password::accepted_now)
            .unwrap_or(DEFAULT_TOKEN)
            .to_string()
    }
}

// ── Server ──────────────────────────────────────────────────────────────────

/// Shown when demo mode opens the dashboard. The wrapper window would otherwise
/// load a blank page from an address that has no dashboard behind it.
const PLACEHOLDER: &str = "<!doctype html><meta charset=\"utf-8\">\
<title>Second Brain — demo</title>\
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#1d1d1f}\
h1{font-size:1.35rem;margin:0 0 .6rem}p{color:#6e6e73}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}p{color:#98989d}}</style>\
<h1>Demo brain</h1>\
<p>This is a stand-in Second Brain running on this computer. It answers the app's \
settings and rebuild requests with plausible data so the flow can be tried end to \
end; it holds no memories of its own.</p>";

fn json_response(status: u16, payload: &Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(payload.to_string())
        .with_status_code(status)
        .with_header(
            "Content-Type: application/json"
                .parse::<tiny_http::Header>()
                .expect("static header"),
        )
}

/// Every route the real Worker guards with `requireAuth` is guarded here, so a
/// demo run is also evidence the app sends its token.
///
/// There are two states, because rotation needs both:
///
/// * **No password set — the default.** Any non-empty bearer token is accepted
///   rather than one literal string: what is worth proving is that the app
///   authenticates at all, and pinning the value would turn an unrelated change
///   of the demo token into a window full of 401s. Every demo flow that is not
///   about rotation stays in this state.
/// * **A password set by [`rotate_to`].** Only that value is accepted, and
///   everything else gets the 401 an unauthenticated request already gets. The
///   whole safety property of a rotation is a health check that passes *only*
///   once the new password is live, and against a brain that accepts anything
///   that check passes trivially and proves nothing. It is also the only way to
///   reach the "your password was changed on another computer" screen, which
///   needs the old token to genuinely stop working.
///
/// The header is read once and checked once rather than folded over every
/// authorization header: the check has a side effect while a rotation is
/// propagating, and a request carrying two of them must not spend two attempts.
fn is_authenticated(demo: &Demo, req: &tiny_http::Request) -> bool {
    let Some(token) = bearer_token(req) else {
        return false;
    };
    demo.accepts(&token)
}

/// The first non-empty bearer token a request carries.
fn bearer_token(req: &tiny_http::Request) -> Option<String> {
    req.headers()
        .iter()
        .filter(|h| h.field.equiv("authorization"))
        .find_map(|h| bearer_of(&h.value.to_string()).map(str::to_string))
}

/// The token inside one `Authorization` value, if it carries a bearer one.
///
/// Case-sensitive, because `src/lib/http.ts` compares the whole header against
/// `Bearer ${env.AUTH_TOKEN}` and nothing else — a demo brain that accepted
/// `bearer` would pass a request the real Worker refuses.
///
/// Split out from the header walk because it is the only part that can be
/// tested for what it rejects: both hyper and `tiny_http` strip surrounding
/// whitespace from a header value, so a scheme with nothing after it cannot be
/// put on the wire at all, and the empty-token guard is reachable only from
/// here.
fn bearer_of(value: &str) -> Option<&str> {
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then_some(token)
}

fn serve(server: &tiny_http::Server, demo: &Demo) {
    loop {
        let Ok(mut req) = server.recv() else { return };
        let method = req.method().as_str().to_string();
        let raw = req.url().to_string();
        let path = raw.split('?').next().unwrap_or_default().to_string();

        // Before the auth check, not after. The placeholder page is unguarded —
        // it is a page, not a brain route — and asking `is_authenticated` about a
        // request that is not going to be authorised anyway is not free: the
        // check *spends* a propagation attempt while a rotation is in flight. A
        // dashboard window loading this page mid-rotation would land the new
        // password one refusal earlier than the demo was set up to require.
        if method == "GET" && (path == "/" || path == "/index.html") {
            let response = tiny_http::Response::from_string(PLACEHOLDER).with_header(
                "Content-Type: text/html; charset=utf-8"
                    .parse::<tiny_http::Header>()
                    .expect("static header"),
            );
            let _ = req.respond(response);
            continue;
        }

        let authed = is_authenticated(demo, &req);
        let mut body = String::new();
        let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);

        let (status, payload) = if authed {
            demo.handle(&method, &path, &body)
        } else {
            (401, json!({ "ok": false, "error": "Unauthorized" }))
        };
        let _ = req.respond(json_response(status, &payload));
    }
}

/// Binds a demo brain on an ephemeral loopback port, returning its address and
/// the state behind it.
///
/// A small pool rather than one thread: a re-embed batch sleeps, and a single
/// handler would hold an unrelated /config read behind it.
fn bind(options: Options) -> Option<(String, Arc<Demo>)> {
    let server = tiny_http::Server::http("127.0.0.1:0").ok()?;
    let port = server.server_addr().to_ip()?.port();
    let server = Arc::new(server);
    let demo = Arc::new(Demo::new(options));
    for _ in 0..THREADS {
        let server = server.clone();
        let demo = demo.clone();
        std::thread::spawn(move || serve(&server, &demo));
    }
    Some((format!("http://127.0.0.1:{port}"), demo))
}

/// The demo brain this process serves: the address to hand out, and the handle
/// a rotation needs to reach in and change the password.
struct Running {
    base_url: String,
    /// `None` when loopback could not be bound at all — there is then nothing
    /// listening, so there is also nothing to rotate.
    demo: Option<Arc<Demo>>,
}

static RUNNING: OnceLock<Running> = OnceLock::new();

/// The one demo brain, started if it is not already up.
fn running() -> &'static Running {
    RUNNING.get_or_init(|| match bind(Options::default()) {
        Some((url, demo)) => {
            log::info!("demo brain listening on {url}");
            Running { base_url: url, demo: Some(demo) }
        }
        None => {
            log::warn!("could not bind the demo brain to loopback");
            Running { base_url: UNREACHABLE.to_string(), demo: None }
        }
    })
}

// A brain bound for the duration of one test, standing in for the process-wide
// one — see `scoped_brain`.
#[cfg(test)]
thread_local! {
    static SCOPED: std::cell::RefCell<Option<Arc<Running>>> =
        const { std::cell::RefCell::new(None) };
}

/// The brain the functions below reach: the one bound for the current test if
/// there is one, and otherwise the process-wide one.
fn with_current<T>(f: impl FnOnce(&Running) -> T) -> T {
    #[cfg(test)]
    if let Some(scoped) = SCOPED.with(|slot| slot.borrow().clone()) {
        return f(&scoped);
    }
    f(running())
}

/// Binds a demo brain for this test and points [`base_url`], [`auth_token`],
/// [`rotate_to`] and [`deployed_with`] at it until the returned guard is
/// dropped.
///
/// For any test that changes a demo brain's password. The process-wide brain is
/// exactly that — process-wide — so rotating it changes what every other test in
/// the process must send, and the suite runs in parallel: what reads as two
/// adjacent statements is a race against whatever else is mid-request. At
/// `RUST_TEST_THREADS=64` one such test failed 10 runs out of 15, and CI's thread
/// count follows the runner's cores.
///
/// Thread-local rather than a second static, because that is the scope the
/// property needs: `#[tokio::test]` drives its future to completion on the
/// calling thread, so everything the test awaits sees the binding and nothing
/// outside the test can.
#[cfg(test)]
pub fn scoped_brain() -> ScopedBrain {
    scoped_brain_with(test_options())
}

/// [`scoped_brain`] with the demo knobs set by hand — for the tests that are
/// *about* a knob.
#[cfg(test)]
pub fn scoped_brain_with(options: Options) -> ScopedBrain {
    let (base_url, demo) = bind(options).expect("bind loopback");
    let running = Arc::new(Running { base_url: base_url.clone(), demo: Some(demo) });
    let previous = SCOPED.with(|slot| slot.borrow_mut().replace(running));
    ScopedBrain { base_url, previous }
}

/// Holds a [`scoped_brain`] in place. Dropping it hands the free functions back
/// to whatever they reached before — the process-wide brain, or an outer scoped
/// one. Restored rather than cleared so a nested binding cannot silently promote
/// the inner brain's successor to the global.
#[cfg(test)]
pub struct ScopedBrain {
    base_url: String,
    previous: Option<Arc<Running>>,
}

#[cfg(test)]
impl ScopedBrain {
    /// This brain's address — the same value [`base_url`] answers while the
    /// guard is alive, for tests that would rather be explicit about it.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

#[cfg(test)]
impl Drop for ScopedBrain {
    fn drop(&mut self) {
        let previous = self.previous.take();
        SCOPED.with(|slot| *slot.borrow_mut() = previous);
    }
}

/// The options a test's brain runs with: the shipped numbers minus the delays,
/// and with both environment gates pinned off. Both read the environment, and a
/// variable left exported in a developer's shell must not change what the suite
/// proves.
#[cfg(test)]
pub fn test_options() -> Options {
    Options {
        batch_pause: Duration::ZERO,
        stall_after: None,
        rotate_after: None,
        deploy_after: None,
        ..Options::default()
    }
}

/// The demo brain's address, starting it if it is not already up.
///
/// Lazy as well as started at launch so no caller can be handed a dead address:
/// the port is chosen by the OS, so it cannot be a constant.
pub fn base_url() -> String {
    with_current(|running| running.base_url.clone())
}

/// The password the demo brain accepts right now — [`DEFAULT_TOKEN`] until a
/// rotation has set one, and during propagation still the one being replaced.
///
/// Demo mode has no keychain to read a rotated password back out of, so anything
/// that hands a token to a window has to ask the brain what it currently
/// answers to, or the window 401s for the rest of the run.
pub fn auth_token() -> String {
    with_current(|running| {
        running
            .demo
            .as_ref()
            .map(|demo| demo.auth_token())
            .unwrap_or_else(|| DEFAULT_TOKEN.to_string())
    })
}

/// Makes `token` the only password this demo brain accepts.
///
/// The dry-run branch of a rotation calls this: `DryRunBackend::put_secret`
/// records that the write happened, and this is the half that makes it true,
/// because the demo brain — not Cloudflare — is what `/health` is polled
/// against. Without it the health gate would pass against a server that accepts
/// anything, which is the one thing that gate exists to rule out, and the old
/// password would go on working forever.
///
/// Starts the brain if it is not up yet, so no ordering of a flow's calls can
/// leave a rotation writing to a brain nobody is serving.
pub fn rotate_to(token: &str) {
    with_current(|running| match &running.demo {
        Some(demo) => demo.rotate_to(token),
        None => log::warn!("no demo brain is listening, so there is no password to rotate"),
    })
}

/// Makes `token` the demo brain's password with no propagation delay, because a
/// deploy carries the secret with it — see [`Demo::deployed_with`].
///
/// Called by `DryRunBackend::deploy_worker` when the upload metadata carries an
/// `AUTH_TOKEN` binding, which is every fresh setup.
pub fn deployed_with(token: &str) {
    with_current(|running| match &running.demo {
        Some(demo) => demo.deployed_with(token),
        None => log::warn!("no demo brain is listening, so there is no password to set"),
    })
}

/// Brings the demo brain up at launch, before any window can ask for it.
pub fn start() {
    let _ = base_url();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Locale;
    use crate::settings::{self, CONTROLS, DEFAULT_LEVELS};

    /// A demo brain with the delays removed — [`test_options`] carries the
    /// reasoning, and the shipped numbers otherwise, so the tests exercise what a
    /// real demo run uses.
    fn brain() -> String {
        brain_with(test_options())
    }

    fn brain_with(options: Options) -> String {
        bind(options).expect("bind loopback").0
    }

    /// A brain plus the handle a rotation goes through. Most tests need only an
    /// address; these have to reach the state behind it.
    fn brain_and_handle(rotate_after: Option<u64>) -> (String, Arc<Demo>) {
        bind(Options { rotate_after, ..test_options() }).expect("bind loopback")
    }

    async fn get(url: &str, path: &str) -> (u16, Value) {
        let resp = reqwest::Client::new()
            .get(format!("{url}{path}"))
            .bearer_auth("demo")
            .send()
            .await
            .expect("request");
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    /// The status of a `/config` read carrying exactly this `Authorization`
    /// header, or none at all. Deliberately not `bearer_auth`: what these tests
    /// are about is what the header itself carries, down to an empty one.
    async fn config_status(url: &str, authorization: Option<&str>) -> u16 {
        let mut req = reqwest::Client::new().get(format!("{url}/config"));
        if let Some(value) = authorization {
            req = req.header("Authorization", value);
        }
        req.send().await.expect("request").status().as_u16()
    }

    async fn bearer_status(url: &str, token: &str) -> u16 {
        config_status(url, Some(&format!("Bearer {token}"))).await
    }

    async fn post(url: &str, path: &str) -> (u16, Value) {
        let resp = reqwest::Client::new()
            .post(format!("{url}{path}"))
            .bearer_auth("demo")
            .send()
            .await
            .expect("request");
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    /// Disconnecting reports what it closed, then reports nothing left.
    ///
    /// The second call is the point of the test. A demo route that always
    /// answered `{ revoked: 2 }` would tell a user it had just closed two
    /// connections that were already closed — and this is the one action whose
    /// entire value is that its report can be believed.
    #[tokio::test]
    async fn disconnecting_reports_what_it_closed_and_then_that_none_are_left() {
        let url = brain();

        let (status, body) = post(&url, "/oauth/revoke-all").await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        // A literal, not `OAUTH_CONNECTIONS`. Comparing the constant to itself
        // would pass whatever the demo brain claimed to hold — set it to 0 and
        // this stays green while the screen reports "0 connections closed" for a
        // brain the app says has two connected tools. The number is the point:
        // it is what the app can connect, Claude Code and Cursor.
        assert_eq!(body["revoked"], 2);
        assert_eq!(body["failed"], 0);

        let (status, body) = post(&url, "/oauth/revoke-all").await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true, "nothing to close is still a success");
        assert_eq!(body["revoked"], 0);

        // Guarded like every other route the real Worker guards.
        let resp = reqwest::Client::new()
            .post(format!("{url}/oauth/revoke-all"))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status().as_u16(), 401);

        // A page load must never disconnect anything.
        let (status, _) = get(&url, "/oauth/revoke-all").await;
        assert_eq!(status, 404, "GET must not do the work");
    }

    // ── The config the window renders ───────────────────────────────────────

    /// The whole point of deriving the payload from `CONTROLS`: every control
    /// must find all of its keys, or the window renders it as "Custom" — a lie
    /// about a brain nobody has touched.
    #[tokio::test]
    async fn the_demo_config_carries_every_key_every_control_owns() {
        let url = brain();
        let (status, body) = get(&url, "/config").await;
        assert_eq!(status, 200);
        let config = body["config"].as_object().expect("config object");
        for c in CONTROLS {
            for key in c.keys {
                assert!(
                    config.contains_key(*key),
                    "control {} owns {key}, which the demo config omits",
                    c.id
                );
            }
        }
    }

    /// Stronger than key presence: each control must resolve to a *named* level,
    /// and specifically to its default one.
    #[tokio::test]
    async fn every_control_reads_as_its_default_level_not_custom() {
        let url = brain();
        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        for (control_id, level_id) in DEFAULT_LEVELS {
            let c = view.controls.iter().find(|c| c.id == *control_id).expect("control present");
            assert_eq!(
                c.level.as_deref(),
                Some(*level_id),
                "{control_id} read as {:?} rather than its default",
                c.level
            );
        }
        assert_eq!(view.llm_model, DEMO_LLM_MODEL);
        assert_eq!(view.insight_llm_model, DEMO_INSIGHT_LLM_MODEL);
    }

    /// The three models must be ones the pickers offer. An LLM_MODEL or
    /// INSIGHT_LLM_MODEL outside `LLM_MODELS` renders an empty dropdown
    /// selection; an EMBEDDING_MODEL outside `EMBEDDING_MODELS` leaves
    /// `oldDimensions` null, which makes the last migration step unreachable.
    #[test]
    fn all_demo_models_are_offered_by_the_pickers() {
        assert!(
            settings::LLM_MODELS.contains(&DEMO_LLM_MODEL),
            "{DEMO_LLM_MODEL} is not in the dropdown"
        );
        assert!(
            settings::LLM_MODELS.contains(&DEMO_INSIGHT_LLM_MODEL),
            "{DEMO_INSIGHT_LLM_MODEL} is not in the dropdown"
        );
        assert!(
            crate::migration::dimensions_for(DEMO_EMBEDDING_MODEL).is_some(),
            "{DEMO_EMBEDDING_MODEL} has no known dimensions"
        );
    }

    /// The demo must not report a setting the Worker's config layer does not
    /// define, or a PATCH the window sends would 400 against a real brain while
    /// passing here.
    #[test]
    fn the_demo_config_only_names_settings_the_worker_ships() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/config.ts");
        let src = std::fs::read_to_string(path).expect("read src/config.ts");
        let start = src.find("export const DEFAULTS").expect("DEFAULTS block");
        let end = src[start..].find("} as const;").expect("end of DEFAULTS") + start;
        let defaults = &src[start..end];
        for key in shipped_config().keys() {
            assert!(
                defaults.contains(&format!("{key}:")),
                "{key} is not a Worker default — the demo reports a setting that does not exist"
            );
        }
        // And the three model strings must be the shipped ones, not a guess.
        assert!(
            defaults.contains(&format!("LLM_MODEL: \"{DEMO_LLM_MODEL}\"")),
            "LLM_MODEL drifted from src/config.ts"
        );
        assert!(
            defaults.contains(&format!("INSIGHT_LLM_MODEL: \"{DEMO_INSIGHT_LLM_MODEL}\"")),
            "INSIGHT_LLM_MODEL drifted from src/config.ts"
        );
        assert!(
            defaults.contains(&format!("EMBEDDING_MODEL: \"{DEMO_EMBEDDING_MODEL}\"")),
            "EMBEDDING_MODEL drifted from src/config.ts"
        );
    }

    #[tokio::test]
    async fn config_reports_effective_values_overrides_and_defaults_separately() {
        let url = brain();
        let (_, body) = get(&url, "/config").await;
        for key in ["config", "overrides", "defaults"] {
            assert!(body.get(key).is_some(), "/config omits {key}");
        }
        assert!(
            body["overrides"].as_object().expect("object").is_empty(),
            "a fresh brain has overridden nothing"
        );
        assert_eq!(body["config"]["MMR_LAMBDA"], json!(0.7));
    }

    // ── State survives across calls ─────────────────────────────────────────

    /// The reason this holds state at all: save a setting, reopen the window,
    /// see the saved value.
    #[tokio::test]
    async fn a_saved_level_is_what_the_next_read_reports() {
        let url = brain();
        settings::apply_settings(
            &url,
            "demo",
            &[("variety".into(), "varied".into())],
            &[],
            None,
            None,
            Locale::En,
        )
        .await
        .expect("save");

        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        let variety = view.controls.iter().find(|c| c.id == "variety").expect("variety");
        assert_eq!(variety.level.as_deref(), Some("varied"));

        // ...and only that control moved.
        let detail = view.controls.iter().find(|c| c.id == "detail").expect("detail");
        assert_eq!(detail.level.as_deref(), Some("standard"));
    }

    /// The insight model has its own save path, separate from `LLM_MODEL` — this
    /// proves a save actually reaches the Worker and comes back on the next read,
    /// the same round trip `a_saved_level_is_what_the_next_read_reports` proves
    /// for a level.
    #[tokio::test]
    async fn a_saved_insight_model_is_what_the_next_read_reports() {
        let url = brain();
        settings::apply_settings(
            &url,
            "demo",
            &[],
            &[],
            None,
            Some("@cf/qwen/qwen2.5-coder-32b-instruct".into()),
            Locale::En,
        )
        .await
        .expect("save");

        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        assert_eq!(view.insight_llm_model, "@cf/qwen/qwen2.5-coder-32b-instruct");

        // ...and the general-purpose model must be untouched by an insight-only save.
        assert_eq!(view.llm_model, DEMO_LLM_MODEL);
    }

    #[tokio::test]
    async fn a_patch_records_a_sparse_override_and_leaves_the_defaults_alone() {
        let url = brain();
        settings::patch_config(&url, "demo", &json!({ "MMR_LAMBDA": 0.45 }), Locale::En)
            .await
            .expect("patch");
        let (_, body) = get(&url, "/config").await;
        let overrides = body["overrides"].as_object().expect("object");
        assert_eq!(overrides.len(), 1, "only the changed key belongs in overrides: {overrides:?}");
        assert_eq!(overrides["MMR_LAMBDA"], json!(0.45));
        assert_eq!(body["config"]["MMR_LAMBDA"], json!(0.45));
        assert_eq!(body["defaults"]["MMR_LAMBDA"], json!(0.7), "the shipped default must not move");
    }

    #[tokio::test]
    async fn resetting_a_control_drops_its_overrides_and_returns_the_default_level() {
        let url = brain();
        settings::apply_settings(
            &url,
            "demo",
            &[("recency".into(), "recent_first".into())],
            &[],
            None,
            None,
            Locale::En,
        )
        .await
        .expect("save");
        settings::reset_control(&url, "demo", "recency", Locale::En).await.expect("reset");

        let (_, body) = get(&url, "/config").await;
        assert!(
            body["overrides"].as_object().expect("object").is_empty(),
            "a reset must delete the overrides, not write the default back"
        );
        let view = settings::fetch_settings(&url, "demo", Locale::En).await.expect("view");
        let recency = view.controls.iter().find(|c| c.id == "recency").expect("recency");
        assert_eq!(recency.level.as_deref(), Some("balanced"));
    }

    #[tokio::test]
    async fn a_patch_naming_an_unknown_setting_is_refused_and_writes_nothing() {
        let url = brain();
        let err = settings::patch_config(
            &url,
            "demo",
            &json!({ "MMR_LAMBDA": 0.45, "NOT_A_SETTING": 1 }),
            Locale::En,
        )
        .await
        .expect_err("must be refused");
        assert!(err.contains("NOT_A_SETTING"), "the error must name the key: {err}");

        let (_, body) = get(&url, "/config").await;
        assert!(
            body["overrides"].as_object().expect("object").is_empty(),
            "a rejected patch must not write its valid half"
        );
    }

    #[tokio::test]
    async fn deleting_an_unknown_setting_is_a_404() {
        let url = brain();
        let resp = reqwest::Client::new()
            .delete(format!("{url}/config/NOT_A_SETTING"))
            .bearer_auth("demo")
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status().as_u16(), 404);
    }

    #[tokio::test]
    async fn requests_without_a_bearer_token_are_refused() {
        let url = brain();
        let resp = reqwest::Client::new()
            .get(format!("{url}/config"))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status().as_u16(), 401, "the real Worker requires auth on /config");
    }

    // ── The password ────────────────────────────────────────────────────────

    /// The load-bearing test of this set, and it is about what did *not*
    /// change. Settings, migration, the dashboard window and every future demo
    /// flow send whatever token their caller happens to hold, so a brain that
    /// insisted on one literal value by default would answer all of them with
    /// 401s — the failure this permissive default was chosen to avoid.
    #[tokio::test]
    async fn a_brain_that_has_never_been_rotated_accepts_any_non_empty_token() {
        let url = brain();
        for token in [DEFAULT_TOKEN, "something-else-entirely", "hunter2hunter2"] {
            assert_eq!(
                bearer_status(&url, token).await,
                200,
                "{token} was refused by a brain with no password set"
            );
        }

        // Non-empty is still the floor: an absent, blank or non-bearer header is
        // not a credential, and the real Worker refuses all of them.
        for header in [None, Some(""), Some("Bearer "), Some("Bearer    "), Some("Bearer"), Some("Basic demo")] {
            assert_eq!(
                config_status(&url, header).await,
                401,
                "{header:?} must not authenticate"
            );
        }
    }

    /// What counts as a credential at all, checked here rather than over HTTP:
    /// hyper and `tiny_http` both strip whitespace around a header value, so a
    /// bearer scheme followed by nothing cannot be put on the wire, and the
    /// guard against an empty token has no other way of being exercised.
    #[test]
    fn only_a_bearer_scheme_with_something_after_it_is_a_token() {
        assert_eq!(bearer_of("Bearer demo"), Some("demo"));
        assert_eq!(bearer_of("Bearer  padded  "), Some("padded"));
        assert_eq!(bearer_of("Bearer "), None, "the scheme alone is not a credential");
        assert_eq!(bearer_of("Bearer \t "), None);
        assert_eq!(bearer_of("Bearer"), None);
        assert_eq!(bearer_of(""), None);
        assert_eq!(bearer_of("Basic demo"), None);
        // `src/lib/http.ts` matches `Bearer ${env.AUTH_TOKEN}` exactly, so a
        // lowercased scheme is a request the real Worker would refuse.
        assert_eq!(bearer_of("bearer demo"), None);
    }

    /// One test walking the whole sequence rather than one per scenario: a brain
    /// is shared state for as long as it is bound, and two tests rotating it
    /// would race over which password is live.
    #[tokio::test]
    async fn rotating_leaves_the_newest_password_the_only_one_that_opens_the_brain() {
        let (url, demo) = brain_and_handle(None);
        assert_eq!(bearer_status(&url, DEFAULT_TOKEN).await, 200);
        assert_eq!(demo.auth_token(), DEFAULT_TOKEN, "an unrotated brain answers to the default");

        demo.rotate_to("first-new-password");
        assert_eq!(bearer_status(&url, "first-new-password").await, 200);
        assert_eq!(
            bearer_status(&url, DEFAULT_TOKEN).await,
            401,
            "the password the brain was opened with must stop working"
        );
        assert_eq!(
            bearer_status(&url, "something-else-entirely").await,
            401,
            "once a password is set the brain must stop accepting anything non-empty"
        );
        assert_eq!(config_status(&url, Some("Bearer ")).await, 401);
        assert_eq!(demo.auth_token(), "first-new-password");

        // Rotating again: only the newest survives, or a leaked password would
        // be re-usable after the user changed it a second time.
        demo.rotate_to("second-new-password");
        assert_eq!(bearer_status(&url, "second-new-password").await, 200);
        assert_eq!(bearer_status(&url, "first-new-password").await, 401);
        assert_eq!(bearer_status(&url, DEFAULT_TOKEN).await, 401);
        assert_eq!(demo.auth_token(), "second-new-password");
    }

    /// The propagation window the health gate exists for. A real secret is not
    /// live when the PUT returns, so `rotate_secret` must retry through 401s
    /// rather than treat the first one as terminal the way `update_worker` does
    /// — and against a brain that switches instantly, both implementations pass.
    #[tokio::test]
    async fn a_delayed_rotation_keeps_the_old_password_working_until_the_new_one_lands() {
        const REFUSALS: u64 = 3;
        let (url, demo) = brain_and_handle(Some(REFUSALS));

        // The first rotation has nothing live to fall back to, so the brain stays
        // permissive — except for the password that has not landed yet.
        demo.rotate_to("old-password");
        for attempt in 1..=REFUSALS {
            assert_eq!(
                bearer_status(&url, "old-password").await,
                401,
                "attempt {attempt} of {REFUSALS} must still be refused"
            );
        }
        assert_eq!(
            bearer_status(&url, "old-password").await,
            200,
            "the password must land once the refusals are spent"
        );

        // The second rotation replaces a live password, which is the case the
        // app is actually in: the old one carries it through the window the
        // health gate spends polling.
        demo.rotate_to("new-password");
        for attempt in 1..=REFUSALS {
            // Checked before the refusal, not after: the attempt that spends the
            // last refusal is the one that lands the new password, so the old one
            // is already retired by the time that call returns.
            assert_eq!(
                bearer_status(&url, "old-password").await,
                200,
                "the old password must keep working while the new one is in flight"
            );
            assert_eq!(demo.auth_token(), "old-password");
            assert_eq!(
                bearer_status(&url, "new-password").await,
                401,
                "attempt {attempt} of {REFUSALS} must still be refused"
            );
        }

        assert_eq!(bearer_status(&url, "new-password").await, 200);
        assert_eq!(
            bearer_status(&url, "old-password").await,
            401,
            "landing must retire the password it replaced"
        );
        assert_eq!(demo.auth_token(), "new-password");
    }

    /// The propagation delay belongs to a rotation and to nothing else.
    ///
    /// A fresh deploy carries `AUTH_TOKEN` in its upload metadata, so the Worker
    /// comes up already holding it — there is nothing to propagate. Delaying it
    /// anyway aims [`ROTATE_ENV`] at `provision`'s health poll, which treats a
    /// 401 as terminal: with the variable exported, first-time demo setup died
    /// with "Something went wrong" and the retry loop the variable exists to
    /// exercise was never reached. A knob for demonstrating one screen must not
    /// break the flow that leads to it.
    #[tokio::test]
    async fn a_password_that_arrives_with_a_deploy_is_live_at_once_even_with_the_delay_set() {
        let (url, demo) = brain_and_handle(Some(3));

        demo.deployed_with("deployed-password");
        assert_eq!(
            bearer_status(&url, "deployed-password").await,
            200,
            "a deployed password has nothing to propagate and must work at once"
        );

        // …and the knob still does its job on the path it is for.
        demo.rotate_to("rotated-password");
        assert_eq!(
            bearer_status(&url, "rotated-password").await,
            401,
            "a rotation must still spend its refusals, or the retry loop the \
             variable exists to exercise is never exercised"
        );
    }

    /// Loading the demo dashboard page must not spend a propagation attempt.
    ///
    /// `is_authenticated` is a *write* while a rotation is in flight — it spends
    /// one of the refusals the new password owes — and the placeholder page is
    /// unguarded, so asking the question at all is pure cost. It used to be
    /// asked before the page's early return, which made a window that happened to
    /// load the page land the new password sooner than the demo was set up to
    /// require.
    #[tokio::test]
    async fn loading_the_placeholder_page_does_not_spend_a_propagation_attempt() {
        const REFUSALS: u64 = 2;
        let (url, demo) = brain_and_handle(Some(REFUSALS));
        demo.rotate_to("new-password");

        let client = reqwest::Client::new();
        for path in ["/", "/index.html", "/"] {
            let resp = client
                .get(format!("{url}{path}"))
                .bearer_auth("new-password")
                .send()
                .await
                .expect("request");
            assert_eq!(resp.status().as_u16(), 200, "{path} is an unguarded page");
        }

        for attempt in 1..=REFUSALS {
            assert_eq!(
                bearer_status(&url, "new-password").await,
                401,
                "attempt {attempt} of {REFUSALS}: the page loads must not have \
                 spent any of the refusals"
            );
        }
        assert_eq!(bearer_status(&url, "new-password").await, 200);
    }

    /// The mechanism every password test outside this file relies on.
    ///
    /// A test that rotates the process-wide brain changes the password every
    /// other test in the process is sending, and the harness runs them in
    /// parallel — a race that only shows up on a machine with enough cores. A
    /// scoped brain is how such a test stays local; if the binding silently
    /// stopped taking effect, those tests would go back to rotating the global
    /// one and the flake would return with nothing to point at.
    #[tokio::test]
    async fn a_scoped_brain_stands_in_for_the_process_wide_one() {
        let process_wide = base_url();
        {
            let scoped = scoped_brain();
            assert_ne!(scoped.base_url(), process_wide, "a brain of its own");
            assert_eq!(base_url(), scoped.base_url(), "and the one handed out");

            rotate_to("a-password-only-this-test-sets");
            assert_eq!(auth_token(), "a-password-only-this-test-sets");
            assert_eq!(
                bearer_status(scoped.base_url(), "a-password-only-this-test-sets").await,
                200,
                "the rotation must have reached the scoped brain"
            );
        }

        assert_eq!(base_url(), process_wide, "dropping the guard gives it back");
        assert_ne!(
            auth_token(),
            "a-password-only-this-test-sets",
            "the process-wide brain must not have been touched"
        );
    }

    #[test]
    fn the_rotation_delay_is_off_unless_the_env_var_names_an_attempt_count() {
        assert_eq!(parse_pending_attempts(None), None);
        assert_eq!(parse_pending_attempts(Some("")), None);
        assert_eq!(parse_pending_attempts(Some("nonsense")), None);
        // Landing at once is the default, not a delay of no length.
        assert_eq!(parse_pending_attempts(Some("0")), None);
        assert_eq!(parse_pending_attempts(Some("2")), Some(2));
        assert_eq!(parse_pending_attempts(Some(" 2 ")), Some(2));
    }

    /// `rotate_to` has to reach the brain the app is talking to, not an instance
    /// a test happened to bind: a dry-run rotation calls the free function and
    /// then polls `base_url()`, and a rotation that missed would look like a
    /// clean pass.
    ///
    /// It rotates to [`DEFAULT_TOKEN`] deliberately. This brain is process-wide
    /// and outlives the test, so rotating it to anything else would start 401ing
    /// whatever else is mid-request against it; rotating it to the token every
    /// caller already sends changes nothing for them while still proving the
    /// enforcement is now on.
    #[tokio::test]
    async fn rotate_to_reaches_the_brain_the_app_is_handed() {
        let url = base_url();
        rotate_to(DEFAULT_TOKEN);

        // The shape of the health gate itself: poll with the new password until
        // it authenticates, bounded so a rotation that never lands fails the
        // test rather than hanging it. More than one attempt only when the
        // propagation delay is exported into the test run.
        let mut attempts = 0;
        while bearer_status(&url, DEFAULT_TOKEN).await != 200 {
            attempts += 1;
            assert!(attempts < 20, "the rotated password never took effect");
        }
        assert_eq!(auth_token(), DEFAULT_TOKEN);
        assert_eq!(
            bearer_status(&url, "not-the-demo-password").await,
            401,
            "the process-wide brain must enforce the password it was rotated to"
        );
    }

    // ── Migration ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn the_estimate_reports_a_plausible_brain_through_the_apps_own_parser() {
        let url = brain();
        let est = crate::migration::fetch_estimate(&url, "demo", 384, Locale::En)
            .await
            .expect("estimate");
        // Pinned as literals, not against the constants: comparing a constant to
        // itself would pass whatever the demo brain claimed to hold, and the
        // whole point of these numbers is that they look like a real brain.
        assert_eq!(est.entries, 1620);
        assert_eq!(est.chunks_at_least, 2100);
        assert_eq!(est.current_model, DEMO_EMBEDDING_MODEL);
    }

    #[tokio::test]
    async fn status_is_null_until_a_rebuild_starts_then_carries_what_the_window_reads() {
        let url = brain();
        let before = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert!(before["state"].is_null(), "no rebuild has ever been started");
        assert_eq!(before["model"], json!(DEMO_EMBEDDING_MODEL));

        crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");

        let after = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        let state = &after["state"];
        assert!(!state.is_null(), "a started rebuild must be on record");
        // The keys installer/src/settings.ts reads off MigrationRun.
        for key in ["model", "processed", "failed", "totalAtStart", "cursorId"] {
            assert!(state.get(key).is_some(), "the window reads state.{key}, which is absent");
        }
        assert!(
            state.get("finishedAt").is_none(),
            "an unfinished rebuild must not look finished"
        );
    }

    /// The rebuild has to take many batches, or the progress bar and the k-of-n
    /// counter are never exercised by a demo.
    #[tokio::test]
    async fn a_rebuild_takes_many_batches_and_only_finishes_once_nothing_is_left() {
        let url = brain();
        let mut batches = 0;
        let mut last_remaining = u64::MAX;
        let mut processed_total = 0;
        loop {
            let p = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
            batches += 1;
            assert!(!p.stalled, "the default demo must run to completion");
            assert_eq!(p.total, 1620, "the bar counts up to the owner's brain size");
            assert!(
                p.remaining < last_remaining,
                "progress must advance: {} then {}",
                last_remaining,
                p.remaining
            );
            last_remaining = p.remaining;
            processed_total += p.processed;
            if p.done {
                assert_eq!(p.remaining, 0, "done must never be true with work left");
                break;
            }
            assert!(p.remaining > 0, "remaining reached 0 without done being set");
            assert!(batches < 500, "runaway loop");
        }
        assert!(batches > 10, "a one-batch rebuild proves nothing, got {batches}");
        assert_eq!(processed_total, 1620, "every entry must be accounted for");

        let status = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert!(
            status["state"]["finishedAt"].is_u64(),
            "a completed rebuild must be recorded as finished"
        );
    }

    /// The "Paused for today" screen, which is otherwise untestable. Progress is
    /// kept, and resuming carries on rather than pausing again.
    #[tokio::test]
    async fn the_stall_gate_pauses_once_with_progress_kept_then_resumes_to_completion() {
        let url = brain_with(Options {
            batch_pause: Duration::ZERO,
            stall_after: Some(3),
            ..Options::default()
        });

        let mut before = 0;
        for _ in 0..3 {
            let p = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
            assert!(!p.stalled);
            before = ENTRIES - p.remaining;
        }
        assert!(before > 0, "there must be progress to keep");

        let paused = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        assert!(paused.stalled, "the fourth batch must pause");
        assert!(!paused.done);
        assert_eq!(paused.processed, 0, "a paused batch achieves nothing");
        assert_eq!(
            ENTRIES - paused.remaining,
            before,
            "pausing must keep the cursor, not lose it"
        );

        // Resume: one pause per demo, so the rest of the rebuild completes.
        let mut batches = 0;
        loop {
            let p = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
            batches += 1;
            assert!(!p.stalled, "resuming must not pause again");
            if p.done {
                break;
            }
            assert!(batches < 500, "runaway loop");
        }
    }

    #[tokio::test]
    async fn reset_clears_the_ledger_so_status_reads_null_again() {
        let url = brain();
        crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        crate::migration::reset(&url, "demo", Locale::En).await.expect("reset");
        let status = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert!(status["state"].is_null(), "the ledger must be gone");
    }

    /// A target change mid-run invalidates the cursor: the entries behind it hold
    /// vectors from the previous model. `runBatch` restarts, and so must this.
    #[tokio::test]
    async fn changing_the_target_model_restarts_the_rebuild() {
        let url = brain();
        for _ in 0..3 {
            crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        }
        let partway = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        assert!(partway.remaining < ENTRIES);

        crate::migration::patch_embedding_model(&url, "demo", "@cf/baai/bge-base-en-v1.5", Locale::En)
            .await
            .expect("model write");

        let restarted = crate::migration::run_batch(&url, "demo", Locale::En).await.expect("batch");
        assert_eq!(
            restarted.remaining,
            ENTRIES - restarted.processed,
            "a new target must rebuild from the beginning"
        );

        let status = crate::migration::fetch_status(&url, "demo", Locale::En).await.expect("status");
        assert_eq!(status["state"]["model"], json!("@cf/baai/bge-base-en-v1.5"));
        assert_eq!(status["model"], json!("@cf/baai/bge-base-en-v1.5"));
    }

    /// The estimate follows the config, so the migration pane reflects a model
    /// change instead of showing the old one forever.
    #[tokio::test]
    async fn the_estimate_follows_the_model_in_force() {
        let url = brain();
        crate::migration::patch_embedding_model(&url, "demo", "@cf/baai/bge-large-en-v1.5", Locale::En)
            .await
            .expect("model write");
        let est = crate::migration::fetch_estimate(&url, "demo", 384, Locale::En).await.expect("estimate");
        assert_eq!(est.current_model, "@cf/baai/bge-large-en-v1.5");
    }

    // ── Everything else that must not break ─────────────────────────────────

    #[tokio::test]
    async fn health_answers_the_shape_the_version_check_reads() {
        let url = brain();
        let (status, body) = get(&url, "/health").await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], json!(true));
        assert!(body["version"].is_string(), "the update check reads version");
        assert_eq!(body["vectorize"]["ok"], json!(true));
        assert_eq!(
            body["vectorize"]["indexName"],
            json!(crate::worker_bundle::manifest().vectorize_name)
        );
    }

    /// Health names the index the brain is actually reading, so a demo migration
    /// changes it the way a real one does.
    #[tokio::test]
    async fn health_names_the_index_the_current_model_implies() {
        let url = brain();
        crate::migration::patch_embedding_model(&url, "demo", "@cf/baai/bge-base-en-v1.5", Locale::En)
            .await
            .expect("model write");
        let (_, body) = get(&url, "/health").await;
        assert_eq!(body["vectorize"]["dimensions"], json!(768));
        assert!(
            body["vectorize"]["indexName"].as_str().expect("string").ends_with("-768"),
            "got {}",
            body["vectorize"]["indexName"]
        );
    }

    #[tokio::test]
    async fn an_unknown_route_is_a_404_the_way_the_worker_answers_one() {
        let url = brain();
        let (status, _) = post(&url, "/nope").await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn a_query_string_does_not_stop_a_route_matching() {
        let url = brain();
        let (status, body) = get(&url, "/config?t=1").await;
        assert_eq!(status, 200);
        assert!(body["config"].is_object());
    }

    /// `dashboard_credentials` hands this address to the wrapper window too, so
    /// opening the dashboard in demo mode must land on something, not a blank
    /// page.
    #[tokio::test]
    async fn the_root_serves_a_page_for_the_dashboard_window() {
        let url = brain();
        let resp = reqwest::Client::new().get(&url).send().await.expect("request");
        assert_eq!(resp.status().as_u16(), 200);
        let body = resp.text().await.expect("body");
        assert!(body.contains("Demo brain"), "got: {body}");
    }

    #[test]
    fn the_stall_gate_is_off_unless_the_env_var_names_a_batch_count() {
        assert_eq!(parse_stall_after(None), None);
        assert_eq!(parse_stall_after(Some("")), None);
        assert_eq!(parse_stall_after(Some("nonsense")), None);
        // 0 would pause before any progress exists to resume from.
        assert_eq!(parse_stall_after(Some("0")), None);
        assert_eq!(parse_stall_after(Some("3")), Some(3));
        assert_eq!(parse_stall_after(Some(" 3 ")), Some(3));
    }

    #[test]
    fn the_cursor_advances_forwards_through_time() {
        let now = 1_700_000_000_000;
        let first = cursor_time(20, ENTRIES, now);
        let later = cursor_time(1600, ENTRIES, now);
        assert!(first < later, "{first} !< {later}");
        assert!(later <= now, "the cursor cannot reach into the future");
        // Must not divide by zero on an empty brain.
        assert!(cursor_time(0, 0, now) <= now);
    }

    /// Demo mode asks for this address before any window opens, and must never
    /// be handed one with nothing behind it.
    #[tokio::test]
    async fn base_url_hands_out_a_running_server() {
        let url = base_url();
        assert!(url.starts_with("http://127.0.0.1:"), "got {url}");
        assert_eq!(url, base_url(), "the address must be stable across calls");

        // Polled rather than asserted once, and only past a 401.
        //
        // This is the *process-wide* brain, which one test has to rotate —
        // `rotate_to_reaches_the_brain_the_app_is_handed`, whose whole subject is
        // that `rotate_to` reaches the brain the app is handed. With
        // `SECOND_BRAIN_DEMO_ROTATE_AFTER` exported that rotation opens a window
        // several requests long in which the brain refuses exactly the token
        // every other caller sends, and this test would then be reporting that
        // test's timing rather than anything about `base_url`.
        //
        // Nothing is weakened: a 401 is itself proof that a brain answered, which
        // is what this asserts, and an address with nothing behind it still fails
        // — `get` panics on a connection that goes nowhere.
        let mut status;
        let mut body;
        let mut attempts = 0;
        loop {
            (status, body) = get(&url, "/config").await;
            if status != 401 {
                break;
            }
            attempts += 1;
            assert!(attempts < 20, "the address never authenticated anyone");
        }
        assert_eq!(status, 200, "base_url returned an address nothing is serving");
        assert!(body["config"].is_object());
    }
}
