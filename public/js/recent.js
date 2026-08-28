// Loads the list and nothing else. It used to also refresh the count and the
// tags, which made it the de-facto "refresh the app" call and left everything
// it did not know about — the brief, and so the greeting's count — permanently
// stale. Refreshing the shell is refreshAll()'s job now; this owns one list.

/** Layer filter for the memories screen: null = all layers. */
let memoryLayerFilter = null

function maybeRevealMemoryLayerFilter(health) {
  // The outer span is what carries display:none — the select's immediate
  // parent is the inner chevron wrapper. Both branches, so the filter's
  // visibility always tracks TEAM_MODE rather than just being revealed once.
  const wrap = document.getElementById('layer-filter-wrap')
  if (wrap) wrap.style.display = TEAM_MODE ? '' : 'none'
}

async function loadRecent() {
  const list = document.getElementById('recent-list')
  // Only show the loading state on a cold list. A refresh after a capture
  // would otherwise blank out rows the user is reading and snap them back.
  if (!allEntries.length) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-clock"></i><span>${escHtml(t('memories.loadingShort'))}</span></div>`
  }
  try {
    allEntries = await apiList(50, memoryLayerFilter)
    // Through the filters, not straight to render: reloading used to reset the
    // list to everything while the filter controls still read "work" and
    // "past 7 days", which now happens after every capture rather than only
    // when someone pressed refresh.
    applyRecentFilters()
    showFirstRunIfEmpty(allEntries.length === 0)
  } catch {
    if (!allEntries.length) {
      list.innerHTML = `<div class="empty-state"><i class="ti ti-wifi-off"></i><span>${escHtml(t('memories.loadFailed'))}</span></div>`
    }
  }
}

function onLayerFilterChange(value) {
  memoryLayerFilter = value || null
  loadRecent()
}

// toggleEntryLayer lives in api.js (confirm + undo toast)

// A brand-new brain has nothing to recall, so the usual prompt and its
// suggestions would all come back empty. Say where things live instead.
function showFirstRunIfEmpty(isEmpty) {
  const welcome = document.getElementById('recall-welcome')
  const suggestions = document.querySelector('.suggestions-row')
  if (!welcome) return
  if (!isEmpty) {
    if (suggestions) suggestions.style.display = ''
    welcome.classList.remove('first-run')
    return
  }
  if (suggestions) suggestions.style.display = 'none'
  welcome.classList.add('first-run')
  welcome.innerHTML =
    `<div class="eyebrow">${escHtml(t('home.firstRunEyebrow'))}</div>` +
    `<div class="hero-line">${escHtml(t('home.firstRunHero'))}</div>` +
    `<ol class="first-run-steps">` +
    // Named after what is on screen. This used to point at a Remember tab and a
    // Recall tab, both of which are now the one box above.
    `<li>${escHtml(t('home.firstRunStep1'))}</li>` +
    `<li>${escHtml(t('home.firstRunStep2'))}</li>` +
    `<li>${escHtml(t('home.firstRunStep3'))}</li>` +
    `</ol>`
}

function renderRecent(entries) {
  const list = document.getElementById('recent-list')
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-brain"></i><span>${escHtml(t('memories.empty'))}</span></div>`
    return
  }
  const groups = {},
    now = new Date()
  const today = toDateStr(now),
    yesterday = toDateStr(new Date(now - 86400000))
  const sevenDaysAgo = now.getTime() - 7 * 86400000
  entries.forEach((entry) => {
    const d = new Date(entry.created_at),
      ds = toDateStr(d)
    let label
    if (ds === today) {
      label = t('memories.today')
    } else if (ds === yesterday) {
      label = t('memories.yesterday')
    } else if (entry.created_at >= sevenDaysAgo) {
      label = formatDateUI(d, { month: 'short', day: 'numeric' })
    } else {
      // Group by week: find the Monday of that week
      const dow = d.getDay()
      const diff = dow === 0 ? -6 : 1 - dow
      const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff)
      label = t('memories.weekOf', { date: formatDateUI(weekStart, { month: 'short', day: 'numeric' }) })
    }
    if (!groups[label]) groups[label] = []
    groups[label].push(entry)
  })
  list.innerHTML = ''
  Object.entries(groups).forEach(([label, group]) => {
    const g = document.createElement('div')
    g.className = 'date-group'
    g.innerHTML = `<div class="date-label">${label}</div>`
    const cards = document.createElement('div')
    cards.className = 'recent-cards'
    group.forEach((e) => cards.appendChild(makeRecentCard(e)))
    g.appendChild(cards)
    list.appendChild(g)
  })
}

