#!/usr/bin/env node
/**
 * Measure one import continue page against a running Worker (wrangler dev or deployed).
 *
 * Usage:
 *   node scripts/measure-import-page.mjs --url http://127.0.0.1:8787 --token $AUTH_TOKEN
 *
 * Reports wall-clock ms for start / append / continue. For D1 meta.rows_read /
 * rows_written and true subrequest counts, instrument the Worker with a temporary
 * counter (see test/unit/cron-subrequest-budget.test.ts) or read wrangler's
 * local D1 logs — this script only exercises the public API and prints timings
 * plus response counters so ceilings published in the README stay measured, not
 * derived.
 *
 * Contingency (plan #217): if continue wall time >> 5 ms CPU budget equivalent
 * on free plan, or if instrumented subrequests exceed 40, shrink
 * IMPORT_ENTRIES_PER_PAGE / IMPORT_EDGES_PER_PAGE before publishing ceilings.
 */
import { performance } from "node:perf_hooks";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const base = (arg("url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const token = arg("token", process.env.AUTH_TOKEN);
const entryCount = Number(arg("entries", "500"));
const edgeCount = Number(arg("edges", "0"));

if (!token) {
  console.error("Pass --token or set AUTH_TOKEN");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function call(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ms, json };
}

const entries = Array.from({ length: entryCount }, (_, i) => ({
  id: `measure-e-${i}`,
  content: `Measure entry ${i}: ${"word ".repeat(20)}`,
  tags: ["measure"],
  source: "measure",
  created_at: Date.now() - i,
}));

const edges = Array.from({ length: edgeCount }, (_, i) => ({
  source_id: `measure-e-${i % Math.max(1, entryCount)}`,
  target_id: `measure-e-${(i + 1) % Math.max(1, entryCount)}`,
  type: "relates_to",
  weight: 0.5,
  provenance: "explicit",
}));

console.log(`Measuring against ${base}`);
console.log(`entries=${entryCount} edges=${edgeCount}`);

const start = await call("POST", "/import/start", {
  version: 2,
  entry_total: entryCount,
  edge_total: edgeCount,
});
console.log("start", { status: start.status, ms: start.ms.toFixed(1), ...start.json });
if (start.status !== 200) process.exit(1);

const jobId = start.json.job_id;

if (entryCount > 0) {
  const append = await call("POST", "/import/append", {
    job_id: jobId,
    phase: "entries",
    page: 0,
    rows: entries,
  });
  console.log("append entries", { status: append.status, ms: append.ms.toFixed(1), rows: append.json.rows });

  const cont = await call("POST", "/import/continue", {
    job_id: jobId,
    phase: "entries",
    page: 0,
  });
  console.log("continue entries", {
    status: cont.status,
    ms: cont.ms.toFixed(1),
    imported: cont.json.imported,
    skipped: cont.json.skipped,
    failed: cont.json.failed,
    retriable_failed: cont.json.retriable_failed,
  });
}

if (edgeCount > 0) {
  const append = await call("POST", "/import/append", {
    job_id: jobId,
    phase: "edges",
    page: 0,
    rows: edges,
  });
  console.log("append edges", { status: append.status, ms: append.ms.toFixed(1), rows: append.json.rows });

  const cont = await call("POST", "/import/continue", {
    job_id: jobId,
    phase: "edges",
    page: 0,
  });
  console.log("continue edges", {
    status: cont.status,
    ms: cont.ms.toFixed(1),
    imported: cont.json.imported,
    skipped: cont.json.skipped,
    failed: cont.json.failed,
    retriable_failed: cont.json.retriable_failed,
  });
}

const status = await call("GET", `/import/status?job_id=${jobId}`);
console.log("status", {
  status: status.status,
  ms: status.ms.toFixed(1),
  done: status.json.done,
  clean: status.json.clean,
  imported: status.json.imported,
});

console.log(`
Publish README ceilings only after confirming on real D1:
  - continue subrequests ≤ 40 (instrument Worker or read wrangler logs)
  - continue CPU ≤ ~5 ms on free plan
If either trips, shrink IMPORT_ENTRIES_PER_PAGE / IMPORT_EDGES_PER_PAGE first.
`);
