# Vectorization Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface vectorization status on Recent memory cards (Vectorized / Pending / Not indexed), expose a failed count in the stats menu, and provide a one-click "Vectorize now" repair action.

**Architecture:** `vector_ids = '[]'` is already the de-facto failure signal. A grace window (`VECTORIZE_GRACE_MS` env var, default 5 min) keyed on `created_at` distinguishes in-flight embeds (Pending) from permanent failures (Not indexed). `/stats` gains an `unvectorized` count and `vectorize_grace_ms`; a new `POST /vectorize-pending` endpoint re-embeds past-grace rows in batches of 25 via the existing `storeEntry` function. The frontend adds a three-state chip to Recent cards and a repair section to the menu.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vectorize, Workers AI, Vitest (unit + integration), plain HTML/JS frontend.

**Spec:** `docs/superpowers/specs/2026-06-08-vectorization-status-design.md`

---

## File Map

| File | Change |
|---|---|
| `wrangler.toml` | Add `[vars]` block with `VECTORIZE_GRACE_MS` |
| `src/index.ts` | `Env` interface, `graceMs()` helper, `buildEntryFilterQuery` SELECT, `/stats` query + response, new `POST /vectorize-pending` |
| `test/helpers/d1-mock.ts` | Update `first()` for stats, add branches for vectorize-pending queries |
| `test/integration/stats.test.ts` | Add tests for `unvectorized` and `vectorize_grace_ms` fields |
| `test/integration/list.test.ts` | Add test for `vector_ids` field in `/list` response |
| `test/integration/vectorize-pending.test.ts` | New test file for `POST /vectorize-pending` |
| `public/index.html` | `.vec-chip` CSS, `makeRecentCard` badge, `vectorizeGraceMs` global, `#vectorize-section` HTML, `renderVectorizeSection`, `runVectorize`, `loadMenuStats` update |

---

## Task 1: Config + graceMs helper

**Files:**
- Modify: `wrangler.toml`
- Modify: `src/index.ts` (Env interface ~line 11, new helper after imports)

- [ ] **Step 1: Add VECTORIZE_GRACE_MS to wrangler.toml**

In `wrangler.toml`, add a `[vars]` block before `[assets]`:

```toml
[vars]
VECTORIZE_GRACE_MS = "300000"

[assets]
```

- [ ] **Step 2: Add VECTORIZE_GRACE_MS to Env interface**

In `src/index.ts`, update the `Env` interface (line 11):

```ts
export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  AUTH_TOKEN: string;
  OAUTH_KV: KVNamespace;
  VECTORIZE_GRACE_MS?: string;
}
```

- [ ] **Step 3: Add graceMs helper**

Add this function immediately after the `CORS_HEADERS` block (~line 27):

```ts
function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}
```

