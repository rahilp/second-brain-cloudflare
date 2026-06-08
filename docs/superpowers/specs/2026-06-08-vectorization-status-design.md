# Vectorization Status: Visibility + Repair

**Date:** 2026-06-08  
**Branch:** `138-show-vectorization-status-of-memories-+-stats-count-and-force-re-vectorize`  
**Status:** Approved for implementation

---

## Problem

Every memory is a D1 `entries` row with a `vector_ids` column. On capture, `captureEntry()` inserts the row with `vector_ids = "[]"` and fires `storeEntry()` asynchronously via `ctx.waitUntil`. If `storeEntry` throws (Workers AI or Vectorize failure), the `.catch()` swallows it and `vector_ids` stays `"[]"` permanently — the memory is invisible to semantic recall with no signal to the user.

`vector_ids` is already the de-facto status, but it is never surfaced: `/list` doesn't return the column, and the UI never shows it.

---

## Status Semantics

Three states derived from `vector_ids` + `created_at`:

| State | Condition | Label | UI |
|---|---|---|---|
| Vectorized | `vector_ids` non-empty | Vectorized | Subtle check chip |
| Pending | `vector_ids = '[]'` AND `created_at` within grace window | Vectorizing… | Muted clock chip |
| Not indexed | `vector_ids = '[]'` AND `created_at` past grace window | Not indexed | Red warning chip |

**Grace window:** `VECTORIZE_GRACE_MS` env var, default `300000` (5 minutes). Configurable in `wrangler.toml`. Only past-grace rows count as failed and are eligible for force re-vectorization.

**Timing note:** `storeEntry` runs in the request lifecycle via `waitUntil`; `vector_ids` flips within seconds when Workers AI is healthy. The 5-minute grace window is deliberately generous — real embeds complete in under a second. A slow embed that exceeds the window would briefly show "Not indexed" before flipping to Vectorized on the next reload; this is acceptable.

---

## Architecture

No schema migration required. `vector_ids` already exists in D1; `created_at` is already Unix ms. The grace window is the only new concept.

```
D1 entries.vector_ids    →  status logic (grace window)  →  UI badge
                         →  /stats unvectorized count
                         →  /vectorize-pending eligibility
```

---

## Changes

### 1. Config — grace window env var

**`wrangler.toml`:** Add `[vars]` block:
```toml
[vars]
VECTORIZE_GRACE_MS = "300000"
```

**`src/index.ts` `Env` interface (line 11):** Add optional field:
```ts
VECTORIZE_GRACE_MS?: string;
```

**New helper `graceMs(env)`** (add near top of handler logic, before `/stats`):
```ts
function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}
```

Reused by `/stats`, `/vectorize-pending`, and surfaced to the frontend via the `/stats` response.

---

### 2. Backend — expose `vector_ids` on `/list`

**`buildEntryFilterQuery()` (`src/index.ts:515`)** — add `vector_ids` to the SELECT:
```ts
let sql = `SELECT id, content, tags, source, created_at, vector_ids FROM entries`;
```

Non-breaking: the MCP `list_recent` caller (`src/index.ts:1358`) reads fields by name; `/list` returns raw rows so the column passes through to the UI.

---

### 3. `/stats` — failed count + grace window

**`/stats` handler (`src/index.ts:1602`)** — add `unvectorized` to the summary query using the grace cutoff as a bound parameter:

```ts
const graceCutoff = Date.now() - graceMs(env);
const [summary, tagRows, candidateRows] = await Promise.all([
  env.DB.prepare(
    `SELECT COUNT(*) as count,
            AVG(importance_score) as avg_importance,
            SUM(CASE WHEN vector_ids = '[]' AND created_at < ?1 THEN 1 ELSE 0 END) as unvectorized
     FROM entries`
  ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
  // ... existing tagRows and candidateRows queries unchanged
]);
```

Add to the JSON response:
```ts
return json({
  count: ...,
  avg_importance: ...,
  top_tags: ...,
  digest_candidates: ...,
  unvectorized: (summary?.unvectorized as number) ?? 0,
  vectorize_grace_ms: graceMs(env),
});
```

---

### 4. New endpoint — `POST /vectorize-pending`

Add after `/digest` (~line 1735). Authenticated via `requireAuth`. Selects only past-grace rows so in-flight memories are never re-triggered.

**Query:**
```sql
SELECT id, content, tags, source, created_at FROM entries
WHERE vector_ids = '[]' AND created_at < ?1
ORDER BY created_at DESC
LIMIT 25
```

**Processing:** For each row, call `await storeEntry(env, id, content, JSON.parse(tags), source, created_at)` in its own try/catch. One bad row must not abort the batch.

**Count remaining** after the batch with a separate COUNT query using the same cutoff.

