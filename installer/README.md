# Second Brain Desktop

The no-terminal way to get a Second Brain. A small desktop app (Tauri v2: Rust core + webview UI) that:

1. **First run — setup.** Walks through six plain-language screens and provisions a complete Second Brain into the **user's own Cloudflare account** using Cloudflare's REST API directly. No wrangler, no Node runtime, no git — the app bundles the exact Worker build it ships with and deploys it over HTTPS. Users who already have a Second Brain (set up on another computer, or deployed the git way) take the **"Already have a Second Brain?"** path instead, which offers two routes. **Sign in with Cloudflare** finds the brain for them: it reads the account's Worker list and identifies the brain from its *bindings* (a Vectorize index named `second-brain-vectors` plus a D1 database) rather than from anything the Worker says about itself over HTTP — a Worker can forge an HTTP response, but not its own bindings, and whatever is picked is what the user's password gets sent to. **Enter the address myself** is unchanged and still involves no Cloudflare sign-in: address + password, validated against the live Worker (`/health`, falling back to `/count` for deployments that predate the health endpoint). Either way nothing in the account is written, and the user types their own password — Cloudflare secrets are write-only, so an existing `AUTH_TOKEN` can never be read back.
2. **Every run after — the app.** Boots straight into the user's own Worker-hosted dashboard in a native window, pre-authenticated from OS-secure storage, with a **Connection details** window (menu bar → Connections, or the tray icon) that always shows the two URLs they need: their dashboard address and their `/mcp` connector link.

Non-technical users should download the signed installers from the [latest GitHub Release](../../../releases/latest) — everything below is for developers and maintainers.

---

## Build & run locally

### Prerequisites

