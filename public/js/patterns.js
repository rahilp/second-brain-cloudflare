// The pattern review queue.
//
// The nightly pass proposes patterns it noticed across several memories, and a
// pattern is excluded from recall until a human confirms it — so one sitting
// unreviewed is the same as one thrown away. Home shows two as a daily nudge.
// This is the rest of them.
//
// It exists because the old panel could not do the job twice over: it fetched
// `/list?n=20&tag=auto-pattern` and dropped the dismissed rows in the browser,
// which on a brain with more than twenty dismissals threw away every row it
// fetched and rendered nothing — and even when it worked, ruling on a backlog
// meant one round trip and one animation per pattern.

/** Patterns fetched per page. The Worker caps `limit` at 100. */
const PATTERNS_PAGE = 50

/** The ids currently ticked. Held here, not read off the DOM, so paging keeps them. */
let selectedPatterns = new Set()
/** Everything loaded so far, in order, so "select all" means what is on screen. */
let loadedPatterns = []
/** How many the Worker says are waiting, which is more than are on screen. */
let patternsTotal = 0

function openPatternsSheet() {
  closeMenu()
  selectedPatterns = new Set()
  loadedPatterns = []
  document.getElementById('patterns-sheet').classList.add('open')
  loadPatternQueue()
}

function closePatternsSheet() {
  document.getElementById('patterns-sheet').classList.remove('open')
  // Ruling on patterns changes what home has to say, and the brief was fetched
  // before any of it happened.
  refreshAll({ list: false })
}

function backToMenuFromPatterns() {
  closePatternsSheet()
  openMenu()
}

async function loadPatternQueue({ append = false } = {}) {
  const list = document.getElementById('patterns-list')
  if (!append) list.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loading'))}</p>`
  try {
    const res = await fetch(`${WORKER_URL}/patterns?limit=${PATTERNS_PAGE}&offset=${append ? loadedPatterns.length : 0}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    patternsTotal = data.total
    loadedPatterns = append ? [...loadedPatterns, ...data.patterns] : data.patterns
    renderPatternQueue()
  } catch {
    if (!append) {
      list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('patterns.loadFailed'))}</p>`
    }
  }
}

function loadMorePatterns(btn) {
  btn.disabled = true
  btn.textContent = t('integrations.loading')
  loadPatternQueue({ append: true })
}

function patternRow(p) {
  const when = p.created_at
    ? formatDateUI(p.created_at, { year: 'numeric', month: 'short', day: 'numeric' })
    : ''
  // Strip the same provenance suffix the brief card does (splitInsightShape,
  // utils.js), so the queue reads as the sentence the pass wrote, not the
  // bookkeeping appended to it. The shape rides along on the same line the
  // date already occupies rather than earning its own row.
  const { text, shape } = splitInsightShape(p.content)
  const meta = [shape ? t(`patterns.shapes.${shape}`) : '', when ? t('patterns.noticedWhen', { date: when }) : '']
    .filter(Boolean)
    .join(' · ')
  // A source can be gone by the time the queue is read: the edge outlives the
  // memory it points at, since forgetting one leaves no foreign key behind to
  // stop it. Say so rather than rendering a blank line or dropping the card.
  const sources = (p.sources || []).map((s) =>
    s.missing
      ? `<li class="pattern-source pattern-source--gone">${escHtml(t('patterns.sourceGone'))}</li>`
      : `<li class="pattern-source">${escHtml(s.content.slice(0, 160))}</li>`,
  ).join('')
  return `
    <label class="pattern-row" id="pattern-row-${escAttr(p.id)}">
      <input type="checkbox" class="pattern-check" value="${escAttr(p.id)}"
             ${selectedPatterns.has(p.id) ? 'checked' : ''}
             onchange="togglePatternSelection('${escAttr(p.id)}', this.checked)" />
      <span class="pattern-body">
        <span class="pattern-text">${escHtml(text)}</span>
        ${meta ? `<span class="pattern-when">${escHtml(meta)}</span>` : ''}` +
      // Whether the sentence was drawn from your own memories or from the
      // team's, on the metadata line where the date and the shape already are.
      // The same helper the memories card uses (layerChipHtml, utils.js), so
      // there is one implementation of "this row is shared", not two.
      `${layerChipHtml(p, TEAM_MODE)}` +
      `
        ${sources ? `<ul class="pattern-sources">${sources}</ul>` : ''}
      </span>
    </label>`
}

