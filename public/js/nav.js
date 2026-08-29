async function loadTags() {
  try {
    const res = await fetch(`${WORKER_URL}/tags`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    // Filtering by `kind:episodic` is a thing the brain does, not a thing a
    // person browses by — the dropdown offers the user's own vocabulary only.
    const tags = humanTags(await res.json())
    ;['tag-filter-recent', 'tag-filter-recall'].forEach((id) => {
      const sel = document.getElementById(id)
      if (!sel) return
      sel.innerHTML = `<option value="">${escHtml(t('recall.allTags'))}</option>`
      tags.forEach((tagName) => {
        const opt = document.createElement('option')
        opt.value = tagName
        opt.textContent = tagName
        if (tagName === selectedTag) opt.selected = true
        sel.appendChild(opt)
      })
    })
  } catch {}
}

function onTagChange(tag) {
  selectedTag = tag
  ;['tag-filter-recent', 'tag-filter-recall'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.value = tag
  })
  if (currentTab === 'memories') applyRecentFilters()
}

function onTimeRangeChange(val) {
  selectedTimeRange = val
  applyRecentFilters()
}

function applyRecentFilters() {
  let entries = allEntries
  if (selectedTag) {
    const tag = selectedTag.replace(/^#/, '').toLowerCase().trim()
    entries = entries.filter((e) => {
      try {
        return JSON.parse(e.tags || '[]').some((t) => t.toLowerCase() === tag)
      } catch {
        return false
      }
    })
  }
  if (selectedTimeRange) {
    const now = Date.now(),
      MS_DAY = 86400000
    let cutoff
    if (selectedTimeRange === 'today') {
      const d = new Date()
      cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    } else if (selectedTimeRange === 'month') {
      const d = new Date()
      cutoff = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    } else {
      cutoff = now - parseInt(selectedTimeRange) * MS_DAY
    }
    entries = entries.filter((e) => e.created_at >= cutoff)
  }
  renderRecent(entries)
}

function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'))
  document.querySelectorAll('.nav-tab, .sb-tab').forEach((t) => t.classList.remove('active'))
  document.getElementById('screen-' + tab).classList.add('active')
  document.getElementById('tab-' + tab).classList.add('active')
  const sbTab = document.getElementById('sb-tab-' + tab)
  if (sbTab) sbTab.classList.add('active')
  // Only the projection on screen pays for itself; the graph is the expensive
  // one and stays unfetched until someone asks to see it.
  if (tab === 'memories') memoryView === 'graph' ? loadGraph() : loadRecent()
  // Home shows counts and a brief that were fetched at startup, so arriving
  // back at it is exactly when they are most likely to be out of date. Rate
  // limited, so tab-flicking does not re-run the brief's queries each time.
  if (tab === 'home') refreshIfStale()
  // Suspensions and rotations can happen while the window sits open, so the
  // roster refetches on every visit rather than trusting the last one.
  if (tab === 'team' && typeof loadTeam === 'function') loadTeam()
}

/**
 * List or graph — the same memories, ordered by time or by connection.
 *
 * The choice sticks, because it is a statement about how someone thinks about
 * their own brain rather than a per-visit decision, and being dropped back into
 * the other one every time would be a small argument on every visit.
 */
