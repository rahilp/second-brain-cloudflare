#!/usr/bin/env node
'use strict';
// `install.sh --check`: prove the hooks can reach the Worker and show what they would do.
const path = require('node:path');
const { loadCredentials, fetchWithTimeout, CONFIG_PATH } = require('./common');
const start = require('./session-start');
const end = require('./session-end');

async function main() {
  const creds = loadCredentials();
  if (!creds) { console.error(`No credentials: set SECOND_BRAIN_URL/SECOND_BRAIN_TOKEN or write ${CONFIG_PATH}`); process.exit(1); }
  const res = await fetchWithTimeout(`${creds.baseUrl}/health`, { headers: { Authorization: `Bearer ${creds.token}` } }, 10000);
  if (!res.ok) { console.error(`GET /health → HTTP ${res.status}. Token or URL is wrong.`); process.exit(1); }
  const health = await res.json();
  const major = parseInt(String(health.version ?? '').split('.')[0], 10);
  console.log(`Worker ${health.version} at ${creds.baseUrl} — recall: on; session capture: ${major >= 3 ? 'on' : 'off (needs 3.0+)'}`);

  console.log('\n— session-start against this brain —');
  await start.main();

  console.log('\n— session-end dry run against the bundled sample transcript —');
  process.env.SECOND_BRAIN_DRY_RUN = '1';
  const fixture = path.join(__dirname, 'fixtures', 'sample-transcript.jsonl');
  const fs = require('node:fs');
  const turns = end.readTranscriptTail(fixture);
  const body = end.buildCaptureBody(turns, { project: 'sample', sessionId: 'sample', reason: 'other', workspace: 'personal' });
  console.log(JSON.stringify({ wouldCapture: end.shouldCapture(turns), tags: body.tags, contentPreview: body.content.slice(0, 200) }, null, 2));
  if (process.exitCode) process.exit(process.exitCode);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