function renderPatternQueue() {
  const list = document.getElementById('patterns-list')
  const bar = document.getElementById('patterns-bulkbar')
  const more = document.getElementById('patterns-more')
  const intro = document.getElementById('patterns-intro')

  if (!loadedPatterns.length) {
    bar.hidden = true
    more.hidden = true
    intro.textContent = t('patterns.emptyIntro')
    list.innerHTML = `<p class="digest-note"><i class="ti ti-check"></i> ${escHtml(t('patterns.emptyBody'))}</p>`
    // Still synced, even though the bar is hidden: the buttons keep whatever
    // state they had, and an emptied page that refills would otherwise show
    // "Dismiss 5" over a fresh selection of nothing.
    syncPatternSelection()
    return
  }

  intro.textContent = t('patterns.intro')
  bar.hidden = false
  list.innerHTML = loadedPatterns.map(patternRow).join('')

  const remaining = patternsTotal - loadedPatterns.length
  more.hidden = remaining <= 0
  more.disabled = false
  if (remaining > 0) more.textContent = t('patterns.more', { n: remaining })

  syncPatternSelection()
}

function togglePatternSelection(id, on) {
  if (on) selectedPatterns.add(id)
  else selectedPatterns.delete(id)
  syncPatternSelection()
}

/**
 * "Select all" means everything loaded, never everything in the queue. Ticking
 * a box and acting on rows the user has not seen is not the same gesture, and
 * the Worker will not take more than a page of ids in one request anyway.
 */
function togglePatternSelectAll(on) {
  selectedPatterns = on ? new Set(loadedPatterns.map((p) => p.id)) : new Set()
  document.querySelectorAll('#patterns-list .pattern-check').forEach((el) => {
    el.checked = on
  })
  syncPatternSelection()
}

function syncPatternSelection() {
  const n = selectedPatterns.size
  const label = document.getElementById('patterns-selected-label')
  const all = document.getElementById('patterns-select-all')
  const confirmBtn = document.getElementById('patterns-confirm-btn')
  const dismissBtn = document.getElementById('patterns-dismiss-btn')

  label.textContent = n ? t('patterns.nSelected', { n }) : t('patterns.selectAll')
  all.checked = n > 0 && n === loadedPatterns.length
  // Some-but-not-all reads as neither ticked nor empty, which is the truth.
  all.indeterminate = n > 0 && n < loadedPatterns.length
  confirmBtn.disabled = !n
  dismissBtn.disabled = !n
  confirmBtn.textContent = n > 1 ? t('patterns.confirmN', { n }) : t('brief.confirm')
  dismissBtn.textContent = n > 1 ? t('patterns.dismissN', { n }) : t('brief.dismiss')
}

/**
 * One request for the whole selection.
 *
 * The rows leave immediately on success rather than being re-fetched: the user
 * just ruled on them, and a reload that re-numbered everything underneath would
 * lose their place in a long queue.
 */
async function resolveSelectedPatterns(action, btn) {
  const ids = [...selectedPatterns]
  if (!ids.length) return
  const bar = document.getElementById('patterns-bulkbar')
  bar.querySelectorAll('button, input').forEach((b) => (b.disabled = true))
  const original = btn.textContent
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.working'))}`

  try {
    const res = await fetch(`${WORKER_URL}/patterns/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ ids, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')

    // The Worker reports what it actually ruled on. Anything it skipped was
    // resolved elsewhere in the meantime, so it leaves the list either way.
    const gone = new Set(ids)
    loadedPatterns = loadedPatterns.filter((p) => !gone.has(p.id))
    patternsTotal = Math.max(0, patternsTotal - ids.length)
    selectedPatterns = new Set()
    renderPatternQueue()

    // A page emptied by a bulk action should refill rather than show a
    // "N more" button over nothing.
    if (!loadedPatterns.length && patternsTotal > 0) loadPatternQueue()
  } catch {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-alert-triangle"></i> ${escHtml(t('patterns.failed'))}`
    setTimeout(() => {
      btn.innerHTML = original
      bar.querySelectorAll('input').forEach((b) => (b.disabled = false))
      syncPatternSelection()
    }, 2500)
  }
}

/**
 * The Upkeep entry point. A count and a door, rather than the queue itself —
 * the settings sheet is a list of chores and this one can be hundreds long.
 */
function renderPatternsSection(total) {
  const el = document.getElementById('patterns-section')
  if (!total) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  el.style.display = ''
  el.innerHTML = `
    <div class="digest-section-label">${escHtml(t('patterns.title'))}</div>
    <p class="digest-note">${escHtml(tPlural('patterns.upkeepNote', total))}</p>
    <button class="digest-btn" onclick="openPatternsSheet()">${escHtml(total === 1 ? t('patterns.reviewOne') : t('patterns.reviewAll'))}</button>
  `
}

/** Just the count for the Upkeep panel; the queue itself loads when opened. */
async function loadPatternCount() {
  try {
    const res = await fetch(`${WORKER_URL}/patterns?limit=1`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    renderPatternsSection(data.ok ? data.total : 0)
  } catch {
    renderPatternsSection(0)
  }
}