**Response:**
```ts
return json({ processed: number, failed: number, remaining: number });
```

`remaining` lets the frontend loop until zero. Batch cap of 25 keeps within Workers CPU/subrequest limits.

**Duplicate vector concern:** Vector IDs are deterministic (`id` for single-chunk, `${id}-chunk-${i}` for multi-chunk). If Vectorize received a partial insert before the D1 UPDATE failed, re-inserting the same IDs will upsert (Vectorize treats same ID as update). Safe to re-run.

---

### 5. Frontend — three-state badge on Recent cards

**`makeRecentCard()` (`public/index.html:2884`)** — add vectorization state logic after the tags parse:

```js
let vectorIds = []
try { vectorIds = JSON.parse(entry.vector_ids || '[]') } catch {}
const vectorized = vectorIds.length > 0
// Pending state is computed at render time; won't auto-flip — reload required
const pending = !vectorized && (Date.now() - (entry.created_at || 0) < vectorizeGraceMs)
const vec = vectorized ? 'on' : (pending ? 'pending' : 'off')
```

**Chip HTML** appended into `.card-tags` after the synthesized chip:
```html
<!-- vec === 'on' -->
<span class="tag-chip vec-chip vec-chip--on" title="Vectorized — searchable via recall">
  <i class="ti ti-circle-check"></i>
</span>

<!-- vec === 'pending' -->
<span class="tag-chip vec-chip vec-chip--pending" title="Vectorizing… (just captured)">
  <i class="ti ti-clock"></i>
</span>

<!-- vec === 'off' -->
<span class="tag-chip vec-chip vec-chip--off" title="Not vectorized — won't appear in recall">
  Not indexed
</span>
```

**CSS** (near existing chip styles, ~line 975): New classes reuse existing CSS vars:

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

**Global `vectorizeGraceMs`** — add to the script globals block (~line 2496):
```js
let vectorizeGraceMs = 300000
```

Refreshed from `/stats` in `loadMenuStats()` so frontend and backend stay in sync.

Recall cards are untouched — recall results come from Vectorize and are always vectorized.

---

### 6. Frontend — "Vectorize now" action in stats menu

**HTML** (`public/index.html`, after `#digest-section` at line 2470):
```html
<div class="digest-section" id="vectorize-section" style="display:none"></div>
```

**`loadMenuStats()`** — after setting `vectorizeGraceMs` from `data.vectorize_grace_ms`, conditionally render the vectorize section mirroring `renderDigestSection`:

```js
vectorizeGraceMs = data.vectorize_grace_ms ?? vectorizeGraceMs
renderVectorizeSection(data.unvectorized ?? 0)
```

**`renderVectorizeSection(count)`** — only shows when `count > 0`:
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
```

**`runVectorize(btn)`** — POSTs `/vectorize-pending`, loops while `remaining > 0`, then refreshes stats + recent list:
```js
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

---

## Files Changed

| File | Change |
|---|---|
| `wrangler.toml` | Add `[vars]` block with `VECTORIZE_GRACE_MS = "300000"` |
| `src/index.ts` | `Env` interface, `graceMs()` helper, `buildEntryFilterQuery` SELECT, `/stats` query + response, new `POST /vectorize-pending` |
| `public/index.html` | `vectorizeGraceMs` global, `makeRecentCard` badge logic + CSS, `#vectorize-section` HTML, `renderVectorizeSection`, `runVectorize`, `loadMenuStats` updates |
| `db/schema.sql` | Reference only — `vector_ids` already exists, no migration needed |

---

## Verification Steps

1. `npm run dev` (or `wrangler dev`).
2. Capture a memory → Recent card shows **Vectorizing…** chip for up to 5 min, then (after reload) **Vectorized** once `storeEntry` completes.
3. Simulate failure: back-date a row past the grace window:
   ```
   wrangler d1 execute second-brain-db --command \
     "UPDATE entries SET vector_ids='[]', created_at=created_at-600000 WHERE id='<id>'"
   ```
   → Card shows **Not indexed**.
4. Menu stats show failed count + **Vectorize now** button; click → `/vectorize-pending` re-embeds only past-grace rows, count drops to 0, chips flip to Vectorized, recall returns the memory.
5. Confirm in-progress rows (recent, `vector_ids = '[]'`, within grace window) are NOT counted in `unvectorized` and are skipped by `/vectorize-pending`.
6. Set `VECTORIZE_GRACE_MS = "10000"` in `wrangler.toml` and confirm the threshold shifts.

---

## Out of Scope

- Auto-retry on embed failure (a separate reliability concern)
- Recall cards vectorization badge (recall results are always vectorized by definition)
- Per-memory re-vectorize action on individual cards (batch repair via menu is sufficient)
