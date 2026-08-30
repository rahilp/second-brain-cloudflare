#!/usr/bin/env node
/**
 * Seed the local out-of-date review queue for dashboard/browser testing.
 *
 * POST /capture needs remote AI in `wrangler dev`, so the stale chip cannot be
 * exercised end-to-end via capture alone. This inserts rows directly into the
 * same local D1 file `wrangler dev --persist-to` uses.
 *
 * Prerequisite: start the dev server once and connect in the dashboard (or curl
 * GET /list) so tenant bootstrap creates the owner personal workspace.
 *
 *   npm run dev -- --port 8790 --local --persist-to /tmp/sb-browser-test
 *   curl -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:8790/list?n=1
 *   npm run seed:stale-dev -- --persist-to /tmp/sb-browser-test
 *
 * Then open the dashboard → "N may be out of date".
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const persistTo = arg("persist-to", process.env.SB_PERSIST_TO ?? "/tmp/sb-browser-test");
const count = Math.max(1, Number(arg("count", "2")) || 2);

const ROOT = resolve(import.meta.dirname, "..");

/** Run one wrangler d1 execute and return parsed JSON stdout. */
function d1(command) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "second-brain-db", "--local", "--persist-to", persistTo, "--command", command, "--json"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return block?.results ?? [];
}

const workspaces = d1(
  `SELECT id FROM workspaces WHERE kind = 'personal' ORDER BY created_at LIMIT 1`,
);
const workspaceId = workspaces[0]?.id;
if (!workspaceId) {
  console.error(
    "No personal workspace in local D1. Connect once so bootstrap runs:\n" +
      `  curl -H "Authorization: Bearer <token>" http://localhost:8790/list?n=1\n` +
      `(using the same --persist-to path: ${persistTo})`,
  );
  process.exit(1);
}

const samples = [
  'Deploy target is "production" as of January — browser test row',
  "Second flagged claim for queue testing",
  "Office lease runs through 2027 with option to renew",
  "Pricing floor is $6k for new projects",
];

const now = Date.now();
const ids = [];
for (let i = 0; i < count; i++) {
  const id = `stale-dev-${randomUUID().slice(0, 8)}`;
  ids.push(id);
  const content = samples[i % samples.length].replace(/'/g, "''");
  const created = 1000 + i;
  d1(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id, updated_at) ` +
      `VALUES ('${id}', '${content}', '["work","stale:as-of"]', 'dashboard', ${created}, '[]', '${workspaceId}', '', ${created})`,
  );
}

console.log(`Seeded ${ids.length} out-of-date ${ids.length === 1 ? "memory" : "memories"} in local D1 (${persistTo}).`);
console.log("Ids:", ids.join(", "));
console.log("Open the dashboard and tap the stale chip on Home.");
