function openMenu() {
  document.getElementById('menu-sheet').classList.add('open')
  loadMenuStats()
  loadProfileName()
}
function closeMenu() {
  document.getElementById('menu-sheet').classList.remove('open')
}

async function loadProfileName() {
  const input = document.getElementById('profile-name')
  if (!input || !WORKER_URL || !AUTH_TOKEN) return
  try {
    const res = await fetch(`${WORKER_URL}/team/me`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (!res.ok) return
    const data = await res.json()
    if (data.profile?.name) input.value = data.profile.name
  } catch {}
}

async function saveProfileName() {
  const input = document.getElementById('profile-name')
  const name = (input?.value || '').trim()
  if (!name) return
  try {
    const res = await fetch(`${WORKER_URL}/team/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || t('team.actionFailed'))
    showToast(t('team.profileSaved'))
  } catch (e) {
    showToast(e.message || t('team.actionFailed'))
  }
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

// The count, the week, the most-used tags and the sources all live on home now
// (GET /brief), so this no longer renders any of them — showing the same numbers
// in two places just meant they could disagree, which is exactly what happened
// after a delete. What is left is the chore queue.
async function loadMenuStats() {
  try {
    const res = await fetch(`${WORKER_URL}/stats`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    vectorizeGraceMs = data.vectorize_grace_ms ?? vectorizeGraceMs
    renderDigestSection(data.digest_candidates ?? [])
    renderVectorizeSection(data.unvectorized ?? 0)
    renderClassifySection(data.unclassified ?? 0)
    await loadPatternCount()
  } catch {
  } finally {
    syncUpkeepGroup()
  }
}

/** The five chore panels, in the order they appear under "Upkeep". */
const UPKEEP_SECTIONS = ['patterns-section', 'digest-section', 'vectorize-section', 'classify-section', 'restore-section']

/**
 * A heading over nothing reads as a broken screen, and a brain with no chores
 * pending is the normal case — so the whole group goes when every panel inside
 * it has hidden itself.
 */
function syncUpkeepGroup() {
  const group = document.getElementById('upkeep-group')
  if (!group) return
  group.hidden = !UPKEEP_SECTIONS.some((id) => {
    const el = document.getElementById(id)
    return el && el.style.display !== 'none'
  })
}

/** How many compression candidates to show before the list becomes a chore wall. */
const DIGEST_VISIBLE = 4

function digestCandidateRow(c) {
  return `
      <div class="digest-candidate-row" id="digest-row-${escAttr(c.tag)}">
        <div class="digest-candidate-label">
          <span>${escHtml(c.tag)}</span>
          <span class="digest-candidate-count">${escHtml(tPlural('upkeep.digestEntries', c.count))}</span>
        </div>
        <button class="digest-btn" onclick="runDigest('${escAttr(c.tag)}', this)">${escHtml(t('upkeep.digestAction'))}</button>
      </div>`
}

function renderDigestSection(candidates) {
  const el = document.getElementById('digest-section')
  if (!candidates.length) {
    el.style.display = 'none'
    return
  }
  el.style.display = ''
  // Candidates arrive largest-first, and the tail is always the least worth
  // doing. Nine identical rows read as a backlog someone is failing to keep up
  // with; four read as a suggestion, with the rest one tap away.
  const shown = candidates.slice(0, DIGEST_VISIBLE)
  const rest = candidates.slice(DIGEST_VISIBLE)
  el.innerHTML = `
    <div class="digest-section-label">${escHtml(t('upkeep.digestLabel'))}</div>
    <p class="digest-note">${escHtml(t('upkeep.digestNote'))}</p>
    ${shown.map(digestCandidateRow).join('')}
    ${
      rest.length
        ? `<div id="digest-rest" hidden>${rest.map(digestCandidateRow).join('')}</div>
           <button class="digest-more" id="digest-more" onclick="showAllDigestCandidates()">${escHtml(t('upkeep.digestMore', { n: rest.length }))}</button>`
        : ''
    }
  `
}

function showAllDigestCandidates() {
  const rest = document.getElementById('digest-rest')
  const btn = document.getElementById('digest-more')
  if (rest) rest.hidden = false
  if (btn) btn.remove()
}

async function runDigest(tag, btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.working'))}`
  const row = document.getElementById('digest-row-' + tag)
  try {
    const res = await fetch(`${WORKER_URL}/digest?tag=${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (data.synthesis) {
      btn.classList.remove('digest-btn--loading')
      btn.innerHTML = `<i class="ti ti-check"></i> ${escHtml(t('upkeep.done'))}`
      btn.style.color = 'var(--good)'
      setTimeout(() => {
        row.innerHTML = `<div class="digest-result"><strong>${escHtml(tag)}</strong> — ${escHtml(data.synthesis)}<div class="digest-result-meta"><i class="ti ti-lock"></i> ${escHtml(tPlural('upkeep.digestPreserved', data.source_count))}</div></div>`
      }, 700)
    } else {
      btn.classList.remove('digest-btn--loading')
      btn.innerHTML = '<i class="ti ti-alert-triangle"></i> ' + escHtml(data.error ?? t('upkeep.digestFailed'))
      btn.style.color = 'var(--danger)'
      setTimeout(() => {
        btn.disabled = false
        btn.innerHTML = escHtml(t('upkeep.digestAction'))
        btn.style.color = ''
      }, 3000)
    }
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-wifi-off"></i> ${escHtml(t('upkeep.requestFailed'))}`
    btn.style.color = 'var(--danger)'
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = escHtml(t('upkeep.digestAction'))
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
    <div class="digest-section-label">${escHtml(t('upkeep.vectorizeLabel'))}</div>
    <p class="digest-note">${escHtml(tPlural('upkeep.vectorizeNote', count))}</p>
    <button class="digest-btn" id="vectorize-btn" onclick="runVectorize(this)">${escHtml(t('upkeep.vectorizeAction'))}</button>
  `
}

async function runVectorize(btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.working'))}`
  try {
    let remaining = 1
    let totalProcessed = 0
    while (remaining > 0) {
      const res = await fetch(`${WORKER_URL}/vectorize-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
      if ((data.processed ?? 0) === 0 && remaining > 0) break
    }
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-check"></i> ${escHtml(t('upkeep.vectorizeDone', { n: totalProcessed }))}`
    btn.style.color = 'var(--good)'
    await loadMenuStats()
    refreshAll()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-wifi-off"></i> ${escHtml(t('upkeep.requestFailed'))}`
    btn.style.color = 'var(--danger)'
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = escHtml(t('upkeep.vectorizeAction'))
      btn.style.color = ''
    }, 3000)
  }
}

function renderClassifySection(count) {
  const el = document.getElementById('classify-section')
  if (!count) { el.style.display = 'none'; return }
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">${escHtml(t('upkeep.classifyLabel'))}</div>
    <p class="digest-note">${escHtml(tPlural('upkeep.classifyNote', count))}</p>
    <button class="digest-btn" id="classify-btn" onclick="runClassify(this)">${escHtml(t('upkeep.classifyAction'))}</button>
  `
}

async function runClassify(btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.working'))}`
  try {
    let remaining = 1
    let prevRemaining = Infinity
    let totalProcessed = 0
    while (remaining > 0) {
      const res = await fetch(`${WORKER_URL}/classify-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
      })
      if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
      if (remaining >= prevRemaining) break
      prevRemaining = remaining
    }
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-check"></i> ${escHtml(t('upkeep.classifyDone', { n: totalProcessed }))}`
    btn.style.color = 'var(--good)'
    await loadMenuStats()
    refreshAll()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-wifi-off"></i> ${escHtml(t('upkeep.requestFailed'))}`
    btn.style.color = 'var(--danger)'
    setTimeout(() => {
      btn.disabled = false
      btn.innerHTML = escHtml(t('upkeep.classifyAction'))
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
    if (stalled) throw new Error(t('upkeep.importStalled'))
  }
}

// Revealing the panel has to reveal the group above it, or a restore in progress
// renders under a heading that is still hidden.
function restoreSection() {
  const el = document.getElementById('restore-section')
  el.style.display = ''
  syncUpkeepGroup()
  return el
}

function renderRestoreProgress(label, done, total) {
  const el = restoreSection()
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">${escHtml(t('upkeep.restoreLabel'))}</div>
    <p class="digest-note">${label}</p>
    <button class="digest-btn digest-btn--loading" disabled><i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.restoreOf', { done: done.toLocaleString(localeTag()), total: total.toLocaleString(localeTag()) }))}</button>
  `
}

function renderRestoreFailure(message) {
  const el = restoreSection()
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">${escHtml(t('upkeep.restoreLabel'))}</div>
    <p class="digest-note">${message} ${escHtml(t('upkeep.restoreFailureTail'))}</p>
    <button class="digest-btn" onclick="restoreFromBackup()">${escHtml(t('upkeep.restoreTryAgain'))}</button>
  `
}

function renderRestoreDone(totals) {
  const el = restoreSection()
  const parts = [t('upkeep.restoreSummaryRestored', { n: totals.imported.toLocaleString(localeTag()) })]
  if (totals.edges_imported) parts.push(t('upkeep.restoreSummaryConnections', { n: totals.edges_imported.toLocaleString(localeTag()) }))
  if (totals.skipped) parts.push(t('upkeep.restoreSummaryPresent', { n: totals.skipped.toLocaleString(localeTag()) }))
  const failures = totals.failed + totals.edges_failed
  const failNote = failures
    ? ` ${t('upkeep.restoreFailNote', { n: failures.toLocaleString(localeTag()) })}`
    : ''
  const needsIndexing = totals.imported > 0
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">${escHtml(t('upkeep.restoreLabel'))}</div>
    <p class="digest-note"><i class="ti ti-check"></i> ${escHtml(parts.join(' · '))}.${escHtml(failNote)}${
      needsIndexing ? ` ${escHtml(t('upkeep.restoreNeedsIndex'))}` : ''
    }</p>
    ${needsIndexing ? `<button class="digest-btn" onclick="indexRestored(this)">${escHtml(t('upkeep.restoreMakeSearchable'))}</button>` : ''}
  `
}

/** Stage two: the same /vectorize-pending loop the "Not indexed" section runs,
 * kept inside the restore flow so finishing doesn't require finding another
 * button elsewhere in the menu. */
async function indexRestored(btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.restoreIndexing'))}`
  try {
    let remaining = 1
    let totalProcessed = 0
    while (remaining > 0) {
      const res = await fetch(`${WORKER_URL}/vectorize-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
      const data = await res.json()
      remaining = data.remaining ?? 0
      totalProcessed += data.processed ?? 0
      btn.innerHTML = remaining
        ? `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.restoreIndexingProgress', { done: totalProcessed.toLocaleString(localeTag()), remaining: remaining.toLocaleString(localeTag()) }))}`
        : `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.restoreIndexingDoneOnly', { done: totalProcessed.toLocaleString(localeTag()) }))}`
      if ((data.processed ?? 0) === 0 && remaining > 0) break
    }
    btn.classList.remove('digest-btn--loading')
    if (remaining > 0) {
      // Workers AI quota ran dry mid-backfill — the daily reset finishes the job.
      btn.disabled = false
      btn.innerHTML = escHtml(t('upkeep.restoreQuotaLeft', { n: remaining.toLocaleString(localeTag()) }))
    } else {
      btn.innerHTML = `<i class="ti ti-check"></i> ${escHtml(t('upkeep.restoreAllSearchable'))}`
      btn.style.color = 'var(--good)'
    }
    await loadMenuStats()
    refreshAll()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.disabled = false
    btn.innerHTML = `<i class="ti ti-wifi-off"></i> ${escHtml(t('upkeep.restoreIndexFailed'))}`
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
    renderRestoreFailure(t('upkeep.restoreInvalidJson', { filename: `<strong>${escHtml(file.name)}</strong>` }))
    return
  }
  if (!payload || !Array.isArray(payload.entries)) {
    renderRestoreFailure(t('upkeep.restoreNotBackup', { filename: `<strong>${escHtml(file.name)}</strong>` }))
    return
  }

  const total = payload.entries.length + (payload.edges || []).length
  renderRestoreProgress(t('upkeep.restoreProgress', { filename: `<strong>${escHtml(file.name)}</strong>` }), 0, total)
  try {
    const totals = await runImportLoop(
      payload,
      async (query) => {
        const res = await fetch(`${WORKER_URL}/import?${query}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
        return res.json()
      },
      ({ done }) => renderRestoreProgress(t('upkeep.restoreProgress', { filename: `<strong>${escHtml(file.name)}</strong>` }), done, total),
    )
    renderRestoreDone(totals)
    await loadMenuStats()
    refreshAll()
  } catch (e) {
    renderRestoreFailure(t('upkeep.restoreStopped'))
  }
}

async function exportMemories(format) {
  closeMenu()
  try {
    // /export returns everything — entries AND edges — in one shot; /list caps
    // at 100 rows, which used to silently truncate bigger brains
    const res = await fetch(`${WORKER_URL}/export`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
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
      const lines = [t('menu.exportMdTitle'), t('menu.exportMdExported', { date: ts }), '']
      entries.forEach((e, i) => {
        const tags = e.tags || []
        const date = formatDateUI(e.created_at, { year: 'numeric', month: 'short', day: 'numeric' })
        lines.push(t('menu.exportMdMemory', { n: i + 1 }))
        lines.push(t('menu.exportMdDate', { date }))
        if (tags.length) lines.push(t('menu.exportMdTags', { tags: tags.join(', ') }))
        if (e.source) lines.push(t('menu.exportMdSource', { source: e.source }))
        lines.push('')
        lines.push(e.content)
        lines.push('')
        lines.push('---')
        lines.push('')
      })
      if (edges.length) {
        const labelById = new Map(entries.map((e) => [e.id, (e.content || '').slice(0, 60)]))
        lines.push(t('menu.exportMdRelationships'))
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

    // The one downloader (public/utils.js), shared with the activity CSV
    // export. Same content, same filename, same mime as when those five lines
    // lived here — the BOM branch inside it is for text/csv only.
    downloadTextFile(document, content, filename, mime)
  } catch (e) {
    showToast(t('menu.exportFailed', { message: e.message }))
  }
}
