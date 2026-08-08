function openMenu() {
  document.getElementById('menu-sheet').classList.add('open')
  loadMenuStats()
}
function closeMenu() {
  document.getElementById('menu-sheet').classList.remove('open')
}

function openIntegrations() {
  closeMenu()
  currentCategory = null
  document.getElementById('integrations-sheet').classList.add('open')
  loadIntegrations()
}
function closeIntegrations() {
  document.getElementById('integrations-sheet').classList.remove('open')
}
function backToMenu() {
  closeIntegrations()
  openMenu()
}

async function loadMenuStats() {
  try {
    const res = await fetch(`${WORKER_URL}/stats`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    document.getElementById('stats-count').textContent = (data.count ?? 0).toLocaleString()
    document.getElementById('stats-importance').textContent = data.avg_importance != null ? data.avg_importance.toFixed(1) + ' / 5' : '—'
    const tagsEl = document.getElementById('stats-tags')
    tagsEl.innerHTML = data.top_tags?.length
      ? data.top_tags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')
      : '<span style="font-size:13px;color:var(--text-tertiary)">No tags yet</span>'
    vectorizeGraceMs = data.vectorize_grace_ms ?? vectorizeGraceMs
    renderDigestSection(data.digest_candidates ?? [])
    renderVectorizeSection(data.unvectorized ?? 0)
    renderClassifySection(data.unclassified ?? 0)
    loadPatterns()
  } catch {}
}

// ── Patterns panel: system proposes, human ratifies ───────────────────────
// Auto-derived patterns are excluded from recall until confirmed; confirming
// strips the auto-pattern tag (which is the exclusion), dismissing deprecates.
async function loadPatterns() {
  const el = document.getElementById('patterns-section')
  try {
    const res = await fetch(`${WORKER_URL}/list?n=20&tag=auto-pattern`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const rows = await res.json()
    const patterns = (Array.isArray(rows) ? rows : []).filter((e) => {
      let tags = []
      try {
        tags = JSON.parse(e.tags || '[]')
      } catch {}
      return !tags.includes('status:deprecated') // dismissed patterns linger in /list
    })
    if (!patterns.length) {
      el.style.display = 'none'
      el.innerHTML = ''
      return
    }
    el.style.display = ''
    el.innerHTML = `
      <div class="digest-section-label">Patterns noticed</div>
      <p class="digest-note">Your brain spotted these across multiple memories. Confirm to make one a trusted, recallable fact; dismiss to discard it.</p>
      ${patterns
        .map(
          (p) => `
        <div class="digest-result" id="pattern-row-${escAttr(p.id)}">
          ${escHtml(p.content)}
          <div style="display: flex; gap: 8px; margin-top: 10px">
            <button class="digest-btn" onclick="resolvePattern('${escAttr(p.id)}', 'confirm', this)">Confirm</button>
            <button class="digest-btn danger" onclick="resolvePattern('${escAttr(p.id)}', 'dismiss', this)">Dismiss</button>
          </div>
        </div>`,
        )
        .join('')}
    `
  } catch {}
}

async function resolvePattern(id, action, btn) {
  const row = document.getElementById('pattern-row-' + id)
  row.querySelectorAll('button').forEach((b) => (b.disabled = true))
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Working…'
  try {
    const res = await fetch(`${WORKER_URL}/patterns/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    if (action === 'dismiss') {
      row.classList.add('explode-out')
      setTimeout(() => {
        row.innerHTML = `<div class="digest-result-meta">Dismissed</div>`
        row.classList.remove('explode-out')
        row.style.opacity = '1'
      }, 400)
    } else {
      row.style.transition = 'opacity 0.4s'
      row.style.opacity = '0'
      setTimeout(() => {
        row.innerHTML = `<div class="digest-result-meta"><i class="ti ti-check"></i> Saved as a trusted memory</div>`
        row.style.opacity = '1'
      }, 400)
    }
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = '<i class="ti ti-alert-triangle"></i> Failed'
    setTimeout(() => loadPatterns(), 2000)
  }
}

function renderDigestSection(candidates) {
  const el = document.getElementById('digest-section')
  if (!candidates.length) {
    el.style.display = 'none'
    return
  }
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">Ready to compress</div>
    <p class="digest-note">Originals are never deleted — digest adds a summary and ranks originals lower in recall so they don't crowd results.</p>
    ${candidates
      .map(
        (c) => `
      <div class="digest-candidate-row" id="digest-row-${escAttr(c.tag)}">
        <div class="digest-candidate-label">
          <span>${escHtml(c.tag)}</span>
          <span class="digest-candidate-count">${c.count} entries</span>
        </div>
        <button class="digest-btn" onclick="runDigest('${escAttr(c.tag)}', this)">Digest →</button>
      </div>
    `,
      )
      .join('')}
  `
}

async function runDigest(tag, btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Working…'
  const row = document.getElementById('digest-row-' + tag)
  try {
    const res = await fetch(`${WORKER_URL}/digest?tag=${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (data.synthesis) {
      btn.classList.remove('digest-btn--loading')
      btn.innerHTML = '<i class="ti ti-check"></i> Done'
      btn.style.color = 'var(--good)'
      setTimeout(() => {
        row.innerHTML = `<div class="digest-result"><strong>${escHtml(tag)}</strong> — ${escHtml(data.synthesis)}<div class="digest-result-meta"><i class="ti ti-lock"></i> ${data.source_count} original memories preserved &amp; still searchable</div></div>`
      }, 700)
    } else {
      btn.classList.remove('digest-btn--loading')
      btn.innerHTML = '<i class="ti ti-alert-triangle"></i> ' + escHtml(data.error ?? 'Could not create digest')
      btn.style.color = 'var(--danger)'
      setTimeout(() => {
        btn.disabled = false
        btn.innerHTML = 'Digest →'
        btn.style.color = ''
      }, 3000)
    }
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = '<i class="ti ti-wifi-off"></i> Request failed'
    btn.style.color = 'var(--danger)'
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = 'Digest →'
      btn.style.color = ''
    }, 3000)
  }
}

function renderVectorizeSection(count) {
  const el = document.getElementById('vectorize-section')
  if (!count) {
    el.style.display = 'none'
    return
  }
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
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
      if ((data.processed ?? 0) === 0 && remaining > 0) break
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

function renderClassifySection(count) {
  const el = document.getElementById('classify-section')
  if (!count) { el.style.display = 'none'; return }
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">Not classified</div>
    <p class="digest-note">${count} ${count === 1 ? 'memory has' : 'memories have'} no kind or status tag yet (captured before classification existed).</p>
    <button class="digest-btn" id="classify-btn" onclick="runClassify(this)">Classify now →</button>
  `
}

async function runClassify(btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Working…'
  try {
    let remaining = 1
    let prevRemaining = Infinity
    let totalProcessed = 0
    while (remaining > 0) {
      const res = await fetch(`${WORKER_URL}/classify-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
      if (remaining >= prevRemaining) break
      prevRemaining = remaining
    }
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-check"></i> Done — ${totalProcessed} classified`
    btn.style.color = 'var(--good)'
    await loadMenuStats()
    loadRecent()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = '<i class="ti ti-wifi-off"></i> Request failed'
    btn.style.color = 'var(--danger)'
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = 'Classify now →'
      btn.style.color = ''
    }, 3000)
  }
}

// ---- Restore from backup -------------------------------------------------
//
// The counterpart to "Back up as JSON", and a two-stage flow by design. Stage
// one walks POST /import's cursor — one call per page, because a whole restore
// in one request would blow the D1 free plan's per-invocation query budget, and
// a 5,000-entry file is ~125 sequential calls nobody should run by hand. Stage
// two matters just as much: imported entries carry no embeddings, so recall
// cannot see them until they are indexed. A restore that ends before search
// works would look complete and be broken — so the flow carries the user
// straight into "Make searchable", which spends Workers AI quota only when
// they choose to.

/**
 * Walk the /import cursor until entries and edges are both exhausted.
 *
 * Split from the DOM so the paging protocol is testable: `post` is
 * `(query) => Promise<summary>`, `onProgress` gets running totals per page.
 * Re-running after a failure is safe — the server skips existing ids — which
 * is why this throws on error and lets the caller offer a retry.
 */
async function runImportLoop(payload, post, onProgress) {
  const totals = { imported: 0, skipped: 0, failed: 0, edges_imported: 0, edges_skipped: 0, edges_failed: 0 }
  let offset = 0
  let edgeOffset = 0
  const totalEntries = (payload.entries || []).length
  const totalEdges = (payload.edges || []).length

  for (;;) {
    const data = await post(`offset=${offset}&edge_offset=${edgeOffset}`)
    totals.imported += data.imported || 0
    totals.skipped += data.skipped || 0
    totals.failed += data.failed || 0
    totals.edges_imported += data.edges_imported || 0
    totals.edges_skipped += data.edges_skipped || 0
    totals.edges_failed += data.edges_failed || 0

    // Apply the fallback BEFORE the stall check: a pre-cursor Worker echoes no
    // next_offset at all, and comparing against undefined would wave it through
    // into an infinite loop — the exact case the check exists for.
    const nextOffset = data.next_offset ?? offset
    const nextEdgeOffset = data.next_edge_offset ?? edgeOffset
    const stalled = nextOffset === offset && nextEdgeOffset === edgeOffset
    offset = nextOffset
    edgeOffset = nextEdgeOffset
    if (onProgress) onProgress({ done: Math.min(offset + edgeOffset, totalEntries + totalEdges), total: totalEntries + totalEdges, totals })

    if ((data.remaining_entries || 0) === 0 && (data.remaining_edges || 0) === 0) return totals
    if (stalled) throw new Error('Server did not advance the import cursor — is the Worker up to date?')
  }
}

function restoreSection() {
  return document.getElementById('restore-section')
}

function renderRestoreProgress(label, done, total) {
  const el = restoreSection()
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">Restore</div>
    <p class="digest-note">${label}</p>
    <button class="digest-btn digest-btn--loading" disabled><i class="ti ti-loader-2"></i> ${done.toLocaleString()} of ${total.toLocaleString()}</button>
  `
}

function renderRestoreFailure(message) {
  const el = restoreSection()
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">Restore</div>
    <p class="digest-note">${message} Your backup file is untouched, and it's safe to try again — anything already restored will be skipped, not duplicated.</p>
    <button class="digest-btn" onclick="restoreFromBackup()">Try again →</button>
  `
}

function renderRestoreDone(totals) {
  const el = restoreSection()
  const parts = [`${totals.imported.toLocaleString()} restored`]
  if (totals.edges_imported) parts.push(`${totals.edges_imported.toLocaleString()} connections`)
  if (totals.skipped) parts.push(`${totals.skipped.toLocaleString()} already present`)
  const failures = totals.failed + totals.edges_failed
  const failNote = failures
    ? ` ${failures.toLocaleString()} ${failures === 1 ? 'item' : 'items'} couldn't be restored — usually rows edited by hand; the rest are unaffected.`
    : ''
  const needsIndexing = totals.imported > 0
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">Restore</div>
    <p class="digest-note"><i class="ti ti-check"></i> ${parts.join(' · ')}.${failNote}${
      needsIndexing ? ' Restored memories can\'t be searched until they\'re indexed.' : ''
    }</p>
    ${needsIndexing ? '<button class="digest-btn" onclick="indexRestored(this)">Make searchable →</button>' : ''}
  `
}

/** Stage two: the same /vectorize-pending loop the "Not indexed" section runs,
 * kept inside the restore flow so finishing doesn't require finding another
 * button elsewhere in the menu. */
async function indexRestored(btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Indexing…'
  try {
    let remaining = 1
    let totalProcessed = 0
    while (remaining > 0) {
      const res = await fetch(`${WORKER_URL}/vectorize-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
      btn.innerHTML = `<i class="ti ti-loader-2"></i> Indexing… ${totalProcessed.toLocaleString()} done${remaining ? `, ${remaining.toLocaleString()} to go` : ''}`
      if ((data.processed ?? 0) === 0 && remaining > 0) break
    }
    btn.classList.remove('digest-btn--loading')
    if (remaining > 0) {
      // Workers AI quota ran dry mid-backfill — the daily reset finishes the job.
      btn.disabled = false
      btn.innerHTML = `${remaining.toLocaleString()} left — daily AI limit reached, try tomorrow`
    } else {
      btn.innerHTML = '<i class="ti ti-check"></i> All restored memories are searchable'
      btn.style.color = 'var(--good)'
    }
    await loadMenuStats()
    loadRecent()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-wifi-off"></i> Failed — tap to retry'
    btn.style.color = 'var(--danger)'
    btn.onclick = () => indexRestored(btn)
  }
}

function pickBackupFile() {
  return new Promise((resolveFile) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    // A cancelled picker fires no event; the unresolved promise is harmless.
    input.onchange = () => resolveFile(input.files && input.files[0] ? input.files[0] : null)
    input.click()
  })
}

async function restoreFromBackup() {
  const file = await pickBackupFile()
  if (!file) return

  let payload
  try {
    payload = JSON.parse(await file.text())
  } catch {
    renderRestoreFailure(`<strong>${file.name}</strong> isn't valid JSON.`)
    return
  }
  if (!payload || !Array.isArray(payload.entries)) {
    renderRestoreFailure(`<strong>${file.name}</strong> doesn't look like a Second Brain backup — it has no entries list. Use a file created by "Back up as JSON".`)
    return
  }

  const total = payload.entries.length + (payload.edges || []).length
  renderRestoreProgress(`Restoring from <strong>${file.name}</strong>…`, 0, total)
  try {
    const totals = await runImportLoop(
      payload,
      async (query) => {
        const res = await fetch(`${WORKER_URL}/import?${query}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(`Server error: ${res.status}`)
        return res.json()
      },
      ({ done }) => renderRestoreProgress(`Restoring from <strong>${file.name}</strong>…`, done, total),
    )
    renderRestoreDone(totals)
    await loadMenuStats()
    loadRecent()
  } catch (e) {
    renderRestoreFailure('The restore stopped partway.')
  }
}

async function exportMemories(format) {
  closeMenu()
  try {
    // /export returns everything — entries AND edges — in one shot; /list caps
    // at 100 rows, which used to silently truncate bigger brains
    const res = await fetch(`${WORKER_URL}/export`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) throw new Error(`Server error: ${res.status}`)
    const data = await res.json()
    const entries = data.entries || []
    const edges = data.edges || []

    let content, filename, mime
    const ts = new Date().toISOString().slice(0, 10)

    if (format === 'json') {
      content = JSON.stringify(data, null, 2)
      filename = `second-brain-export-${ts}.json`
      mime = 'application/json'
    } else {
      const lines = [`# Second Brain Export`, `Exported: ${ts}`, '']
      entries.forEach((e, i) => {
        const tags = e.tags || []
        const date = new Date(e.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        lines.push(`## Memory ${i + 1}`)
        lines.push(`**Date:** ${date}`)
        if (tags.length) lines.push(`**Tags:** ${tags.join(', ')}`)
        if (e.source) lines.push(`**Source:** ${e.source}`)
        lines.push('')
        lines.push(e.content)
        lines.push('')
        lines.push('---')
        lines.push('')
      })
      if (edges.length) {
        const labelById = new Map(entries.map((e) => [e.id, (e.content || '').slice(0, 60)]))
        lines.push(`## Relationships`)
        lines.push('')
        edges.forEach((e) => {
          const src = labelById.get(e.source_id) || e.source_id
          const tgt = labelById.get(e.target_id) || e.target_id
          lines.push(`- [${e.type}] ${src} -> ${tgt} (${e.weight})`)
        })
        lines.push('')
      }
      content = lines.join('\n')
      filename = `second-brain-export-${ts}.md`
      mime = 'text/markdown'
    }

    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert('Export failed: ' + e.message)
  }
}
