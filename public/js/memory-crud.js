function openAppend(id, preview) {
  pendingAppendId = id
  document.getElementById('append-context-preview').textContent = preview + '...'
  document.getElementById('append-textarea').value = ''
  document.getElementById('append-sheet').classList.add('open')
  setTimeout(() => document.getElementById('append-textarea').focus(), 100)
}
// Some memories arrive without an id — recall results from an older Worker, and
// the synthesized rows the digest writes — so there is nothing to append to.
// Writing a fresh memory is the honest fallback, which used to mean the Remember
// tab and now means home, with the mode already set so the field does not guess.
function openAppendFromContent() {
  switchTab('home')
  returnHome()
  const field = document.getElementById('home-field')
  if (!field) return
  lockHomeMode('remember')
  field.focus()
}
function closeAppend() {
  document.getElementById('append-sheet').classList.remove('open')
  pendingAppendId = null
}
async function saveAppend() {
  const addition = document.getElementById('append-textarea').value.trim()
  if (!addition || !pendingAppendId) return
  const btn = document.getElementById('append-save-btn')
  btn.disabled = true
  btn.textContent = t('memories.saving')
  try {
    const appendedId = pendingAppendId
    await apiMcp('append', { id: appendedId, addition })
    closeAppend()
    notifyMemoryResolved(appendedId)
    refreshAll()
  } catch (e) {
    btn.disabled = false
    btn.textContent = t('memories.appendSave')
    alert(t('memories.appendFailed', { message: e.message }))
  }
}

// The tags the sheet is currently offering to save. Held separately from the
// entry so that removing one and then cancelling changes nothing.
let pendingEditTags = []

function openEdit(id, content, tags) {
  pendingEditId = id
  // The brain's own bookkeeping — kind:, volatility:, status: — was rendering
  // as chips here long after every other surface learned to hide it. It is also
  // not the user's to delete, so it is neither shown nor sent.
  pendingEditTags = humanTags(tags)
  renderEditTags()
  const sub = document.getElementById('edit-sub')
  if (sub) sub.textContent = titleLine(content, 60)

  const ta = document.getElementById('edit-textarea')
  ta.value = content
  document.getElementById('edit-sheet').classList.add('open')
  setTimeout(() => {
    ta.focus()
    // Focusing a textarea whose value was just set puts the caret at the end and
    // scrolls there, which on a long memory opened the editor somewhere in the
    // middle of the text. Editing should start where reading starts.
    ta.setSelectionRange(0, 0)
    ta.scrollTop = 0
  }, 100)
}

function renderEditTags() {
  const el = document.getElementById('edit-existing-tags')
  if (!el) return
  el.innerHTML = pendingEditTags
    .map(
      (tag, i) =>
        `<button type="button" class="tag-chip tag-chip--removable" onclick="removeEditTag(${i})" aria-label="${escAttr(t('memories.removeTag', { tag }))}">${escHtml(tag)}<i class="ti ti-x"></i></button>`,
    )
    .join('')
}

function removeEditTag(i) {
  pendingEditTags.splice(i, 1)
  renderEditTags()
}

function closeEdit() {
  document.getElementById('edit-sheet').classList.remove('open')
  pendingEditId = null
  pendingEditTags = []
}