function setMemoryView(mode) {
  memoryView = mode === 'graph' ? 'graph' : 'list'
  try {
    localStorage.setItem('sb_memory_view', memoryView)
  } catch {}
  const graphing = memoryView === 'graph'

  document.getElementById('recent-list').hidden = graphing
  document.getElementById('mem-graph').hidden = !graphing
  // Time and tag narrow a list; the graph draws its own slice of the corpus and
  // would silently ignore them, so they step aside for the legend.
  document.getElementById('mem-filters').hidden = graphing
  document.getElementById('mem-legend').hidden = !graphing

  const listBtn = document.getElementById('mem-view-list')
  const graphBtn = document.getElementById('mem-view-graph')
  listBtn.classList.toggle('active', !graphing)
  graphBtn.classList.toggle('active', graphing)
  listBtn.setAttribute('aria-selected', String(!graphing))
  graphBtn.setAttribute('aria-selected', String(graphing))

  // Nothing is fetched before the page has credentials. initMemoryView() runs
  // from init() to restore the remembered projection before first paint, and
  // that happens a few lines BEFORE WORKER_URL and AUTH_TOKEN are read out of
  // localStorage — so this branch fired an unauthenticated GET /list?n=50 on
  // every single load, took a 401, and left one in every user's console before
  // showApp() re-issued the same request properly. The restore still happens;
  // only the fetch waits for showApp(), which loads the screen anyway.
  if (!AUTH_TOKEN) return

  // A user whose stored choice is the graph never triggers a list load, so
  // switching over would otherwise land on an empty list that looks like an
  // empty brain. Re-filtering is enough once the entries are in hand.
  if (graphing) loadGraph()
  else if (allEntries.length) applyRecentFilters()
  else loadRecent()
}

/** Restores the remembered projection before the first paint of the screen. */
function initMemoryView() {
  let saved = null
  try {
    saved = localStorage.getItem('sb_memory_view')
  } catch {}
  setMemoryView(saved === 'graph' ? 'graph' : 'list')
}

async function updateStatus() {
  try {
    const res = await fetch(`${WORKER_URL}/count`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    currentCount = data.count ?? 0
    const text =
      currentCount === 0
        ? t('nav.statusEmpty')
        : tPlural('nav.statusCount', currentCount, { n: formatNumberUI(currentCount) })
    document.getElementById('topbar-status').textContent = text
    const sb = document.getElementById('sb-status')
    if (sb) sb.textContent = text
  } catch {}
}

async function checkVectorize() {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    const bannerEl = renderVectorizeBanner(vectorizeHealthBanner(data))
    // Stacked directly under the vectorize banner (0 when it is absent) so
    // the two never overlap — see syncWorkspaceFilterChip in utils.js.
    renderWorkspaceFilterChip(workspaceFilterChip(data), bannerEl ? bannerEl.offsetHeight : 0)
    // The composer's layer toggle and the memories filters only exist when
    // this brain actually has members — solo brains keep the quiet UI.
    maybeRevealHomeLayer(data)
    maybeRevealMemoryLayerFilter(data)
    maybeRevealRecallLayer(data)
    // After TEAM_MODE is set, not before: the name renders only on a team brain,
    // and this is the one place that flag is decided.
    if (typeof loadTeamName === 'function') loadTeamName()
  } catch {}
}

// Thin wrapper over the unit-tested syncVectorizeBanner in utils.js, which
// owns the mount/update/remove + body-offset logic against the real document.
function renderVectorizeBanner(banner) {
  return syncVectorizeBanner(document, banner)
}

// Thin wrapper over the unit-tested syncWorkspaceFilterChip in utils.js. See
// workspaceFilterChip's own comment: this reports degraded ranking quality
// (foreign candidates can consume result slots before SQL filters them back
// out), never data leakage — every hydration stays scoped at the SQL layer.
function renderWorkspaceFilterChip(chip, offsetTop) {
  syncWorkspaceFilterChip(document, chip, offsetTop)
}

// Row overflow menus close on any outside click or Escape — they are transient
// affordances, not state, and leaving one open behind a scroll is a trap.
document.addEventListener('click', () => {
  document.querySelectorAll('.card-overflow-menu').forEach((m) => (m.hidden = true))
  document.querySelectorAll('.card--menu-open').forEach((c) => c.classList.remove('card--menu-open'))
  document.querySelectorAll('.overflow-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'))
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  document.querySelectorAll('.card-overflow-menu').forEach((m) => (m.hidden = true))
  document.querySelectorAll('.card--menu-open').forEach((c) => c.classList.remove('card--menu-open'))
})