- [ ] **Step 4: Run typecheck to verify no errors**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml src/index.ts
git commit -m "feat: add VECTORIZE_GRACE_MS config and graceMs helper"
```

---

## Task 2: Expose vector_ids on /list

**Files:**
- Modify: `src/index.ts` (`buildEntryFilterQuery` ~line 515)
- Modify: `test/integration/list.test.ts`

- [ ] **Step 1: Write a failing test**

In `test/integration/list.test.ts`, add inside `describe("GET /list", ...)`:

```ts
it("includes vector_ids field in each entry", async () => {
  db.entries.push({
    id: "v1", content: "Vectorized note", tags: "[]", source: "api",
    created_at: 1000, vector_ids: '["v1"]',
  });
  db.entries.push({
    id: "v2", content: "Unvectorized note", tags: "[]", source: "api",
    created_at: 2000, vector_ids: "[]",
  });

  const res = await worker.fetch(req("GET", "/list"), env, ctx);
  const data = await res.json() as any[];
  const v1 = data.find((e: any) => e.id === "v1");
  const v2 = data.find((e: any) => e.id === "v2");
  expect(v1.vector_ids).toBe('["v1"]');
  expect(v2.vector_ids).toBe("[]");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/integration/list.test.ts
```

Expected: FAIL — `v1.vector_ids` is `undefined`.

- [ ] **Step 3: Update buildEntryFilterQuery SELECT**

In `src/index.ts` line 515, change:

```ts
let sql = `SELECT id, content, tags, source, created_at FROM entries`;
```

to:

```ts
let sql = `SELECT id, content, tags, source, created_at, vector_ids FROM entries`;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/integration/list.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/integration/list.test.ts
git commit -m "feat: expose vector_ids on /list responses"
```

---

## Task 3: /stats — unvectorized count + grace window

**Files:**
- Modify: `src/index.ts` (`/stats` handler ~line 1602)
- Modify: `test/helpers/d1-mock.ts`
- Modify: `test/integration/stats.test.ts`

- [ ] **Step 1: Write failing tests**

In `test/integration/stats.test.ts`, add after the existing tests:

```ts
describe("GET /stats — vectorization fields", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns unvectorized: 0 when all entries are vectorized", async () => {
    db.entries.push({
      id: "a", content: "content", tags: "[]", source: "api",
      created_at: Date.now() - 600000, vector_ids: '["a"]', recall_count: 0, importance_score: 0,
    });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(0);
  });

  it("returns unvectorized: 0 for entries within the grace window (pending)", async () => {
    // created_at = now → within 5-minute grace window → not counted as failed
    db.entries.push({
      id: "b", content: "content", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(0);
  });

  it("counts past-grace entries with vector_ids=[] as unvectorized", async () => {
    db.entries.push(
      { id: "old-1", content: "c1", tags: "[]", source: "api", created_at: Date.now() - 600000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "old-2", content: "c2", tags: "[]", source: "api", created_at: Date.now() - 700000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "vec",   content: "c3", tags: "[]", source: "api", created_at: Date.now() - 600000, vector_ids: '["vec"]', recall_count: 0, importance_score: 0 },
    );
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(2);
  });

  it("returns vectorize_grace_ms in response", async () => {
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.vectorize_grace_ms).toBe(300000);
  });

  it("uses VECTORIZE_GRACE_MS env var when set", async () => {
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    // entry that is 90 seconds old — past the 60s grace but within default 300s
    db.entries.push({
      id: "x", content: "c", tags: "[]", source: "api",
      created_at: Date.now() - 90000, vector_ids: "[]", recall_count: 0, importance_score: 0,
    });
    const res = await worker.fetch(req("GET", "/stats"), env, ctx);
    const data = await res.json() as any;
    expect(data.unvectorized).toBe(1);
    expect(data.vectorize_grace_ms).toBe(60000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/integration/stats.test.ts
```

Expected: FAIL — `data.unvectorized` is `undefined`, `data.vectorize_grace_ms` is `undefined`.

- [ ] **Step 3: Update D1Mock first() for the stats query**

In `test/helpers/d1-mock.ts`, find the branch:
```ts
if (s.includes("COUNT(*) as count") && s.includes("AVG(importance_score)")) {
  const count = db.entries.length;
  const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
  const avg_importance = scored.length > 0
    ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
    : null;
  return { count, avg_importance };
}
```

Replace it with:
```ts
if (s.includes("COUNT(*) as count") && s.includes("AVG(importance_score)")) {
  const count = db.entries.length;
  const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
  const avg_importance = scored.length > 0
    ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
    : null;
  const cutoff = args.length > 0 ? Number(args[0]) : undefined;
  const unvectorized = cutoff !== undefined
    ? db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length
    : 0;
  return { count, avg_importance, unvectorized };
}
```

- [ ] **Step 4: Update /stats handler in src/index.ts**

In `src/index.ts`, find the `/stats` handler (~line 1604). Add `graceCutoff` before `Promise.all`, update the summary query to include unvectorized, and add the new fields to the JSON response.

Replace:
```ts
const [summary, tagRows, candidateRows] = await Promise.all([
  env.DB.prepare(`SELECT COUNT(*) as count, AVG(importance_score) as avg_importance FROM entries`).first() as Promise<Record<string, any> | null>,
```

With:
```ts
const graceCutoff = Date.now() - graceMs(env);
const [summary, tagRows, candidateRows] = await Promise.all([
  env.DB.prepare(
    `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
     SUM(CASE WHEN vector_ids = '[]' AND created_at < ? THEN 1 ELSE 0 END) as unvectorized
     FROM entries`
  ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
```

Then update the `return json({...})` at the end of the handler (currently ~line 1633):

```ts
return json({
  count: (summary?.count as number) ?? 0,
  avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
  top_tags: (tagRows.results as any[]).map(r => r.value as string),
  digest_candidates: digestCandidates,
  unvectorized: (summary?.unvectorized as number) ?? 0,
  vectorize_grace_ms: graceMs(env),
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- test/integration/stats.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/helpers/d1-mock.ts test/integration/stats.test.ts
git commit -m "feat: add unvectorized count and grace window to /stats"
```

---

## Task 4: POST /vectorize-pending endpoint

**Files:**
- Modify: `src/index.ts` (add endpoint after `/digest` handler ~line 1750)
- Modify: `test/helpers/d1-mock.ts` (two new query branches)
- Create: `test/integration/vectorize-pending.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/integration/vectorize-pending.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function pastGraceEntry(id: string) {
  return {
    id,
    content: `Content for ${id}`,
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 600000, // 10 minutes ago — past default 5-min grace
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
  };
}

describe("POST /vectorize-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when no past-grace entries", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes past-grace entries and returns correct counts", async () => {
    db.entries.push(pastGraceEntry("e1"), pastGraceEntry("e2"));
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("updates vector_ids in D1 after successful re-embed", async () => {
    db.entries.push(pastGraceEntry("fix-me"));
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "fix-me");
    const ids = JSON.parse(updated.vector_ids);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("skips entries within the grace window (vector_ids=[] but recent)", async () => {
    db.entries.push({
      id: "pending",
      content: "Just captured",
      tags: "[]",
      source: "api",
      created_at: Date.now(), // within grace window
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("skips entries that already have vector_ids populated", async () => {
    db.entries.push({
      id: "already-done",
      content: "Already vectorized",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600000,
      vector_ids: '["already-done"]',
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
  });

  it("counts failed and continues when storeEntry throws for one entry", async () => {
    db.entries.push(pastGraceEntry("bad"), pastGraceEntry("good"));
    let callCount = 0;
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error("Vectorize error");
          return Promise.resolve({ mutationId: "m" });
        }),
      }),
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(1);
  });

  it("respects VECTORIZE_GRACE_MS env var", async () => {
    // entry 90s old — past 60s grace but within default 300s
    db.entries.push({
      id: "e90",
      content: "90-second-old memory",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 90000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/integration/vectorize-pending.test.ts
```

Expected: FAIL — 404 (endpoint does not exist yet).

- [ ] **Step 3: Add vectorize-pending query branches to D1Mock**

In `test/helpers/d1-mock.ts`, inside `async all()`, add a new branch **before** the existing `if (s.includes("ORDER BY created_at DESC LIMIT"))` block:

```ts
if (s.includes("vector_ids = '[]' AND created_at <") && s.includes("ORDER BY created_at DESC LIMIT")) {
  const cutoff = Number(args[0]);
  const limitMatch = s.match(/LIMIT\s+(\d+)/i);
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
  const rows = [...db.entries]
    .filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff)
    .sort((a: any, b: any) => b.created_at - a.created_at)
    .slice(0, limit)
    .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
  return { results: rows };
}
```

Also in `async first()`, add a new branch **before** the existing `if (s.includes("COUNT(*) as count"))` fallback block:

```ts
if (s.includes("COUNT(*) as count") && s.includes("vector_ids = '[]'") && s.includes("created_at <")) {
  const cutoff = Number(args[0]);
  const count = db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length;
  return { count };
}
```

- [ ] **Step 4: Add POST /vectorize-pending handler to src/index.ts**

In `src/index.ts`, insert after the closing brace of the `GET /digest` handler (after line 1749, before the `return new Response("Not found"...)`):

```ts
// POST /vectorize-pending
if (url.pathname === "/vectorize-pending" && request.method === "POST") {
  const authErr = requireAuth(request, env);
  if (authErr) return authErr;

  const graceCutoff = Date.now() - graceMs(env);

  const { results: toProcess } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries
     WHERE vector_ids = '[]' AND created_at < ?
     ORDER BY created_at DESC LIMIT 25`
  ).bind(graceCutoff).all();

  let processed = 0;
  let failed = 0;

  for (const row of toProcess as Record<string, any>[]) {
    try {
      await storeEntry(
        env,
        row.id as string,
        row.content as string,
        JSON.parse(row.tags as string),
        row.source as string,
        row.created_at as number
      );
      processed++;
    } catch {
      failed++;
    }
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ?`
  ).bind(graceCutoff).first() as Record<string, any> | null;

  return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
}
```

- [ ] **Step 5: Run all tests to verify they pass**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/helpers/d1-mock.ts test/integration/vectorize-pending.test.ts
git commit -m "feat: add POST /vectorize-pending endpoint for batch re-embedding"
```

---

## Task 5: Frontend — vec-chip CSS + makeRecentCard badge

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add vectorizeGraceMs global**

In `public/index.html`, find line 2505:
```js
let currentCount = 0
```

Add `vectorizeGraceMs` on the next line:
```js
let currentCount = 0
let vectorizeGraceMs = 300000
```

- [ ] **Step 2: Add .vec-chip CSS**

In `public/index.html`, find the `.tag-chip--synthesized` block (~line 975):
```css
.tag-chip.tag-chip--synthesized {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 500;
}
```

Add the `.vec-chip` styles immediately after it:
```css
.vec-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: var(--radius-tag);
  white-space: nowrap;
}
.vec-chip--on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.vec-chip--pending {
  background: var(--surface-2);
  color: var(--text-tag);
}
.vec-chip--off {
  background: color-mix(in srgb, var(--danger) 15%, transparent);
  color: var(--danger);
  font-weight: 500;
}
```

- [ ] **Step 3: Update makeRecentCard with badge logic**

In `public/index.html`, replace the entire `makeRecentCard` function (~lines 2884–2907):

```js
function makeRecentCard(entry) {
  let tags = []
  try {
    tags = JSON.parse(entry.tags || '[]')
  } catch {}
  const isSynthesized = tags.includes('synthesized')
  const isRolledUp = tags.includes('rolled-up')

  let vectorIds = []
  try { vectorIds = JSON.parse(entry.vector_ids || '[]') } catch {}
  const vectorized = vectorIds.length > 0
  // Pending state is computed at render time; won't auto-flip — reload required
  const pending = !vectorized && (Date.now() - (entry.created_at || 0) < vectorizeGraceMs)
  const vec = vectorized ? 'on' : (pending ? 'pending' : 'off')

  const vecChip = vec === 'on'
    ? `<span class="tag-chip vec-chip vec-chip--on" title="Vectorized — searchable via recall"><i class="ti ti-circle-check"></i></span>`
    : vec === 'pending'
    ? `<span class="tag-chip vec-chip vec-chip--pending" title="Vectorizing… (just captured)"><i class="ti ti-clock"></i></span>`
    : `<span class="tag-chip vec-chip vec-chip--off" title="Not vectorized — won't appear in recall">Not indexed</span>`

  const card = document.createElement('div')
  card.className = 'memory-card' + (isSynthesized ? ' card--synthesized' : '') + (isRolledUp ? ' card--rolled-up' : '')
  card.dataset.id = entry.id
  card.innerHTML = `
<div class="card-content" style="cursor: pointer;">${escHtml(entry.content)}</div>
<div class="card-footer">
  <div class="card-tags">${tags.map((t) => `<span class="tag-chip${t === 'synthesized' ? ' tag-chip--synthesized' : ''}">${escHtml(t)}</span>`).join('')}${vecChip}</div>
  <div class="card-actions">
    <button class="card-action-btn" onclick="openAppend('${escAttr(entry.id)}', '${escAttr(entry.content.slice(0, 80))}')"><i class="ti ti-writing"></i> Append</button>
    <button class="card-action-btn edit-btn"><i class="ti ti-pencil"></i> Edit</button>
    <button class="card-action-btn" onclick="openConfirm('${escAttr(entry.id)}', this)"><i class="ti ti-x"></i> Forget</button>
  </div>
</div>`
  card.querySelector('.card-content').onclick = () => openView({ id: entry.id, content: entry.content, tags }, card)
  card.querySelector('.edit-btn').onclick = () => openEdit(entry.id, entry.content, tags)
  return card
}
```

- [ ] **Step 4: Verify locally**

```bash
npm run dev
```

Open the Recent tab. Each memory card should show one of:
- A green check chip (vectorized — `vector_ids` non-empty)
- A grey clock chip (pending — `created_at` within last 5 min)
- A red "Not indexed" chip (failed — `vector_ids = '[]'` and older than 5 min)

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: add three-state vectorization badge to Recent memory cards"
```

---

## Task 6: Frontend — Vectorize now menu section

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add #vectorize-section HTML**

In `public/index.html`, find line 2470:
```html
<div class="digest-section" id="digest-section" style="display:none"></div>
```

Add `#vectorize-section` immediately after it:
```html
<div class="digest-section" id="digest-section" style="display:none"></div>
<div class="digest-section" id="vectorize-section" style="display:none"></div>
```

- [ ] **Step 2: Update loadMenuStats to sync grace window and render vectorize section**

In `public/index.html`, find `loadMenuStats` (~line 3083). Replace the entire function body:

```js
async function loadMenuStats() {
  try {
    const res = await fetch(`${WORKER_URL}/stats`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    document.getElementById('stats-count').textContent = (data.count ?? 0).toLocaleString()
    document.getElementById('stats-importance').textContent = data.avg_importance != null ? data.avg_importance.toFixed(1) + ' / 10' : '—'
    const tagsEl = document.getElementById('stats-tags')
    tagsEl.innerHTML = data.top_tags?.length
      ? data.top_tags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')
      : '<span style="font-size:13px;color:var(--text-tertiary)">No tags yet</span>'
    vectorizeGraceMs = data.vectorize_grace_ms ?? vectorizeGraceMs
    renderDigestSection(data.digest_candidates ?? [])
    renderVectorizeSection(data.unvectorized ?? 0)
  } catch {}
}
```

- [ ] **Step 3: Add renderVectorizeSection and runVectorize**

In `public/index.html`, immediately after the closing brace of `runDigest` (~line 3153), add:

```js
function renderVectorizeSection(count) {
  const el = document.getElementById('vectorize-section')
  if (!count) { el.style.display = 'none'; return }
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">Not indexed</div>
    <p class="digest-note">${count} ${count === 1 ? 'memory' : 'memories'} failed to embed and won't appear in recall.</p>
    <button class="digest-btn" id="vectorize-btn" onclick="runVectorize(this)">Vectorize now →</button>
  `
}

async function runVectorize(btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Working…'
  try {
    let remaining = 1
    let totalProcessed = 0
    while (remaining > 0) {
      const res = await fetch(`${WORKER_URL}/vectorize-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
      })
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
    }
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-check"></i> Done — ${totalProcessed} re-indexed`
    btn.style.color = 'var(--good)'
    await loadMenuStats()
    loadRecent()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = '<i class="ti ti-wifi-off"></i> Request failed'
    btn.style.color = 'var(--danger)'
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = 'Vectorize now →'
      btn.style.color = ''
    }, 3000)
  }
}
```

- [ ] **Step 4: Verify locally**

```bash
npm run dev
```

Open the menu (hamburger icon). Verify:
1. When all entries are vectorized: no "Not indexed" section visible.
2. To simulate failures, run in a separate terminal:
   ```bash
   wrangler d1 execute second-brain-db --local --command \
     "UPDATE entries SET vector_ids='[]', created_at=created_at-600000 WHERE id=(SELECT id FROM entries LIMIT 1)"
   ```
3. Reopen the menu — "Not indexed" section appears with count and **Vectorize now** button.
4. Click the button — it loops until `remaining = 0`, then shows "Done — N re-indexed" and refreshes the stats + Recent list.
5. Chips on Recent cards flip from "Not indexed" to the vectorized check.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: add Vectorize now repair action to stats menu"
```

---

## Self-Review

**Spec coverage check:**

| Spec Section | Task |
|---|---|
| Config: VECTORIZE_GRACE_MS env var | Task 1 |
| Env interface: VECTORIZE_GRACE_MS? | Task 1 |
| graceMs() helper | Task 1 |
| buildEntryFilterQuery adds vector_ids | Task 2 |
| /stats: unvectorized count | Task 3 |
| /stats: vectorize_grace_ms | Task 3 |
| POST /vectorize-pending: past-grace guard | Task 4 |
| POST /vectorize-pending: processed/failed/remaining | Task 4 |
| POST /vectorize-pending: batch cap 25 | Task 4 (LIMIT 25 in SQL) |
| Frontend: vectorizeGraceMs global | Task 5 |
| Frontend: .vec-chip CSS | Task 5 |
| makeRecentCard: three-state badge | Task 5 |
| #vectorize-section HTML | Task 6 |
| renderVectorizeSection | Task 6 |
| runVectorize loop until remaining=0 | Task 6 |
| loadMenuStats: sync grace + render section | Task 6 |

All spec requirements covered. ✓

**Placeholder scan:** No TBDs, TODOs, or vague instructions. ✓

**Type consistency:** `graceMs(env)` called consistently in Tasks 3 and 4. `storeEntry` called with `(env, id, content, string[], source, created_at)` matching its signature at line 526. `remaining?.count` cast matches D1 `first()` return type. ✓