async function saveEdit() {
  const newContent = document.getElementById('edit-textarea').value.trim()
  if (!newContent || !pendingEditId) return
  const btn = document.getElementById('edit-save-btn')
  btn.disabled = true
  btn.textContent = t('memories.saving')
  try {
    const res = await fetch(`${WORKER_URL}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      // Only the user's own tags travel. The Worker keeps its own — see
      // src/tags/system.ts — so an edit cannot delete a conclusion the brain reached.
      body: JSON.stringify({ id: pendingEditId, content: newContent, tags: pendingEditTags }),
    })
    if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
    const editedId = pendingEditId
    closeEdit()
    notifyMemoryResolved(editedId)
    refreshAll()
  } catch (e) {
    btn.disabled = false
    btn.textContent = t('memories.editSave')
    alert(t('memories.editFailed', { message: e.message }))
  }
}

function openConfirm(id, btnOrCard) {
  pendingForgetId = id
  pendingForgetCard = btnOrCard ? (btnOrCard.classList?.contains('memory-card') ? btnOrCard : btnOrCard.closest('.memory-card')) : null
  document.getElementById('confirm-dialog').classList.add('open')
}
function closeConfirm() {
  document.getElementById('confirm-dialog').classList.remove('open')
  pendingForgetId = null
  pendingForgetCard = null
}
/**
 * Tell any open list that this memory has been dealt with.
 *
 * The Memories screen is handled inline above — a row animation and a local
 * filter — but a sheet that holds its own copy of a list has no way to know an
 * action happened, and its row stays on screen looking like the action failed.
 * That is what the out-of-date queue did after a successful forget.
 *
 * A call rather than a reach: each list decides what an id means to it, and one
 * it is not showing has to leave it alone. Guarded so a page that never loaded
 * that module is unaffected.
 */
function notifyMemoryResolved(id) {
  if (typeof dropFromStaleQueue === 'function') dropFromStaleQueue(id)
}

async function confirmForget() {
  if (!pendingForgetId) return
  const idToForget = pendingForgetId
  const cardElement = pendingForgetCard
  const btn = document.querySelector('#confirm-dialog .btn-delete')
  if (btn) {
    btn.disabled = true
    btn.textContent = t('memories.forgetting')
  }

  try {
    await apiMcp('forget', { id: idToForget })
    closeConfirm()
    if (cardElement) {
      cardElement.style.transition = 'none'
      cardElement.classList.add('explode-out')
      setTimeout(() => cardElement?.remove(), 400)
    }
    allEntries = allEntries.filter((e) => e.id !== idToForget)
    notifyMemoryResolved(idToForget)
    // Everything except the list, which the row animation and the local filter
    // above have already handled — reloading it here would swap the element out
    // from under its own exit animation.
    refreshAll({ list: false })
  } catch (e) {
    alert(t('memories.forgetFailed', { message: e.message }))
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = t('memories.forget')
    }
  }
}

// ── What the brain thinks about one memory ────────────────────────────────
//
// The pipeline decides a great deal per entry — how important it is, whether
// it is a fact or an event, whether it has been superseded, how long it stays
// true, how often it has been recalled — and until v2.3 none of it was
// reachable from the UI. This is the one place that shows it, in plain
// language rather than the tag syntax it is stored as.

/** `kind:semantic` → localized label. Unknown values render as themselves. */
function viewKindLabel(kind) {
  if (kind === 'semantic') return t('memories.kindFact')
  if (kind === 'episodic') return t('memories.kindEvent')
  return kind
}

function viewStatusLabel(status) {
  if (status === 'canonical') return t('memories.statusTrusted')
  if (status === 'draft') return t('memories.statusUnconfirmed')
  if (status === 'deprecated') return t('memories.statusSuperseded')
  return status
}

/** Volatility is a promise about the future, so it is worth spelling out. */
function viewVolatility(volatility) {
  if (volatility === 'durable') return [t('memories.volDurable'), t('memories.volDurableGloss')]
  if (volatility === 'state') return [t('memories.volCurrent'), t('memories.volCurrentGloss')]
  if (volatility === 'volatile') return [t('memories.volShortLived'), t('memories.volShortLivedGloss')]
  return null
}

function tagValue(tags, prefix) {
  const hit = (tags || []).find((t) => String(t).toLowerCase().startsWith(prefix))
  return hit ? String(hit).slice(prefix.length).toLowerCase() : null
}

/** Importance as five dots — a number out of five means nothing on its own. */
function importanceDots(score) {
  const n = Math.max(0, Math.min(5, Math.round(Number(score) || 0)))
  return `<span class="dots" title="${escAttr(t('memories.importanceTitle', { n }))}">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`
}

function renderViewMeta(entry) {
  const el = document.getElementById('view-meta')
  const badge = sourceBadge(entry.source)
  const created = Number(entry.created_at) || 0
  const updated = Number(entry.updated_at) || 0
  const parts = [`<span class="view-meta-item"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>`]
  if (created) {
    parts.push(`<span class="view-meta-item" title="${escAttr(new Date(created).toLocaleString(localeTag()))}">${escHtml(t('memories.metaCaptured', { relative: relativeTime(created) }))}</span>`)
  }
  // Only worth saying when it actually differs — every row has an updated_at.
  if (updated && created && Math.abs(updated - created) > 60000) {
    parts.push(`<span class="view-meta-item" title="${escAttr(new Date(updated).toLocaleString(localeTag()))}">${escHtml(t('memories.metaEdited', { relative: relativeTime(updated) }))}</span>`)
  }
  el.innerHTML = parts.join('')
}

function renderViewBrain(entry) {
  const el = document.getElementById('view-brain')
  // Rendered from the tags when /entry has not been consulted (recall cards
  // pass what they already have), so the section degrades rather than vanishing.
  const tags = entry.tags || []
  const kind = tagValue(tags, 'kind:')
  const status = tagValue(tags, 'status:')
  const volatility = tagValue(tags, 'volatility:')
  const rows = []
  const notes = []

  if (typeof entry.importance_score === 'number') {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.importance'))}</span>${importanceDots(entry.importance_score)}</div>`)
  }
  if (kind) {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.kind'))}</span><strong>${escHtml(viewKindLabel(kind))}</strong></div>`)
  }
  if (status) {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.status'))}</span><strong>${escHtml(viewStatusLabel(status))}</strong></div>`)
  }
  const volPair = volatility ? viewVolatility(volatility) : null
  if (volPair) {
    const [label, gloss] = volPair
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.lifespan'))}</span><strong>${escHtml(label)}</strong></div>`)
    // Held back to the end: a sentence between two rows breaks the list it is
    // explaining, and the panel reads as facts first, then the caveats.
    notes.push(gloss)
  }
  if (typeof entry.recall_count === 'number' && entry.recall_count > 0) {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.recalled'))}</span><strong>${escHtml(tPlural('memories.recalledTimes', entry.recall_count))}</strong></div>`)
  }
  // Losing a contradiction means something newer disagreed with this. Silence
  // when it has never happened; it is not a scoreboard.
  const losses = Number(entry.contradiction_losses) || 0
  if (losses > 0) {
    notes.push(tPlural('memories.disagreed', losses))
  }
  for (const note of notes) {
    rows.push(`<div class="view-brain-note">${escHtml(note)}</div>`)
  }
  if (entry.indexed === false) {
    rows.push(`<div class="view-brain-note view-brain-note--warn">${escHtml(t('memories.notIndexedYet'))}</div>`)
  }

  if (!rows.length) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  el.style.display = ''
  el.innerHTML = `<div class="view-brain-label">${escHtml(t('memories.brainLabel'))}</div>${rows.join('')}`
}

