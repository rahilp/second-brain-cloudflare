#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const {
  loadCredentials, resolveWorkspace, readStdinJson, parseProjectName, gitRemoteUrl,
  fetchWithTimeout, fail, hintFor, workerMajorVersion, noticeOncePerDay,
} = require('./common');

const CAPTURE_TIMEOUT_MS = 20000;
const BLOCK_BYTES = 64 * 1024;
const BYTE_CEILING = 1024 * 1024;
const WANT_USER_TURNS = 3;
const MAX_CONTENT_CHARS = 2000;
const ASSISTANT_LINE_CAP = 300;
const MIN_USER_TURN_CHARS = 40;
const MIN_BODY_CHARS = 200;

/** Text the harness injects into user turns. Compared against the trimmed start of the turn. */
const NOISE_PREFIXES = [
  '<task-notification>', '<task-id', '<command-name>', '<command-message>',
  '<local-command-stdout>', '<local-command-caveat>', '<system-reminder>',
  '<ide_', '<bash-', '[Request interrupted',
];

/** A message's human-readable text: strings as-is, arrays → text blocks only. */
function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

/** One JSONL line → a turn, or null when it is not human-readable conversation. */
function turnFromLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) return null;
  if (obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) return null;
  const text = textOf(obj.message).trim();
  if (!text) return null;
  if (NOISE_PREFIXES.some((p) => text.startsWith(p))) return null;
  return {
    role: obj.type,
    text,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    gitBranch: typeof obj.gitBranch === 'string' ? obj.gitBranch : undefined,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
  };
}

/**
 * Read the file backwards in blocks until `wantUserTurns` human turns are in
 * hand or `byteCeiling` bytes have been read. Lines are split on the newline
 * BYTE before decoding — 0x0A never occurs inside a multi-byte UTF-8 sequence —
 * so a block boundary can only ever cut a line, never a character. A partial
 * first line is carried into the next (earlier) block and only decoded once
 * complete; if the read stops before that, it is discarded.
 *
 * Returns turns in chronological order.
 */
function readTranscriptTail(filePath, {
  blockSize = BLOCK_BYTES, byteCeiling = BYTE_CEILING, wantUserTurns = WANT_USER_TURNS,
} = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const turns = [];
    let userTurns = 0;
    let pos = size;
    let readBytes = 0;
    let carry = Buffer.alloc(0); // bytes of a line whose start is in an earlier block
    while (pos > 0 && readBytes < byteCeiling && userTurns < wantUserTurns) {
      const len = Math.min(blockSize, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      readBytes += len;
      const buf = Buffer.concat([chunk, carry]);
      const firstNl = buf.indexOf(0x0a);
      let start = 0;
      if (pos > 0) {
        if (firstNl === -1) { carry = buf; continue; } // one line longer than the block
        carry = buf.subarray(0, firstNl);
        start = firstNl + 1;
      } else {
        carry = Buffer.alloc(0);
      }
      const lines = buf.subarray(start).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const t = turnFromLine(lines[i]);
        if (!t) continue;
        turns.push(t);
        if (t.role === 'user' && ++userTurns >= wantUserTurns) break;
      }
    }
    return turns.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Header first (recall always shows the head of a memory), then the newest
 * turns that fit. Assistant narration is clipped per line except the final
 * line, which is the summary of what happened.
 */
function formatSession(turns, meta, { maxChars = MAX_CONTENT_CHARS, assistantCap = ASSISTANT_LINE_CAP } = {}) {
  const date = (meta.timestamp || new Date().toISOString()).slice(0, 10);
  const where = meta.project ? `${meta.project}${meta.gitBranch ? '@' + meta.gitBranch : ''}` : 'unknown project';
  const header = `Claude Code session ${meta.sessionId || '?'} — ${where} — ${date} (${meta.reason || 'other'})`;
  const rendered = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const text = t.role === 'assistant' && !last && t.text.length > assistantCap
      ? t.text.slice(0, assistantCap) + '…'
      : t.text;
    return `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
  });
  let budget = maxChars - header.length - 2;
  const kept = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const piece = rendered[i];
    const cost = piece.length + (kept.length ? 2 : 0);
    if (cost <= budget) { kept.unshift(piece); budget -= cost; continue; }
    if (!kept.length && budget > 40) kept.unshift(piece.slice(0, budget - 1) + '…');
    break;
  }
  return `${header}\n\n${kept.join('\n\n')}`;
}

/**
 * The gate. Turn counts are line counts on an agentic transcript, so gate on
 * human text and on how much conversation there is. Measured on the turns, not
 * the formatted body: the header is always present and must not count.
 */
function shouldCapture(turns) {
  const conversationChars = turns.reduce((n, t) => n + t.text.length, 0);
  return turns.some((t) => t.role === 'user' && t.text.length >= MIN_USER_TURN_CHARS)
    && conversationChars >= MIN_BODY_CHARS;
}

function buildCaptureBody(turns, meta) {
  const content = formatSession(turns, meta);
  return {
    content,
    source: 'claude-code',
    tags: meta.project ? [meta.project] : [],
    workspace: meta.workspace,
  };
}

async function main() {
  if (process.env.SECOND_BRAIN_HOOK_CAPTURE === '0') return;
  const creds = loadCredentials();
  if (!creds) return;

  const payload = await readStdinJson();
  const transcriptPath = payload?.transcript_path;
  if (typeof transcriptPath !== 'string' || !transcriptPath || !fs.existsSync(transcriptPath)) return;

  const major = await workerMajorVersion(creds);
  if (major !== null && major < 3) {
    noticeOncePerDay('capture-needs-v3', `session capture needs Worker 3.0+ (this brain reports ${major}.x); recall still works.`);
    return;
  }

  const turns = readTranscriptTail(transcriptPath);
  if (!turns.length) return;
  const last = turns[turns.length - 1];
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : last.cwd;
  const meta = {
    project: parseProjectName(cwd ? gitRemoteUrl(cwd) : null, cwd),
    gitBranch: last.gitBranch,
    sessionId: typeof payload?.session_id === 'string' ? payload.session_id : last.sessionId,
    timestamp: last.timestamp,
    reason: typeof payload?.reason === 'string' ? payload.reason : 'other',
    workspace: resolveWorkspace(),
  };
  const body = buildCaptureBody(turns, meta);
  if (!shouldCapture(turns)) return;

  if (process.env.SECOND_BRAIN_DRY_RUN === '1') {
    process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    return;
  }

  let res;
  try {
    res = await fetchWithTimeout(`${creds.baseUrl}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, CAPTURE_TIMEOUT_MS);
  } catch (e) {
    return fail(`session capture failed: ${e?.name === 'TimeoutError' ? `no reply within ${CAPTURE_TIMEOUT_MS / 1000}s` : e?.message ?? 'network error'}`);
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = String(j?.error ?? j?.code ?? ''); } catch { /* not JSON */ }
    return fail(`session capture failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}${hintFor(res.status)}`);
  }
}

module.exports = {
  NOISE_PREFIXES, textOf, turnFromLine, readTranscriptTail, formatSession, shouldCapture, buildCaptureBody, main,
};

if (require.main === module) {
  main().catch((e) => fail(`session capture failed: ${e?.message ?? e}`));
}
