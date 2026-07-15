#!/usr/bin/env node
// One-command release helpers. Automates the mechanical parts of shipping a
// Worker and/or app change; leaves the two things that are yours: writing the
// change, and clicking Merge (no auto-merge). See installer/README "Releasing".
//
//   npm run deploy:worker -- <version|patch|minor|major>
//       Bump SB_VERSION, commit, push, open a PR to main. For self-hosters.
//   npm run deploy:app    -- <version|patch|minor|major>
//       Bump the installer version, commit, push, open a PR; wait for you to
//       merge, then tag installer-v<version> so CI builds + publishes.
//   npm run deploy:all    -- <app-version|bump> <worker-version|bump>
//       Both bumps in one PR, then wait-for-merge → tag.
//   npm run deploy:tag    -- <version>
//       Finisher: tag installer-v<version> on the current origin/main (use if
//       you skipped the wait, e.g. Ctrl-C'd deploy:app after merging later).
//
// Add DRY_RUN=1 to print what would happen without touching git/GitHub.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = !!process.env.DRY_RUN;
const POLL_SECONDS = 10;
const POLL_MAX_MINUTES = 45;

const WORKER_SRC = resolve(ROOT, "src/index.ts");
const APP_VERSION_FILES = {
  tauriConf: resolve(ROOT, "installer/src-tauri/tauri.conf.json"),
  installerPkg: resolve(ROOT, "installer/package.json"),
  cargoToml: resolve(ROOT, "installer/src-tauri/Cargo.toml"),
};

// ── small helpers ─────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  if (DRY && !opts.always) {
    console.log(`  [dry-run] ${cmd}`);
    return "";
  }
  return execSync(cmd, { cwd: ROOT, stdio: opts.stdio ?? "pipe", encoding: "utf8" }).trim();
}

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

function sleep(seconds) {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

// Resolve "1.2.3" | "patch" | "minor" | "major" against a current version.
function resolveVersion(arg, current) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [maj, min, pat] = current.split(".").map(Number);
  if (arg === "major") return `${maj + 1}.0.0`;
  if (arg === "minor") return `${maj}.${min + 1}.0`;
  if (arg === "patch") return `${maj}.${min}.${pat + 1}`;
  fail(`"${arg}" is not a version or one of: patch, minor, major`);
}