function makeRecentCard(entry) {
  let tags = []
  try {
    tags = JSON.parse(entry.tags || '[]')
  } catch {}
  const isSynthesized = tags.includes('synthesized')
  const isRolledUp = tags.includes('rolled-up')
  const isStale = tags.includes('stale:as-of')

  let vectorIds = []
  try {
    vectorIds = JSON.parse(entry.vector_ids || '[]')
  } catch {}
  const vectorized = vectorIds.length > 0
  // Pending state is computed at render time; won't auto-flip — reload required
  const pending = !vectorized && Date.now() - (entry.created_at || 0) < vectorizeGraceMs
  const vec = vectorized ? 'on' : pending ? 'pending' : 'off'

  const vecChip =
    vec === 'on'
      ? `<span class="tag-chip vec-chip vec-chip--on" title="${escAttr(t('memories.vecOnTitle'))}"><i class="ti ti-circle-check"></i></span>`
      : vec === 'pending'
        ? `<span class="tag-chip vec-chip vec-chip--pending" title="${escAttr(t('memories.vecPendingTitle'))}"><i class="ti ti-clock"></i></span>`
        : `<span class="tag-chip vec-chip vec-chip--off" title="${escAttr(t('memories.vecOffTitle'))}">${escHtml(t('memories.vecNotIndexed'))}</span>`
  // Layer badge: shared memories are the team's — say so. Personal is the
  // quiet default and system rows (digests, insights) carry no badge.
  const layerChip = TEAM_MODE && entry.workspace === 'company'
    ? `<span class="tag-chip tag-chip--shared" title="${escAttr(t('memories.sharedTitle'))}"><i class="ti ti-users-group"></i> ${escHtml(entry.actor_name ? `${t('memories.sharedChip')} · ${entry.actor_name}` : t('memories.sharedChip'))}</span>`
    : ''

  const title = titleLine(entry.content)
  const preview = previewAfterTitle(entry.content, title)
  const shown = humanTags(tags)
  const badge = sourceBadge(entry.source)
  const created = Number(entry.created_at) || 0
  const card = document.createElement('div')
  card.className = 'memory-card' + (isSynthesized ? ' card--synthesized' : '') + (isRolledUp ? ' card--rolled-up' : '') + (isStale ? ' card--stale' : '')
  card.dataset.id = entry.id
  card.innerHTML = `
<div class="card-content" style="cursor: pointer;">
  <div class="card-title">${escHtml(title)}</div>
  ${preview ? `<div class="card-preview">${escHtml(preview)}</div>` : ''}
</div>
<div class="card-footer">
  <div class="card-meta">
    <span class="card-source"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>
    ${created ? `<span class="card-time" title="${escAttr(new Date(created).toLocaleString(localeTag()))}">${escHtml(relativeTime(created))}</span>` : ''}
  </div>
  <div class="card-tags">${shown.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}${layerChip}${vecChip}</div>
  <div class="card-actions">
    <button class="card-action-btn" onclick="openAppend('${escAttr(entry.id)}', '${escAttr(entry.content.slice(0, 80))}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>
    <button class="card-action-btn edit-btn"><i class="ti ti-pencil"></i> ${escHtml(t('memories.edit'))}</button>
    <div class="card-overflow">
      <button class="card-action-btn overflow-btn" aria-label="${escAttr(t('memories.moreActions'))}" aria-haspopup="true" aria-expanded="false"><i class="ti ti-dots"></i></button>
      <div class="card-overflow-menu" hidden>
        ${TEAM_MODE ? `<button class="card-overflow-item share-btn"><i class="ti ti-users-group"></i> ${escHtml(entry.workspace === 'company' ? t('memories.makePrivate') : t('memories.shareWithTeam'))}</button>` : ''}
        <button class="card-overflow-item danger forget-btn"><i class="ti ti-trash"></i> ${escHtml(t('memories.forgetThis'))}</button>
      </div>
    </div>
  </div>
</div>`
  // Forget is permanent and used to sit at equal weight beside Edit on every
  // row. It lives behind the overflow now — one deliberate extra tap, and the
  // only destructive control in the list.
  const overflow = card.querySelector('.card-overflow')
  const overflowBtn = card.querySelector('.overflow-btn')
  const overflowMenu = card.querySelector('.card-overflow-menu')
  overflowBtn.onclick = (ev) => {
    ev.stopPropagation()
    const open = !overflowMenu.hidden
    document.querySelectorAll('.card-overflow-menu').forEach((m) => (m.hidden = true))
    overflowMenu.hidden = open
    overflowBtn.setAttribute('aria-expanded', String(!open))
    if (!open) card.classList.add('card--menu-open')
    else card.classList.remove('card--menu-open')
  }
  card.querySelector('.forget-btn').onclick = (ev) => {
    ev.stopPropagation()
    overflowMenu.hidden = true
    card.classList.remove('card--menu-open')
    openConfirm(entry.id, overflowBtn)
  }
  const shareBtn = card.querySelector('.share-btn')
  if (shareBtn) {
    shareBtn.onclick = (ev) => {
      ev.stopPropagation()
      overflowMenu.hidden = true
      card.classList.remove('card--menu-open')
      toggleEntryLayer(entry.id, entry.workspace)
    }
  }
  overflow.addEventListener('click', (ev) => ev.stopPropagation())
  card.querySelector('.card-content').onclick = () => openView({ id: entry.id, content: entry.content, tags }, card)
  card.querySelector('.edit-btn').onclick = () => openEdit(entry.id, entry.content, tags)
  return card
}