| What | Why | Install |
| --- | --- | --- |
| Rust (stable, 1.82+) | the app core | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js 20+ | UI build + Worker bundling | [nodejs.org](https://nodejs.org) |
| Tauri system deps | webview toolchain | macOS: Xcode Command Line Tools (`xcode-select --install`). Windows: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (preinstalled on Windows 10 1803+). |

### Run in development

```bash
# from the repository root — the Worker bundle resolves the Worker's deps here
npm install --legacy-peer-deps

cd installer
npm install
npm run tauri dev
```

`tauri dev` automatically runs `npm run bundle-worker` first, which:
- bundles `../src/index.ts` + dependencies into a single ES module (`src-tauri/worker-dist/worker.js`),
- copies the dashboard from `../public/` into `src-tauri/worker-dist/assets/`,
- derives the binding manifest (`worker-dist/manifest.json`) from `../wrangler.jsonc`.

The Rust core embeds `worker-dist/` at compile time, so the app always deploys exactly the Worker version it was built from.

### Demo the whole flow without a Cloudflare account

```bash
SECOND_BRAIN_DRY_RUN=1 npm run tauri dev        # macOS/Linux
$env:SECOND_BRAIN_DRY_RUN="1"; npm run tauri dev  # Windows PowerShell
```

Dry-run mode fakes every Cloudflare call (short pauses, canned results), skips the browser sign-in, and never touches the keychain or real tool configs. A "Demo mode" badge shows in the corner.

### Test against a real Cloudflare account

Run without the env var, click through setup, and sign in with a real (or throwaway) Cloudflare account. Everything provisioning creates is free-tier and idempotent; to fully undo a test run, delete in the Cloudflare dashboard: the `second-brain` Worker, the `second-brain-db` D1 database, the `second-brain-oauth` KV namespace, and the `second-brain-vectors` Vectorize index. To make the app forget a completed setup, delete the `com.secondbrain.desktop` entries from Keychain Access (macOS) or Credential Manager (Windows).

### Tests

```bash
cd installer
npm run bundle-worker                       # tests embed the bundle
cargo test --manifest-path src-tauri/Cargo.toml
npm run build                               # typechecks + builds the UI
```

### Local unsigned build

```bash
cd installer
npm run tauri build          # add: -- --target universal-apple-darwin for a universal Mac binary
```

Artifacts land under `src-tauri/target/release/bundle/` (`dmg`/`macos` on macOS; `nsis` on Windows). With no signing configured the output is unsigned — fine for personal testing; macOS will require right-click → Open, Windows will show SmartScreen warnings. **Never ship unsigned builds to users.**

---

## Get and add the signing certificates (one-time maintainer runbook)

CI signs releases using GitHub Secrets. Until the secrets exist, tagged builds still succeed but produce unsigned artifacts labeled as testing-only in the job log.

### macOS — Developer ID certificate + notarization

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) (~$99/yr, individual or org).
2. Create a **Developer ID Application** certificate (Developer portal → Certificates → "+" → Developer ID Application — *not* "Mac App Distribution"; that's App Store-only). Generate the CSR via Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority.
3. Download + double-click to install it, confirm it shows in Keychain Access as `Developer ID Application: Your Name (TEAMID)`.
4. Export as `.p12`: Keychain Access → My Certificates → right-click → Export → set a strong export password.
5. Base64-encode it: `base64 -i certificate.p12 | pbcopy`.
6. Create an **app-specific password** at [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords.
7. Find your **Team ID** in the Developer portal → Membership details.
8. Add the GitHub Secrets (repo → Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the base64 `.p12` from step 5 |
| `APPLE_CERTIFICATE_PASSWORD` | the export password from step 4 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password from step 6 |
| `APPLE_TEAM_ID` | the Team ID from step 7 |

Tauri's bundler imports the certificate into a temporary keychain, signs, notarizes with `notarytool`, and staples — no extra workflow steps. CI then runs `codesign --verify --deep --strict` and `spctl -a -t open --context context:primary-signature` on the artifacts, so a bad signature fails the build instead of shipping.

### Windows — code-signing certificate

Choose one:

- **SignPath Foundation (free for open source)** — wired into the release workflow already; see "For the SignPath route" below. [signpath.org](https://signpath.org) signs qualifying OSS projects at no cost, and prerequisites live in the root README's "Code signing policy" section. Note the signature carries SignPath Foundation's certificate, not your own identity, so Windows shows *SignPath Foundation* as the publisher.
- **OV (Organization Validation)** — cheaper and file-based, works on hosted runners as-is. Downside: SmartScreen keeps warning users until the binary earns download reputation, which takes time. Acceptable to start.
- **EV (Extended Validation)** — clears SmartScreen immediately (best for this audience), but the private key must live on a FIPS hardware token or cloud HSM. A hardware token **cannot** be plugged into GitHub's hosted runners — you need either a cloud-signing service (e.g. Azure Artifact Signing, SSL.com eSigner, DigiCert KeyLocker — anything with a CI-callable API) wired in through `bundle.windows.signCommand` in `tauri.conf.json`, or a self-hosted runner with the token attached.

For the OV route:

1. Purchase from a recognized CA (DigiCert, Sectigo, SSL.com, …) and complete business/identity validation.
2. Export the certificate + key as a password-protected `.pfx`.
3. Base64-encode: `base64 -i certificate.pfx | pbcopy` (macOS) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard` (PowerShell).
4. Add the secrets:

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | the base64 `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | its export password |

The Windows job imports the `.pfx`, points Tauri at its thumbprint, timestamps against DigiCert, and verifies with `signtool verify /pa /v` so a bad signature fails CI.

For the EV/cloud route: skip those two secrets, store the provider's API credentials as secrets instead, and replace the "Enable Windows signing" step with the provider's CLI plus a `signCommand` config (e.g. `"signCommand": "artifact-signing-cli -e https://…azure.net -a Account -c Profile -d SecondBrain %1"`). Document which route is active here when you set it up.

For the SignPath route:

1. Apply at [signpath.org](https://signpath.org) and wait for your project to be provisioned. You get two signing policies: `test-signing`, backed by a **self-signed** certificate that Windows does not trust, and `release-signing`, backed by SignPath Foundation's real certificate. `release-signing` shows **INVALID** until the CA issues that certificate — that is normal and needs nothing from you.
2. In SignPath, link the predefined **GitHub.com** trusted build system to your organization and to the project, and install the **SignPath GitHub App** on the repository. Origin verification depends on both.
3. Create an API token for the CI user (SignPath → *Users* → the CI user → *API tokens*).
4. Add one secret and three repository variables (Settings → Secrets and variables → Actions):

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | the CI user's API token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | from the SignPath organization page |
| Variable | `SIGNPATH_PROJECT_SLUG` | e.g. `second-brain-cloudflare` |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | `test-signing` while validating, then `release-signing` |

`SIGNPATH_SIGNING_POLICY_SLUG` defaults to `test-signing` when unset. Leaving `WINDOWS_CERTIFICATE` unset is what selects this route — a `.pfx` takes precedence if both are configured.

Because SignPath's key lives in an HSM, the installer is signed **after** the build rather than during bundling, and two things have to be repaired afterwards. Both are handled by the workflow, and both are silent if you get them wrong:

- **The updater signature.** `tauri-action` signs the *unsigned* installer's bytes, so the signature no longer matches once SignPath has signed it. The workflow regenerates the `.sig` over the signed file.
- **The updater URL.** `latest.json` addresses assets by numeric id (`…/releases/assets/504326110`), and replacing an asset deletes it and mints a new id. The `publish` job re-derives both the URL and the signature from the release's live state.

While `SIGNPATH_SIGNING_POLICY_SLUG` is `test-signing`, dispatch builds sign with the test certificate and CI asserts only that a signature is present — `signtool verify /pa` cannot succeed against a self-signed certificate, so requiring it would prove nothing. Tag builds under a test policy publish **unsigned**, with a warning in the job output: a test-signed installer reaching users would read as a mistake, but a release should not be hostage to the certificate's issuance either. Verification tightens to a full chain check automatically when you switch to `release-signing`. Signing requests under `release-signing` also wait for your approval in the SignPath dashboard; the workflow allows an hour.

### In-app updates — updater signing key (one-time)

The app updates itself via `tauri-plugin-updater`. Updates are verified against a **minisign key** that is separate from the Apple/Windows code-signing certs above. Until you set this up, releases build without update artifacts and the in-app updater simply finds nothing — everything else still works.

1. Generate the keypair once (from `installer/`):

   ```bash
   npm run tauri signer generate -- -w ~/.tauri/second-brain-updater.key
   ```

   Choose a password when prompted (it protects the private key). This writes:
   - `~/.tauri/second-brain-updater.key` — **private key**, never commit or share.
   - `~/.tauri/second-brain-updater.key.pub` — **public key**, safe to commit.

2. Replace the `pubkey` value in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) with the **full contents** of `second-brain-updater.key.pub`. The repo currently ships a development placeholder; CI **fails on purpose** if you enable updates without replacing it.

   ```bash
   cat ~/.tauri/second-brain-updater.key.pub
   ```

3. Add two GitHub Secrets:

   | Secret | Value |
   | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `second-brain-updater.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |

4. Back up the private key + password (a password manager). **If you lose them, you can never ship another auto-update** — users would have to re-download manually.

The release workflow enables `createUpdaterArtifacts` and uploads `latest.json` automatically whenever `TAURI_SIGNING_PRIVATE_KEY` is present. The app's update endpoint is the repo's `releases/latest/download/latest.json`. In-app updates become functional starting from the **first release built with the key in place** — users on an earlier build download that one manually once, and every release after updates in-app.

### Cut a release

The version does **not** auto-increment. Bump it first in `src-tauri/tauri.conf.json` (`"version"`) — that value names the artifacts (`Second Brain_X.Y.Z_….dmg`) and fills the release title. Keep `src-tauri/Cargo.toml` and `package.json` in step with it for tidiness (they don't drive the release, but drift is confusing). Then commit, and tag **matching that version** — the tag itself is what triggers the workflow, and a tag that disagrees with the config produces a release whose title and filenames don't match its tag:

```bash
# 1. bump "version" in src-tauri/tauri.conf.json (+ Cargo.toml, package.json)
# 2. commit, then:
git tag installer-v0.1.0
git push origin installer-v0.1.0
```

Two jobs build in parallel (macOS universal binary; Windows NSIS installer), each verifies its signature, and the GitHub Release stays a **draft** until both succeed — a published release never contains just one platform. Test end-to-end with an `installer-v0.0.x-test` tag before announcing anything.

---

## Releasing

npm scripts (run from the repo root) automate the mechanical parts of a release — version bumps, the PR, and the tag that triggers CI. They never auto-merge: you write the change, commit + push your branch, and click Merge yourself.

First: make your change on a feature branch, commit, and push it. Then:

| Command | For |
| --- | --- |
| `npm run deploy:worker -- <version\|patch\|minor\|major>` | A Worker-only change. Bumps `SB_VERSION`, commits, pushes, opens a PR. Merge it and Cloudflare-button/manual deployers get it. (App users get it in the next app release.) |
| `npm run deploy:app -- <version\|patch\|minor\|major>` | An app change (or to ship a Worker change to app users). Bumps the installer version, commits, pushes, opens a PR — then **waits for you to merge**, and once merged tags `installer-v…` so CI builds, signs, and publishes. |
| `npm run deploy:all -- <app-version> <worker-version>` | Both at once, in one PR. |
| `npm run deploy:tag -- <version>` | Finisher: tag `installer-v<version>` on the current `origin/main`. Use it if you Ctrl-C'd the wait and merged later. |

The scripts require a clean working tree (commit first), tag `origin/main`'s exact commit after fetching (never local `main`), and verify the merged version matches before tagging. Version args accept an explicit `x.y.z` or a `patch`/`minor`/`major` keyword. Prefix any command with `DRY_RUN=1` to preview without touching git or GitHub.

For a Worker change meant for everyone, `deploy:all` is the one-shot; the [Worker versioning](#worker-versioning) section below explains why app users need the app release to receive it.

## Worker versioning

The app can update a user's deployed Worker in place (preserving their memories, password, and connections). It decides whether an update is available by comparing the version the deployed Worker reports at `GET /health` against the version this app bundles.

The source of truth is a single constant, **`SB_VERSION`** in `src/index.ts` (currently `2.0.0`), echoed by `/health`. The installer's bundle step reads that same constant into its manifest, so both sides always agree.

To ship a Worker change:

1. Make the change in `src/index.ts`.
2. Bump `SB_VERSION` (semver: patch / minor / major).
3. PR → squash-merge to `main`.
4. Tag `worker-v<version>` (e.g. `worker-v2.1.0`) to mark the release — a marker for history, not a trigger.

**How each audience receives it:** Cloudflare-button and manual deployers get the change when they redeploy from `main`. **Desktop-app users get it only when a new `installer-v*` release repackages it** — the app bundles the Worker at build time and never fetches it from the repo. So a Worker change intended for app users needs both the `SB_VERSION` bump *and* a following installer release; bump the installer version too so they travel together. Once a user's app updates and thus bundles the newer Worker, the app offers to redeploy it into their Cloudflare account.

## Security model

- **The user's password (`AUTH_TOKEN`)** — typed on screen 2, held in Rust memory during setup, sent once to Cloudflare as the Worker secret, then stored only in the OS keychain (macOS Keychain / Windows Credential Manager) as `com.secondbrain.desktop`. Never written to disk in plaintext, never displayed again by the app.
- **The Cloudflare OAuth token** — obtained in the Rust core via PKCE; access + refresh tokens live in memory for the duration of setup and are **not persisted at all**. The wrapper app talks only to the user's Worker, never to Cloudflare's API.
- **The webview** never receives tokens. The one deliberate exception: the wrapper window injects `sb_url`/`sb_token` into the **user's own dashboard origin** (via an origin-guarded initialization script) so the dashboard is signed in on launch — this mirrors exactly how the dashboard stores its session when the user logs in manually, and the value never touches any other origin. The wrapper window has no access to Tauri IPC.
- **No telemetry.** The app makes requests only to `dash.cloudflare.com` / `api.cloudflare.com` (setup) and the user's own `*.workers.dev` Worker. Brain discovery adds no new hosts: it reads the Cloudflare API and contacts no Worker at all.
- Provisioning is **idempotent**: every step checks for the resource before creating it, so "Try again" never duplicates anything and a half-finished setup resumes cleanly.

## Cloudflare API audit

Everything the installer ever calls, for auditability:

| Call | Purpose |
| --- | --- |
| `GET /accounts` | resolve the account to set up in |
| `GET /accounts/{a}/workers/scripts` | list Workers, to find an existing brain by name |
| `GET /accounts/{a}/workers/scripts/{s}/settings` | read a script's bindings — how an existing brain is identified |
| `GET/PUT /accounts/{a}/workers/subdomain` | read / register the account's `workers.dev` address |
| `GET/POST /accounts/{a}/d1/database` | find-or-create the `second-brain-db` database |
| `GET/POST /accounts/{a}/storage/kv/namespaces` | find-or-create the `second-brain-oauth` namespace |
| `GET/POST /accounts/{a}/vectorize/v2/indexes` | find-or-create the vector index the deploy binds (384 dims, cosine by default) |
| `GET /accounts/{a}/vectorize/v2/indexes/{i}` | read an index's real dimensions and metric, rather than trusting the manifest |
| `GET /accounts/{a}/vectorize/v2/indexes/{i}/info` | vector count and indexing progress — how a rebuild is verified before the old index is dropped |
| `DELETE /accounts/{a}/vectorize/v2/indexes/{i}` | delete the superseded index after an embedding-model change, only on explicit confirmation |
| `POST /accounts/{a}/workers/scripts/second-brain/assets-upload-session` | start the dashboard asset upload |
| `POST /accounts/{a}/workers/assets/upload?base64=true` | upload dashboard files |
| `PUT /accounts/{a}/workers/scripts/second-brain` | deploy the Worker (multipart: module + metadata with D1/Vectorize/KV/AI bindings, `VECTORIZE_GRACE_MS` var, `AUTH_TOKEN` secret, assets) |
| `PUT /accounts/{a}/workers/scripts/second-brain/schedules` | nightly maintenance (`0 1 * * *`) and hourly integration sync (`30 * * * *`) crons |
| `POST /accounts/{a}/workers/scripts/second-brain/subdomain` | turn on the `workers.dev` URL |
| `GET {worker}/health`, `POST {worker}/capture` | post-deploy smoke tests against the user's own Worker |

OAuth: authorization-code + PKCE (S256) against `dash.cloudflare.com/oauth2/{auth,token}`, loopback redirect `http://localhost:8976/oauth/callback`. Scopes requested — `account:read user:read workers:write workers_scripts:write workers_kv:write d1:write ai:write vectorize:write offline_access`.

One scope set is used for every OAuth flow, including the brain lookup on the existing-brain path, which by itself only issues the three `GET`s in the table above. That is deliberate: **a narrower set would only postpone the same grant.** Connecting an existing brain is a step towards using the app, and the next Worker update needs the write scopes in full — `update_worker` calls `create_d1`, `create_kv`, `create_vectorize`, `deploy_worker`, `set_cron` and `enable_script_subdomain`, and `runWorkerUpdate` re-runs the sign-in flow to get a token for them. Splitting the set would mean asking the same user to consent twice, narrowly and then broadly, to arrive where one grant already puts them.

What limits the exposure is not the scope list: the token is never persisted (`secure_store.rs` documents why), it is minted per operation and lives only in memory, the sign-in screen states that Cloudflare will ask for access before the user is sent there, and **Enter the address myself** reaches an existing brain with no Cloudflare sign-in at all.

**Client ID note:** the app currently uses wrangler's published public OAuth client (`54d11594-84e4-41aa-b438-e81b8fa78ee7`) — the same well-known ID community tools like PartyKit embed — because its registered redirect is the localhost loopback above and it is permitted to request every scope we need. Cloudflare added [self-managed OAuth clients](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) in June 2026; to switch to our own registered client (requires publishing the app via Cloudflare's domain-verification flow), change `CLIENT_ID`/`REDIRECT_URI` in `src-tauri/src/cf/oauth.rs` — nothing else about the flow changes.

## Project layout

```
installer/
├── src/                  # webview UI (vanilla TS + Vite): setup flow + details window
├── scripts/bundle-worker.mjs   # esbuild the Worker + copy dashboard + derive manifest
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs        # app assembly: plugins, menu, tray, mode detection
│   │   ├── windows.rs    # setup / wrapper / details window construction
│   │   ├── commands.rs   # the only webview↔core bridge
│   │   ├── secure_store.rs   # Keychain / Credential Manager
│   │   ├── mcp_config.rs # Claude Code + Cursor connector config writer
│   │   ├── worker_bundle.rs  # embedded worker-dist/ + Cloudflare asset hashing
│   │   └── cf/           # types, REST client, OAuth (PKCE), provisioning pipeline
│   └── worker-dist/      # generated by bundle-worker (gitignored)
└── dist/                 # built UI (gitignored)
```
