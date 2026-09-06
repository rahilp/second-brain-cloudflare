'use strict';
// Shared by session-start.js, session-end.js and check.js. CommonJS on purpose:
// the repo's package.json has no "type", and vitest can require() this file
// (test/ui/graph-clusters.test.ts does the same with public/utils.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.config', 'second-brain', 'config.json');
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'second-brain');
const HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Credentials: env first (what the tests and `--check` use), then the file the
 * CLI and the desktop installer already share. Nothing is ever read from the
 * hook command line, so the token is not in settings.json and not in `ps`.
 */
function loadCredentials(env = process.env, configPath = CONFIG_PATH) {
  const url = (env.SECOND_BRAIN_URL || '').trim();
  const token = (env.SECOND_BRAIN_TOKEN || '').trim();
  if (url && token) return { baseUrl: stripSlash(url), token };
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg && typeof cfg.workerUrl === 'string' && typeof cfg.authToken === 'string' && cfg.workerUrl && cfg.authToken) {
      return { baseUrl: stripSlash(cfg.workerUrl), token: cfg.authToken };
    }
  } catch { /* absent or malformed: the hook has nothing to do */ }
  return null;
}

function stripSlash(u) { return String(u).trim().replace(/\/+$/, ''); }

/** "personal" unless the user explicitly asks for the shared layer. Anything else is personal. */
function resolveWorkspace(env = process.env) {
  return (env.SECOND_BRAIN_WORKSPACE || '').trim() === 'company' ? 'company' : 'personal';
}

/**
 * Claude Code writes the hook payload to stdin and closes it. A TTY (someone
 * running the script by hand) or a pipe that never closes (execFile in a test)
 * must not hang the hook, so the read races a short timer.
 */
function readStdinJson(timeoutMs = 1500) {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(parse(raw)), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; if (raw.length > 65536) finish(parse(raw)); });
    process.stdin.on('end', () => finish(parse(raw)));
    process.stdin.on('error', () => finish(null));
  });
  function parse(s) { try { return s.trim() ? JSON.parse(s) : null; } catch { return null; } }
}

/** basename of the origin remote (without .git), else basename of cwd, else null for $HOME and /. */
function parseProjectName(remoteUrl, cwd, home = HOME) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (remoteUrl) {
    const base = remoteUrl.trim().replace(/[/:]+$/, '').split(/[/:]/).pop().replace(/\.git$/i, '');
    if (base) return clean(base) || null;
  }
  if (!cwd) return null;
  const resolved = path.resolve(cwd);
  if (resolved === path.resolve(home) || resolved === path.parse(resolved).root) return null;
  return clean(path.basename(resolved)) || null;
}

function gitRemoteUrl(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, encoding: 'utf8',
    }).trim() || null;
  } catch { return null; }
}

function fetchWithTimeout(url, init, ms) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** The one visible channel: stderr + exit 1. Claude Code drops stderr from an exit-0 hook. */
function fail(message) {
  process.stderr.write(`[Second Brain] ${message}\n`);
  process.exitCode = 1;
}

function hintFor(status) {
  if (status === 401 || status === 403) return ' — token rejected; re-run integrations/claude-code-hooks/install.sh';
  if (status === 404) return ' — is SECOND_BRAIN_URL / workerUrl the Worker origin?';
  return '';
}

/** `dir` is only ever passed by tests, so nothing writes to the real cache during a run. */
function cachePath(name, dir = CACHE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** Worker major version from GET /health, cached per origin for 24 h. null when unknown. */
async function workerMajorVersion({ baseUrl, token }, now = Date.now()) {
  const file = cachePath(`health-${crypto.createHash('sha1').update(baseUrl).digest('hex').slice(0, 12)}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached && now - cached.checkedAt < HEALTH_TTL_MS && Number.isInteger(cached.major)) return cached.major;
  } catch { /* no cache yet */ }
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${token}` } }, 5000);
    if (!res.ok) return null;
    const body = await res.json();
    const major = parseInt(String(body?.version ?? '').split('.')[0], 10);
    if (!Number.isInteger(major)) return null;
    fs.writeFileSync(file, JSON.stringify({ major, version: body.version, checkedAt: now }));
    return major;
  } catch { return null; }
}

/** Emit `message` via fail() at most once per 24 h per key. Returns true when it fired. */
function noticeOncePerDay(key, message, now = Date.now()) {
  const file = cachePath(`notice-${key}`);
  try {
    if (now - fs.statSync(file).mtimeMs < HEALTH_TTL_MS) return false;
  } catch { /* first time */ }
  fs.writeFileSync(file, String(now));
  fail(message);
  return true;
}

module.exports = {
  CONFIG_PATH, CACHE_DIR, HEALTH_TTL_MS,
  loadCredentials, resolveWorkspace, readStdinJson, parseProjectName, gitRemoteUrl,
  fetchWithTimeout, fail, hintFor, cachePath, workerMajorVersion, noticeOncePerDay,
};