/**
 * Fill in what the caller could not know.
 *
 * Recall cards and graph nodes hand over the fields they happen to hold, so
 * the sheet renders immediately from those and then upgrades in place once
 * /entry answers. One request, only when there is an id to ask about.
 */
async function hydrateView(id) {
  try {
    const res = await fetch(`${WORKER_URL}/entry?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok || !data.entry) return
    if (viewOpenId !== id) return // the sheet moved on while this was in flight
    renderViewMeta(data.entry)
    renderViewBrain(data.entry)
    renderViewTimeline(data.entry)
  } catch {}
}

function renderViewTimeline(entry) {
  const el = document.getElementById('view-timeline')
  if (!el) return
  const items = entry.timeline || []
  if (!items.length && !entry.actor_name) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  const lines = []
  if (entry.workspace === 'company' && entry.actor_name) {
    lines.push(`<div class="view-timeline-item">${escHtml(t('memories.authorLabel', { name: entry.actor_name }))}</div>`)
  }
  for (const item of items) {
    const when = item.created_at
      ? formatDateUI(item.created_at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : ''
    lines.push(`<div class="view-timeline-item">${escHtml(item.actor_name || '')} · ${escHtml(item.event || '')}${when ? ` · ${escHtml(when)}` : ''}</div>`)
  }
  el.style.display = ''
  el.innerHTML = `<div class="view-timeline-label">${escHtml(t('memories.timelineLabel'))}</div>${lines.join('')}`
}

/** Which memory the sheet is currently showing, so a late response can tell. */
let viewOpenId = null

function openView(entry, cardElement) {
  viewOpenId = entry.id || null
  document.getElementById('view-content-text').textContent = normalizeForDisplay(entry.content)
  renderViewMeta(entry)
  renderViewBrain(entry)
  if (entry.id) hydrateView(entry.id)
  const tagsContainer = document.getElementById('view-tags-container')
  tagsContainer.innerHTML = ''
  // Only the user's own vocabulary here. The brain's namespaces used to be
  // shown as raw chips for want of anywhere better; "What your brain knows"
  // below now states each one in words, and printing `volatility:state` beside
  // "Lifespan · Current" says the same thing twice, once unreadably.
  const viewTags = humanTags(entry.tags || [])
  if (viewTags.length > 0) {
    tagsContainer.innerHTML = viewTags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')
  }
  const relatedEl = document.getElementById('view-related')
  relatedEl.style.display = 'none'
  relatedEl.innerHTML = ''
  if (entry.id) loadRelated(entry.id, relatedEl)
  const appendBtn = document.getElementById('view-btn-append')
  if (entry.id) {
    appendBtn.onclick = () => {
      closeView()
      openAppend(entry.id, entry.content.slice(0, 80))
    }
  } else {
    appendBtn.onclick = () => {
      closeView()
      openAppendFromContent(entry.content)
    }
  }
  const forgetBtn = document.getElementById('view-btn-forget')
  if (entry.id) {
    forgetBtn.onclick = () => {
      closeView()
      openConfirm(entry.id, cardElement || null)
    }
    forgetBtn.style.display = 'flex'
  } else {
    forgetBtn.style.display = 'none'
  }
  const editBtn = document.getElementById('view-btn-edit')
  if (entry.id) {
    editBtn.onclick = () => {
      closeView()
      openEdit(entry.id, entry.content, entry.tags || [])
    }
    editBtn.style.display = 'flex'
  } else {
    editBtn.style.display = 'none'
  }
  document.getElementById('view-sheet').classList.add('open')
}
function closeView() {
  document.getElementById('view-sheet').classList.remove('open')
}

// ── Related memories (issue #16) ──────────────────────────────────────────
async function loadRelated(id, el) {
  try {
    const res = await fetch(`${WORKER_URL}/connections?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok || !data.connections || !data.connections.length) {
      // also handles the refresh after the last link is removed
      el.style.display = 'none'
      el.innerHTML = ''
      return
    }
    el.innerHTML =
      `<div class="view-related-label">${escHtml(t('memories.related'))}</div>` +
      data.connections
        .map(
          (c) => {
            const who =
              c.provenance === 'explicit'
                ? t('memories.youLinked')
                : c.provenance === 'system'
                  ? t('memories.systemLinked')
                  : t('memories.autoLinked')
            const when = c.linkedAt
              ? ' · ' + formatDateUI(c.linkedAt, { year: 'numeric', month: 'short', day: 'numeric' })
              : ''
            return `<div class="related-item" data-id="${escHtml(c.id)}" data-type="${escHtml(c.type)}"><button class="related-open"><span class="related-type">${escHtml(c.label)} · ${escHtml(who)}${escHtml(when)}</span>${escHtml((c.content || '').slice(0, 80))}</button><button class="related-unlink" title="${escAttr(t('memories.removeLink'))}"><i class="ti ti-unlink"></i></button></div>`
          },
        )
        .join('')
    el.style.display = 'block'
    el.querySelectorAll('.related-item').forEach((row) => {
      row.querySelector('.related-open').onclick = () => {
        const c = data.connections.find((x) => x.id === row.dataset.id)
        if (c) openView({ id: c.id, content: c.content, tags: c.tags }, null)
      }
      row.querySelector('.related-unlink').onclick = async () => {
        if (!confirm(t('memories.removeLinkConfirm'))) return
        try {
          await fetch(`${WORKER_URL}/unlink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
            body: JSON.stringify({ source_id: id, target_id: row.dataset.id, type: row.dataset.type }),
          })
        } catch {}
        loadRelated(id, el)
      }
    })
  } catch {}
}