function cmp(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ── version reads/writes ──────────────────────────────────────────────────────

function readWorkerVersion() {
  const m = readFileSync(WORKER_SRC, "utf8").match(
    /export\s+const\s+SB_VERSION\s*=\s*["']([^"']+)["']/,
  );
  if (!m) fail("couldn't find SB_VERSION in src/index.ts");
  return m[1];
}

function writeWorkerVersion(v) {
  const src = readFileSync(WORKER_SRC, "utf8");
  writeFileSync(
    WORKER_SRC,
    src.replace(
      /(export\s+const\s+SB_VERSION\s*=\s*["'])[^"']+(["'])/,
      `$1${v}$2`,
    ),
  );
}

function readAppVersion() {
  return JSON.parse(readFileSync(APP_VERSION_FILES.tauriConf, "utf8")).version;
}

function writeAppVersion(v) {
  for (const key of ["tauriConf", "installerPkg"]) {
    const path = APP_VERSION_FILES[key];
    const json = JSON.parse(readFileSync(path, "utf8"));
    json.version = v;
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  }
  const toml = readFileSync(APP_VERSION_FILES.cargoToml, "utf8");
  writeFileSync(
    APP_VERSION_FILES.cargoToml,
    toml.replace(/^version = "[^"]+"/m, `version = "${v}"`),
  );
  // Keep Cargo.lock in step (prefer cargo; fall back to a targeted edit).
  try {
    run(
      `cargo update -p second-brain-desktop --precise ${v} --manifest-path installer/src-tauri/Cargo.toml`,
    );
  } catch {
    const lockPath = resolve(ROOT, "installer/src-tauri/Cargo.lock");
    const lock = readFileSync(lockPath, "utf8");
    writeFileSync(
      lockPath,
      lock.replace(
        /(name = "second-brain-desktop"\nversion = ")[^"]+(")/,
        `$1${v}$2`,
      ),
    );
  }
}

// ── git / gh ──────────────────────────────────────────────────────────────────

function currentBranch() {
  return run("git rev-parse --abbrev-ref HEAD", { always: true });
}

function assertReadyBranch() {
  const branch = currentBranch();
  if (branch === "main") {
    fail("You're on main. Commit your change to a feature branch and push it first.");
  }
  const dirty = run("git status --porcelain", { always: true });
  if (dirty) {
    fail("Working tree isn't clean. Commit (or stash) your change first, then run this.");
  }
  return branch;
}

function commitPush(message) {
  step(message);
  run(`git commit -aqm ${JSON.stringify(message)}`);
  run("git push -u origin HEAD", { stdio: "inherit" });
}

// Opens a PR if none exists for this branch; returns the PR number + url.
function ensurePr(title, body) {
  const branch = currentBranch();
  let existing = "";
  try {
    existing = run(
      `gh pr view ${branch} --json number,url,state -q '.number+" "+.url+" "+.state'`,
      { always: true },
    );
  } catch {
    /* no PR yet */
  }
  if (existing && existing.endsWith("OPEN")) {
    const [number, url] = existing.split(" ");
    step(`Reusing open PR #${number}`);
    console.log(`  ${url}`);
    return Number(number);
  }
  step("Opening PR to main");
  if (DRY) {
    console.log(`  [dry-run] gh pr create --base main --title ${JSON.stringify(title)}`);
    return 0;
  }
  run(
    `gh pr create --base main --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
    { stdio: "inherit" },
  );
  const number = run(`gh pr view ${branch} --json number -q .number`, { always: true });
  return Number(number);
}

async function waitForMergeThenTag(prNumber, appVersion) {
  const tag = `installer-v${appVersion}`;
  console.log(
    `\n⏳ Waiting for you to merge PR #${prNumber} (merge it in your browser — no auto-merge).`,
  );
  console.log(
    `   Ctrl-C is safe: after merging you can finish anytime with  npm run deploy:tag -- ${appVersion}\n`,
  );
  if (DRY) {
    console.log("  [dry-run] (would poll until merged, then tag)");
    return;
  }
  const deadline = Date.now() + POLL_MAX_MINUTES * 60_000;
  for (;;) {
    const state = run(`gh pr view ${prNumber} --json state -q .state`, { always: true });
    if (state === "MERGED") break;
    if (state === "CLOSED") fail(`PR #${prNumber} was closed without merging. Nothing tagged.`);
    if (Date.now() > deadline) {
      fail(
        `Gave up waiting after ${POLL_MAX_MINUTES} min. After merging, run:  npm run deploy:tag -- ${appVersion}`,
      );
    }
    process.stdout.write(".");
    await sleep(POLL_SECONDS);
  }
  console.log("\n✓ Merged.");
  tagMain(appVersion, tag);
}

// Tags origin/main's exact commit (never local main — avoids the stale-main
// trap) after verifying the merged version matches.
function tagMain(appVersion, tag) {
  step(`Tagging ${tag} on origin/main`);
  run("git fetch origin", { always: true });
  const sha = run("git rev-parse origin/main", { always: true });
  const confAtMain = run(
    `git show origin/main:installer/src-tauri/tauri.conf.json`,
    { always: true },
  );
  const mergedVersion = JSON.parse(confAtMain).version;
  if (mergedVersion !== appVersion) {
    fail(
      `origin/main is at version ${mergedVersion}, not ${appVersion}. Is the PR merged? Re-run once it is.`,
    );
  }
  run(`git tag ${tag} ${sha}`);
  run(`git push origin ${tag}`, { stdio: "inherit" });
  const repo = run("gh repo view --json nameWithOwner -q .nameWithOwner", { always: true });
  console.log(`\n✓ Pushed ${tag}. CI is building the release:`);
  console.log(`  https://github.com/${repo}/actions`);
}

// ── commands ──────────────────────────────────────────────────────────────────

async function deployWorker(arg) {
  if (!arg) fail("Usage: npm run deploy:worker -- <version|patch|minor|major>");
  assertReadyBranch();
  const current = readWorkerVersion();
  const version = resolveVersion(arg, current);
  if (cmp(version, current) <= 0) fail(`SB_VERSION ${version} is not newer than ${current}.`);
  step(`Bumping SB_VERSION ${current} → ${version}`);
  if (!DRY) writeWorkerVersion(version);
  commitPush(`chore: bump SB_VERSION to ${version}`);
  ensurePr(
    `Worker: ${version}`,
    `Bumps \`SB_VERSION\` to ${version}. Merging updates the Worker for Cloudflare-button and manual deployers. Desktop-app users get it in the next app release.`,
  );
  console.log(
    `\n✓ Done. Merge the PR to ship the Worker to self-hosters. To also reach app users, cut an app release (npm run deploy:app).`,
  );
}

async function deployApp(arg) {
  if (!arg) fail("Usage: npm run deploy:app -- <version|patch|minor|major>");
  assertReadyBranch();
  const current = readAppVersion();
  const version = resolveVersion(arg, current);
  if (cmp(version, current) <= 0) fail(`App version ${version} is not newer than ${current}.`);
  step(`Bumping app version ${current} → ${version}`);
  if (!DRY) writeAppVersion(version);
  commitPush(`chore(installer): bump version to ${version}`);
  const pr = ensurePr(
    `Release ${version}`,
    `Bumps the desktop app to ${version}. Tag \`installer-v${version}\` after merge builds + publishes the release.`,
  );
  await waitForMergeThenTag(pr, version);
}

async function deployAll(appArg, workerArg) {
  if (!appArg || !workerArg) {
    fail("Usage: npm run deploy:all -- <app-version|bump> <worker-version|bump>");
  }
  assertReadyBranch();
  const curApp = readAppVersion();
  const curWorker = readWorkerVersion();
  const appVersion = resolveVersion(appArg, curApp);
  const workerVersion = resolveVersion(workerArg, curWorker);
  if (cmp(appVersion, curApp) <= 0) fail(`App version ${appVersion} is not newer than ${curApp}.`);
  if (cmp(workerVersion, curWorker) <= 0) {
    fail(`SB_VERSION ${workerVersion} is not newer than ${curWorker}.`);
  }
  step(`Bumping app ${curApp} → ${appVersion} and SB_VERSION ${curWorker} → ${workerVersion}`);
  if (!DRY) {
    writeWorkerVersion(workerVersion);
    writeAppVersion(appVersion);
  }
  commitPush(`chore: release app ${appVersion} + Worker ${workerVersion}`);
  const pr = ensurePr(
    `Release app ${appVersion} + Worker ${workerVersion}`,
    `Bumps the app to ${appVersion} and \`SB_VERSION\` to ${workerVersion}. Tag builds + publishes; app users are then offered the Worker update.`,
  );
  await waitForMergeThenTag(pr, appVersion);
}

function deployTag(arg) {
  if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
    fail("Usage: npm run deploy:tag -- <version>  (an explicit x.y.z already merged to main)");
  }
  tagMain(arg, `installer-v${arg}`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

const [mode, a, b] = process.argv.slice(2);
if (DRY) console.log("(DRY RUN — no changes will be made)\n");
switch (mode) {
  case "worker":
    await deployWorker(a);
    break;
  case "app":
    await deployApp(a);
    break;
  case "all":
    await deployAll(a, b);
    break;
  case "tag":
    deployTag(a);
    break;
  default:
    fail(`Unknown command "${mode}". Use: worker | app | all | tag`);
}
