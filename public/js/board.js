// The home board: tiles and panels rendered from data the Worker already returns.
// Every panel hides itself when its endpoint is missing (older Worker) or refused.
async function boardFetch(path) {
  try {
    const res = await fetch(`${WORKER_URL}${path}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) return null
    const data = await res.json()
    return data && data.ok === false ? null : data
  } catch { return null }
}

// Some endpoints back both a tile and a panel (e.g. /stats/graph, /stats/recalled);
// this caches the first fetch of a render pass so the second reader gets the
// same response instead of hitting the Worker twice. Cleared at the top of
// every renderBoard() call so a refresh sees fresh data.
let _boardFetchCache = new Map()
// Owns a render pass: renderBoard bumps this at the start of every call and
// checks it after each await, so a stale call that is still in flight when a
// newer one starts stops appending instead of racing it into the same DOM.
let _boardRenderToken = 0
async function boardFetchOnce(key, path) {
  if (_boardFetchCache.has(key)) return _boardFetchCache.get(key)
  const data = await boardFetch(path)
  _boardFetchCache.set(key, data)
  return data
}

function boardTile(id, { n, label, delta, quiet, ariaLabel, onClick }) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'tile'; el.dataset.tile = id
  el.setAttribute('aria-label', ariaLabel)
  el.onclick = onClick
  el.innerHTML = `<span class="tile-n">${escHtml(formatNumberUI(n))}</span><span class="tile-l">${escHtml(label)}</span>` +
    (delta ? `<span class="tile-d${quiet ? ' quiet' : ''}">${escHtml(delta)}</span>` : '')
  return el
}

function makeBoardRow(className, onClick) {
  const el = document.createElement('div')
  el.className = className
  if (!onClick) return el
  el.setAttribute('role', 'button')
  el.setAttribute('tabindex', '0')
  el.onclick = onClick
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onClick()
  })
  return el
}

function openBoardMemory(entry, trigger) {
  if (typeof openView === 'function') openView({ id: entry.id, content: entry.content, tags: entry.tags || [] }, trigger)
}

async function openCapsuleMemory(id, trigger) {
  const data = await boardFetch(`/entry?id=${encodeURIComponent(id)}`)
  if (data && data.entry) openBoardMemory(data.entry, trigger)
}

function browseBoardTag(tag) {
  // Tag set before the tab switch: switchTab('memories') is what actually
  // triggers loadRecent(), and loadRecent reads selectedTag synchronously (to
  // build the /list?tag= request) before its first await: set the other way
  // round, the fetch would go out with whatever tag was selected before this
  // click, not this one.
  if (typeof onTagChange === 'function') onTagChange(tag)
  if (typeof switchTab === 'function') switchTab('memories')
}

// Built with createElement/appendChild rather than innerHTML+querySelector so
// the returned .body reference is live in both a real DOM and the lightweight
// fake-DOM harness test/ui files use (which does not parse innerHTML strings
// back into queryable nodes).
function boardPanel(id, { title, sub, action, span }) {
  const el = document.createElement('section')
  el.className = 'panel' + (span ? ` span${span}` : '')
  el.dataset.panel = id
  el.setAttribute('aria-labelledby', `h-${id}`)

  const head = document.createElement('div')
  head.className = 'panel-head'
  const heading = document.createElement('div')
  const h2 = document.createElement('h2')
  h2.id = `h-${id}`
  h2.textContent = title
  heading.appendChild(h2)
  if (sub) {
    const p = document.createElement('p')
    p.className = 'panel-sub'
    p.textContent = sub
    heading.appendChild(p)
    el.subEl = p
  }
  head.appendChild(heading)
  if (action) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'panel-act'
    btn.innerHTML = `${escHtml(action.label)} <i class="ti ti-arrow-right"></i>`
    btn.onclick = action.onClick
    head.appendChild(btn)
  }
  el.appendChild(head)
  el.head = head

  const body = document.createElement('div')
  body.className = 'panel-body'
  el.appendChild(body)
  el.body = body
  return el
}

/**
 * Sizes the thread line to span exactly its first stop's dot to its last
 * stop's dot, within `body` (a panel's .panel-body, or any ancestor of a
 * single stop that settled). Callable as often as layout changes. Settling
 * a stop shrinks it, and a thread sized for the old, taller layout runs on
 * past the last dot into whatever panel sits below. A safe no-op wherever
 * real layout is not available (server-side, or the lightweight test
 * harness, which does not parse innerHTML back into queryable nodes).
 */
function refitThread(body) {
  const thread = body && body.querySelector && body.querySelector('.thread')
  if (!thread) return
  const stops = body.querySelectorAll('.stop')
  if (!stops.length) return
  const first = stops[0], last = stops[stops.length - 1]
  const top = (first.offsetTop || 0) + 9, end = (last.offsetTop || 0) + 25
  thread.style.top = top + 'px'
  thread.style.height = Math.max(end - top, 0) + 'px'
}

/**
 * The decisions thread's one authored motion: it draws once through the
 * stops on first render, then keeps refitting itself as the ledger's own
 * content changes size (a stop settling after Confirm/Dismiss) via one
 * ResizeObserver per panel, replaced rather than stacked if this panel is
 * ever rebuilt.
 */
function fitThread(panel) {
  const body = panel && panel.body
  refitThread(body)
  const thread = body && body.querySelector && body.querySelector('.thread')
  if (!thread) return
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => fn()
  raf(() => thread.classList.add('drawn'))

  const ledger = body.querySelector('.ledger')
  if (ledger && typeof ResizeObserver === 'function') {
    if (panel._threadObserver) panel._threadObserver.disconnect()
    panel._threadObserver = new ResizeObserver(() => refitThread(body))
    panel._threadObserver.observe(ledger)
  }
}

/** Panel renderers register here in display order; each appends a .panel or nothing. */
const BOARD_PANELS = []

/**
 * One insight, in the exact card markup brief.js already emits (briefCard,
 * label, body, actions) so briefResolvePattern's `btn.closest('.brief-card')`
 * still finds it. The "stop" ledger classes ride alongside, not instead.
 */
function buildInsightStop(p) {
  const { text, shape } = splitInsightShape(p.content)
  const label = shape
    ? `${t('brief.patternNoticed')}${t('brief.shapeSuffix', { shape: t(`patterns.shapes.${shape}`) })}`
    : t('brief.patternNoticed')
  return `<article class="stop brief-card" data-insight data-pattern="${escAttr(p.id)}">
    <div class="brief-label" aria-live="polite">${escHtml(label)}</div>
    <div class="brief-body">${escHtml(text)}</div>
    <div class="brief-actions">
      <button class="digest-btn digest-btn--primary" onclick="briefResolvePattern('${escAttr(p.id)}', 'confirm', this)">${escHtml(t('brief.confirm'))}</button>
      <button class="digest-btn danger" onclick="briefResolvePattern('${escAttr(p.id)}', 'dismiss', this)">${escHtml(t('brief.dismiss'))}</button>
    </div>
  </article>`
}

/**
 * "Needs a decision": the two or three things a brain cannot decide by
 * itself, on the one thread. Appends nothing when there is nothing pending.
 */
function renderDecisionPanel(board, brief) {
  const pending = (brief && brief.patterns) || []
  const attention = (brief && brief.attention) || {}
  if (!pending.length && !(attention.stale > 0) && !(attention.unindexed > 0)) return

  const stops = pending.slice(0, 2).map(buildInsightStop)
  if (pending.length > 2) {
    const moreLabel =
      typeof brief.patternsTotal === 'number' && brief.patternsTotal > 2
        ? tPlural('brief.moreInsights', brief.patternsTotal - 2)
        : t('brief.moreInsightsGeneric')
    stops.push(`<article class="stop"><button class="more brief-more" type="button" onclick="openPatternsSheet()">${escHtml(moreLabel)}</button></article>`)
  }
  if (attention.stale > 0) {
    stops.push(`<article class="stop">
      <div class="stop-label">${escHtml(t('stale.title'))}</div>
      <div class="stop-actions"><button class="attn" type="button" onclick="openStaleSheet()"><i class="ti ti-clock-exclamation"></i>${escHtml(t('brief.attentionStale', { n: attention.stale }))}</button></div>
    </article>`)
  }
  if (attention.unindexed > 0) {
    stops.push(`<article class="stop">
      <div class="stop-actions"><button class="attn" type="button" onclick="openMenu()"><i class="ti ti-eye-off"></i>${escHtml(t('brief.attentionUnindexed', { n: attention.unindexed }))}</button></div>
    </article>`)
  }

  const panel = boardPanel('decide', { title: t('board.decideTitle'), sub: t('board.decideSub'), span: 4 })
  panel.className += ' decide' // the mockup's 1240px override (full width, not half) keys off this
  panel.body.innerHTML = `<div class="ledger"><div class="thread" aria-hidden="true"></div>${stops.join('')}</div>`
  board.appendChild(panel)
  fitThread(panel)
}

/** Bars proportional to their own max, not to each other's panel's max. */
function boardBars(rows, onClick) {
  const max = Math.max(...rows.map((r) => r.count), 1)
  return `<div class="bars">${rows
    .map((r) => {
      const pct = Math.max(Math.round((r.count / max) * 100), 3)
      const label = escHtml(r.label)
      const btn = onClick
        ? `<button type="button" class="bar" onclick="${onClick(r)}"><span>${label}</span><span class="bar-track" style="--w:${pct}%"></span><span class="bar-n num">${escHtml(formatNumberUI(r.count))}</span></button>`
        : `<div class="bar"><span>${label}</span><span class="bar-track" style="--w:${pct}%"></span><span class="bar-n num">${escHtml(formatNumberUI(r.count))}</span></div>`
      return btn
    })
    .join('')}</div>`
}

/** "What it is about": the tags actually in use, as a click-to-ask list. */
function renderTopicsPanel(board, brief) {
  const rows = ((brief && brief.topics) || []).filter((t) => !isSystemTag(t.tag)).slice(0, 6)
  if (!rows.length) return
  const panel = boardPanel('topics', { title: t('board.topicsTitle'), sub: t('board.topicsSub'), span: 4 })
  const bars = document.createElement('div')
  bars.className = 'bars'
  const max = Math.max(...rows.map((r) => r.count), 1)
  rows.forEach((r) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'bar'
    row.setAttribute('aria-label', t('board.topicBrowse', { tag: r.tag }))
    row.onclick = () => browseBoardTag(r.tag)
    row.innerHTML = `<span>${escHtml(r.tag)}</span><span class="bar-track" style="--w:${Math.max(Math.round((r.count / max) * 100), 3)}%"></span><span class="bar-n num">${escHtml(formatNumberUI(r.count))}</span>`
    bars.appendChild(row)
  })
  panel.body.appendChild(bars)
  board.appendChild(panel)
}

/** "Worth re-reading": the one high-importance memory nobody has recalled lately. */
function renderResurfacePanel(board, brief) {
  const m = brief && brief.resurface
  if (!m) return
  const panel = boardPanel('reread', { title: t('brief.worthRereading'), sub: t('board.rereadSub'), span: 4 })
  const meta = [m.source ? sourceDisplayName(m.source) : null, m.created_at ? formatDateUI(m.created_at, { year: 'numeric', month: 'short', day: 'numeric' }) : null]
    .filter(Boolean)
    .join(' · ')
  const tags = humanTags(m.tags || [])
    .map((tag) => `<span class="tag">${escHtml(tag)}</span>`)
    .join('')
  panel.body.innerHTML = `
    <div class="memory-mark">
      <div class="memory-mark-head"><img class="memory-mark-icon" src="/brand-mark.png" width="36" height="22" alt=""><span class="memory-mark-label">${escHtml(t('board.saved'))}</span></div>
      ${meta ? `<span class="memory-mark-meta">${escHtml(meta)}</span>` : ''}
    </div>
    <p class="reread-text">${escHtml(titleLine(m.content, 180))}</p>
    <div class="memory-card-foot">
      ${tags}
      <button class="digest-btn" type="button" onclick="openAppend('${escAttr(m.id)}', '${escAttr((m.content || '').slice(0, 80))}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>
    </div>`
  const text = panel.body.querySelector('.reread-text')
  if (text) {
    text.setAttribute('role', 'button')
    text.setAttribute('tabindex', '0')
    text.onclick = () => openBoardMemory(m, text)
    text.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      openBoardMemory(m, text)
    })
  }
  board.appendChild(panel)
}

// Task 1.4 had a temporary "Where from" proportion panel here. The growth
// chart legend below is its replacement (per the plan: "the 'Where from'
// proportion rows move into the chart legend"), so it is gone.

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/**
 * Proper display names for known sources. sourceBadge()'s own labels are
 * lowercase by design for the compact monospace meta line on a memory card
 * ("claude code · 2d ago"), and capitalizeFirst() alone only fixes a
 * single-word label. It turns "claude code" into "Claude code" and
 * "chatgpt" into "Chatgpt", both wrong for a chart legend, tooltip, table
 * header or row read at a glance. Keyed on the raw source string (both the
 * hyphenated form the Worker stores and sourceBadge's own space-joined
 * label, so either input resolves), falling back to capitalizeFirst on
 * sourceBadge's label for anything not in this table.
 */
const SOURCE_DISPLAY_NAMES = {
  'claude-code': 'Claude Code',
  'claude code': 'Claude Code',
  chatgpt: 'ChatGPT',
  obsidian: 'Obsidian',
  gmail: 'Gmail',
  icloud: 'iCloud',
  notion: 'Notion',
  'web-ui': 'Dashboard',
  dashboard: 'Dashboard',
  ios: 'Phone',
  phone: 'Phone',
  shortcut: 'Phone',
  cli: 'CLI',
  'calendar-google': 'Google Calendar',
  github: 'GitHub',
}
function sourceDisplayName(source) {
  const known = SOURCE_DISPLAY_NAMES[String(source ?? '').trim().toLowerCase()]
  return known || capitalizeFirst(sourceBadge(source).label)
}

/**
 * Groups /stats/activity's per-source series (already sorted largest-first
 * by the Worker) into at most 5: the four biggest sources plus one "Other"
 * summing whatever is left, so the chart never grows a sixth color.
 */
function buildActivitySeries(data) {
  const top = data.series.slice(0, 4)
  const rest = data.series.slice(4)
  const defs = top.map((s) => ({ source: s.source, counts: s.counts }))
  if (rest.length) {
    const otherCounts = new Array(data.days).fill(0)
    for (const s of rest) s.counts.forEach((v, i) => { otherCounts[i] += v || 0 })
    defs.push({ source: null, counts: otherCounts, isOther: true })
  }
  return defs
}

/**
 * Buckets raw daily rows into the mode the range control asked for: 30 days
 * shows the raw counts, 90 a centered 7-day average, 365 weekly sums,
 * mirroring docs/design-mockups/dashboard/template.html's `bucketed()`. The
 * average's window can only look inside the fetched days (no data exists
 * before `start`), so it narrows near the two ends of whatever range is on
 * screen rather than reaching further back.
 */
function bucketActivityRows(rawRows, mode) {
  if (mode === 'day') return rawRows
  const seriesCount = rawRows.length ? rawRows[0].s.length : 0
  if (mode === 'avg7') {
    return rawRows.map((r, i) => {
      const lo = Math.max(0, i - 3), hi = Math.min(rawRows.length - 1, i + 3)
      const win = rawRows.slice(lo, hi + 1)
      const s = []
      for (let k = 0; k < seriesCount; k++) s.push(win.reduce((acc, w) => acc + w.s[k], 0) / win.length)
      return { d: r.d, label: r.label, s }
    })
  }
  const out = []
  for (let i = rawRows.length; i > 0; i -= 7) {
    const chunk = rawRows.slice(Math.max(0, i - 7), i)
    const s = []
    for (let k = 0; k < seriesCount; k++) s.push(chunk.reduce((acc, row) => acc + row.s[k], 0))
    out.unshift({ d: chunk[0].d, label: t('memories.weekOf', { date: chunk[0].label }), s })
  }
  return out
}

/**
 * "Memories over time": a stacked area chart from /stats/activity, by
 * source, with a live 30/90/365 range control. Falls back to the 14-day
 * single "All sources" strip /brief already returns, with the range control
 * disabled, when the Worker does not have the rollup endpoint yet.
 */
async function renderGrowthPanel(board, brief) {
  const brief14 = (brief && brief.activity) || []
  // One fetch decides both whether the panel shows at all and, when it does,
  // paints the default 90-day range; draw() below reuses this result rather
  // than fetching /stats/activity a second time for the initial paint.
  const initial = await boardFetch('/stats/activity?days=90')
  const live = !!(initial && Array.isArray(initial.series) && initial.series.length)
  if (!live && !brief14.length) return

  const panel = boardPanel('growth', { title: t('board.growthTitle'), sub: t('board.growthSubDay'), span: 8 })
  panel.className += ' growth'

  // The range control and the table toggle both depend on live per-source
  // data from /stats/activity; against an older Worker (the 14-day /brief
  // fallback below) they would be dead controls with nothing to switch
  // between, so neither renders at all. A muted note says why instead.
  let segButtons = []
  let asTableBtn = null
  if (live) {
    const seg = document.createElement('div')
    seg.className = 'seg'
    seg.setAttribute('role', 'radiogroup')
    seg.setAttribute('aria-label', t('board.rangeLabel'))
    segButtons = [['30', t('board.range30')], ['90', t('board.range90')], ['365', t('board.range365')]].map(([val, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.dataset.range = val
      const checked = val === '90'
      b.setAttribute('aria-checked', String(checked))
      b.tabIndex = checked ? 0 : -1
      b.disabled = false
      b.textContent = label
      seg.appendChild(b)
      return b
    })
    panel.head.appendChild(seg)

    asTableBtn = document.createElement('button')
    asTableBtn.type = 'button'
    asTableBtn.className = 'btn btn-secondary btn-sm'
    asTableBtn.setAttribute('aria-expanded', 'false')
    asTableBtn.textContent = t('board.chartShowTable')
    panel.head.appendChild(asTableBtn)

    seg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const i = segButtons.indexOf(document.activeElement)
      const next = segButtons[((i === -1 ? 0 : i) + (e.key === 'ArrowRight' ? 1 : segButtons.length - 1)) % segButtons.length]
      next.focus()
      next.onclick()
    })
  }

  const chartEl = document.createElement('div')
  chartEl.className = 'chart'
  chartEl.setAttribute('role', 'img')
  chartEl.tabIndex = 0
  chartEl.setAttribute('aria-roledescription', 'stacked area chart')
  const svg = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg')
  svg.setAttribute('aria-hidden', 'true')
  chartEl.appendChild(svg)

  const legend = document.createElement('div')
  legend.className = 'legend'

  panel.body.appendChild(chartEl)
  panel.body.appendChild(legend)

  if (live) {
    const tableScroll = document.createElement('div')
    tableScroll.className = 'table-scroll'
    const table = document.createElement('table')
    table.className = 'data-table'
    table.hidden = true
    const caption = document.createElement('caption')
    caption.className = 'vh'
    table.appendChild(caption)
    table.appendChild(document.createElement('thead'))
    table.appendChild(document.createElement('tbody'))
    tableScroll.appendChild(table)
    panel.body.appendChild(tableScroll)

    // The toggle updates itself in place and keeps focus; it never rebuilds the panel.
    asTableBtn.onclick = () => {
      table.hidden = !table.hidden
      asTableBtn.textContent = table.hidden ? t('board.chartShowTable') : t('board.chartHideTable')
      asTableBtn.setAttribute('aria-expanded', String(!table.hidden))
      asTableBtn.focus()
    }
  } else {
    // No range control and no table toggle against an older Worker: both
    // would be dead controls with nothing to switch between. Say why.
    const note = document.createElement('p')
    note.className = 'chart-note'
    note.textContent = t('board.chartNeedsUpdate')
    panel.body.appendChild(note)
  }

  let range = 90
  let cachedInitial = initial

  async function draw() {
    const data = live ? (range === 90 && cachedInitial ? cachedInitial : await boardFetch(`/stats/activity?days=${range}`)) : null
    cachedInitial = null
    if (data && Array.isArray(data.series) && data.series.length) {
      const mode = range === 30 ? 'day' : range === 365 ? 'week' : 'avg7'
      const seriesDefs = buildActivitySeries(data)
      const seriesMeta = seriesDefs.map((sd) => ({
        name: sd.isOther ? t('board.seriesOther') : sourceDisplayName(sd.source),
      }))
      const rawRows = []
      for (let i = 0; i < data.days; i++) {
        const dayNum = data.start + i
        rawRows.push({
          d: String(dayNum),
          label: formatDateUI(dayNum * 86400000, { month: 'short', day: 'numeric' }),
          s: seriesDefs.map((sd) => sd.counts[i] || 0),
        })
      }
      const rows = bucketActivityRows(rawRows, mode)
      if (typeof renderActivityChart === 'function') renderActivityChart(chartEl, { rows, series: seriesMeta, mode, subEl: panel.subEl, totalsRows: rawRows })
    } else {
      // Older Worker (or a range refetch that failed): the 14-day single
      // series /brief already returns, honestly scoped as "last 14 days".
      if (panel.subEl) panel.subEl.textContent = t('board.growthSubBrief')
      const rows = brief14.map((d) => ({ d: String(d.day), label: formatDateUI(d.day * 86400000, { month: 'short', day: 'numeric' }), s: [d.count || 0] }))
      const series = [{ name: t('board.seriesAll') }]
      if (typeof renderActivityChart === 'function') renderActivityChart(chartEl, { rows, series, mode: 'day' })
    }
  }

  segButtons.forEach((b) => {
    b.onclick = () => {
      range = Number(b.dataset.range)
      segButtons.forEach((o) => { const on = o === b; o.setAttribute('aria-checked', String(on)); o.tabIndex = on ? 0 : -1 })
      draw()
    }
  })

  // Attached before drawing: renderActivityChart reads chartEl.clientWidth/
  // clientHeight to size the SVG viewBox, and a detached element (or one
  // whose ancestor chain is not yet in the document) reports both as 0,
  // silently falling back to a hardcoded 640x280 box that then letterboxes
  // inside whatever size the container turns out to be.
  board.appendChild(panel)
  await draw()
}

const GRAPH_SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * "How it connects": a static packed preview of the same topic clusters the
 * Memories screen's graph draws (assignGraphClusters, packGraphNodes,
 * packGraphCircles, all pure, unit-tested helpers in utils.js). One level of
 * clustering only; the full graph's sub-topic nesting is more than a 560x340
 * preview needs.
 *
 * Per DIRECTION.md's review finding, topic clusters carry no hue meaning here
 * (unlike the chart's source palette): every node and ring draws neutral at
 * rest, so identity comes from the label, not a color that would fail a
 * colorblind reader on an arbitrary tag. Clicking a label is the one place
 * brand orange enters this panel, as a deliberate, user-driven exception.
 *
 * Built with createElementNS/createElement + appendChild rather than one
 * innerHTML string (like boardPanel, for the same reason) so every node,
 * ring, edge and label stays a live, clickable reference in both a real DOM
 * and the fake-DOM test harness, which does not parse innerHTML back into
 * queryable nodes.
 */
async function renderGraphPanel(board, brief) {
  const data = await boardFetch('/graph?limit=120')
  const nodes = (data && data.nodes) || []
  if (nodes.length < 5) return
  const edges = (data && data.edges) || []
  assignGraphClusters(nodes, edges)

  const W = 560, H = 340, NODE_R = 9, GAP = 10, LOOSE = '__loose__'
  const byCluster = new Map()
  for (const n of nodes) {
    if (!byCluster.has(n.cluster)) byCluster.set(n.cluster, [])
    byCluster.get(n.cluster).push(n)
  }
  const clusters = []
  for (const [id, members] of byCluster) {
    if (id === LOOSE) continue
    const spread = members.length <= 1 ? 0 : 8 + 7 * Math.sqrt(members.length)
    const local = packGraphNodes(members.length, spread)
    members.forEach((n, i) => { n._lx = local[i].x; n._ly = local[i].y })
    clusters.push({ id, members, R: spread + NODE_R + 6 })
  }
  const loose = byCluster.get(LOOSE) || []
  const packed = packGraphCircles([...clusters.map((c) => c.R), ...loose.map(() => NODE_R + 4)], GAP)
  clusters.forEach((c, i) => { c.cx = packed.centers[i].x; c.cy = packed.centers[i].y })
  loose.forEach((n, i) => {
    const c = packed.centers[clusters.length + i]
    n.cx = c.x; n.cy = c.y
  })
  for (const c of clusters) for (const n of c.members) { n.cx = c.cx + n._lx; n.cy = c.cy + n._ly }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) { minX = Math.min(minX, n.cx); maxX = Math.max(maxX, n.cx); minY = Math.min(minY, n.cy); maxY = Math.max(maxY, n.cy) }
  for (const c of clusters) { minX = Math.min(minX, c.cx - c.R); maxX = Math.max(maxX, c.cx + c.R); minY = Math.min(minY, c.cy - c.R); maxY = Math.max(maxY, c.cy + c.R) }
  const pad = 24
  const scale = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1), 1)
  const ox = W / 2 - ((minX + maxX) / 2) * scale, oy = H / 2 - ((minY + maxY) / 2) * scale
  const sx = (v) => v * scale + ox, sy = (v) => v * scale + oy

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const svgEl = (tag) => document.createElementNS(GRAPH_SVG_NS, tag)

  const svg = svgEl('svg')
  svg.setAttribute('class', 'graph-svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)

  const nodeEls = new Map() // cluster id -> [circle]
  const ringEls = new Map() // cluster id -> circle
  const labelEls = new Map() // cluster id -> text
  const chipEls = new Map() // cluster id -> button
  const edgeEls = [] // { el, a, b }
  const clusterSize = new Map(clusters.map((c) => [c.id, c.members.length]))

  for (const e of edges) {
    const s = byId.get(e.source), tn = byId.get(e.target)
    if (!s || !tn) continue
    const line = svgEl('line')
    line.setAttribute('x1', sx(s.cx).toFixed(1))
    line.setAttribute('y1', sy(s.cy).toFixed(1))
    line.setAttribute('x2', sx(tn.cx).toFixed(1))
    line.setAttribute('y2', sy(tn.cy).toFixed(1))
    line.classList.add('graph-edge')
    // Same-cluster edges carry the one cluster id they belong to; an edge
    // crossing clusters carries both ends instead, so the highlight rule
    // ("touching the active cluster") can tell the two cases apart.
    if (s.cluster === tn.cluster) line.dataset.cluster = s.cluster
    else { line.dataset.a = s.cluster; line.dataset.b = tn.cluster }
    svg.appendChild(line)
    edgeEls.push({ el: line, a: s.cluster, b: tn.cluster })
  }
  // fill/stroke-opacity (not a baked-in rgba) so the ring reads as a faint
  // wash of ink in either theme instead of vanishing on a dark ground.
  for (const c of clusters) {
    const ring = svgEl('circle')
    ring.setAttribute('cx', sx(c.cx).toFixed(1))
    ring.setAttribute('cy', sy(c.cy).toFixed(1))
    ring.setAttribute('r', (c.R * scale).toFixed(1))
    ring.classList.add('graph-ring')
    ring.dataset.cluster = c.id
    svg.appendChild(ring)
    ringEls.set(c.id, ring)
  }
  for (const n of nodes) {
    const r = (3.5 + Math.min(2.5, (n.importance || 0) * 0.5)).toFixed(1)
    const circle = svgEl('circle')
    circle.setAttribute('cx', sx(n.cx).toFixed(1))
    circle.setAttribute('cy', sy(n.cy).toFixed(1))
    circle.setAttribute('r', r)
    circle.classList.add('graph-node')
    circle.dataset.cluster = n.cluster
    svg.appendChild(circle)
    if (!nodeEls.has(n.cluster)) nodeEls.set(n.cluster, [])
    nodeEls.get(n.cluster).push(circle)
  }
  for (const c of clusters) {
    const label = svgEl('text')
    label.setAttribute('x', sx(c.cx).toFixed(1))
    label.setAttribute('y', (sy(c.cy - c.R) - 6).toFixed(1))
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('role', 'button')
    label.setAttribute('tabindex', '0')
    label.setAttribute('aria-pressed', 'false')
    label.classList.add('graph-label')
    label.dataset.cluster = c.id
    label.innerHTML = `${escHtml(c.id)} <tspan class="graph-n">${formatNumberUI(c.members.length)}</tspan>`
    svg.appendChild(label)
    labelEls.set(c.id, label)
  }

  const panel = boardPanel('graph', {
    title: t('board.graphTitle'),
    sub: t('board.graphSub'),
    span: 7,
    action: { label: t('board.openGraph'), onClick: () => { switchTab('memories'); setMemoryView('graph') } },
  })
  const wrap = document.createElement('div')
  wrap.className = 'graph'
  wrap.appendChild(svg)

  // The in-SVG cluster labels (.graph-label) hide below 700px, where there is
  // no room to set them without overlapping; this chip row takes over at
  // that width instead of leaving cluster identity, or the ability to
  // highlight one, behind entirely. Same words as the label ("travel 4").
  const clusterLegend = document.createElement('p')
  clusterLegend.className = 'graph-cluster-legend num'
  for (const c of clusters) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'graph-chip'
    chip.dataset.cluster = c.id
    chip.setAttribute('aria-pressed', 'false')
    chip.textContent = `${c.id} ${formatNumberUI(c.members.length)}`
    clusterLegend.appendChild(chip)
    chipEls.set(c.id, chip)
  }

  const legend = document.createElement('p')
  legend.className = 'graph-legend num'
  legend.innerHTML = `<span>${escHtml(t('board.graphLegend', { shown: formatNumberUI(nodes.length), total: formatNumberUI((brief && brief.total) || nodes.length), topics: clusters.length }))}</span><span>${escHtml(t('board.graphSize'))}</span>`

  // Announces the active cluster for assistive tech; the highlight itself is
  // silent (color/opacity only) otherwise.
  const live = document.createElement('p')
  live.className = 'vh'
  live.setAttribute('aria-live', 'polite')

  let active = null
  function applyActive(id) {
    active = id
    const on = !!active
    for (const [cid, els] of nodeEls) {
      for (const el of els) { el.classList.toggle('is-active', cid === active); el.classList.toggle('is-dimmed', on && cid !== active) }
    }
    for (const [cid, ring] of ringEls) {
      ring.classList.toggle('is-active', cid === active)
      ring.classList.toggle('is-dimmed', on && cid !== active)
    }
    for (const [cid, label] of labelEls) {
      label.classList.toggle('is-active', cid === active)
      label.setAttribute('aria-pressed', String(cid === active))
    }
    for (const [cid, chip] of chipEls) {
      chip.classList.toggle('is-active', cid === active)
      chip.setAttribute('aria-pressed', String(cid === active))
    }
    for (const { el, a, b } of edgeEls) el.classList.toggle('is-dimmed', on && a !== active && b !== active)
    live.textContent = active
      ? t('board.graphShowing', { tag: active, n: formatNumberUI(clusterSize.get(active) || 0) })
      : t('board.graphShowingAll')
  }
  function toggleCluster(id) { applyActive(active === id ? null : id) }
  function clearActive() { if (active) applyActive(null) }
  applyActive(null)

  for (const c of clusters) {
    const onActivate = () => toggleCluster(c.id)
    labelEls.get(c.id).onclick = onActivate
    labelEls.get(c.id).onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onActivate()
    }
    chipEls.get(c.id).onclick = onActivate
  }
  // A click that lands on the svg itself (not a shape within it) is empty canvas.
  svg.onclick = (e) => { if (e.target === svg) clearActive() }
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearActive() })

  panel.body.appendChild(wrap)
  panel.body.appendChild(clusterLegend)
  panel.body.appendChild(legend)
  panel.body.appendChild(live)
  board.appendChild(panel)
}

/**
 * "What you keep coming back to": the most-recalled memories, all time.
 * Shares its fetch with the recalls tile: renderBoard calls boardFetchOnce
 * with this same key first, so this never hits the Worker twice.
 */
async function renderRecalledPanel(board) {
  const data = await boardFetchOnce('recalled', '/stats/recalled?limit=5')
  const entries = (data && data.entries) || []
  if (!entries.length) return

  const panel = boardPanel('recalled', { title: t('board.recalledTitle'), sub: t('board.recalledSub'), span: 5 })
  const rows = document.createElement('div')
  rows.className = 'rows'
  entries.forEach((m) => {
    const badge = sourceBadge(m.source)
    const meta = [sourceDisplayName(m.source), m.created_at ? formatDateUI(m.created_at, { month: 'short', day: 'numeric' }) : null].filter(Boolean).join(' · ')
    const row = makeBoardRow('row', () => openBoardMemory(m, row))
    row.innerHTML = `<div class="row-t">${escHtml(titleLine(m.content))}</div>
      <div class="row-n num">${escHtml(tPlural('board.recalls', m.recall_count))}</div>
      <div class="row-m"><i class="ti ${badge.icon}"></i>${escHtml(meta)}</div>`
    rows.appendChild(row)
  })
  panel.body.appendChild(rows)
  board.appendChild(panel)
}

/**
 * "Last night": last night's maintenance summary from /stats/night. Hidden
 * when ranAt is null, nothing recorded yet, either a brand new Worker or
 * the nightly pass has not run once. insightsProposed is 0 on most nights
 * since the weekly insight pass runs on its own cron, not every night; that
 * row hides at 0 rather than showing a permanent zero.
 */
async function renderNightPanel(board) {
  const data = await boardFetch('/stats/night')
  if (!data || data.ranAt == null) return

  const rows = [{ n: data.linksInferred, label: t('board.nightLinks'), onClick: () => { switchTab('memories'); setMemoryView('graph') } }]
  if (data.insightsProposed > 0) rows.push({ n: data.insightsProposed, label: t('board.nightInsights'), onClick: () => openPatternsSheet() })
  rows.push({ n: data.digestsWritten, label: t('board.nightDigests') })
  rows.push({ n: data.claimsFlagged, label: t('board.nightClaims'), onClick: () => openStaleSheet() })

  const sub = t('board.nightSub', { time: formatDateUI(data.ranAt, { hour: 'numeric', minute: '2-digit' }) })
  const panel = boardPanel('night', { title: t('board.nightTitle'), sub, span: 3 })
  const night = document.createElement('div')
  night.className = 'night'
  rows.forEach((r) => {
    const row = makeBoardRow('night-row', r.onClick)
    row.innerHTML = `<span class="night-n num">${escHtml(formatNumberUI(r.n))}</span><span class="night-t">${escHtml(r.label)}</span>`
    night.appendChild(row)
  })
  panel.body.appendChild(night)
  board.appendChild(panel)
}

/**
 * One literal translate call per type, not a lookup keyed by a runtime
 * string. src/graph/types.ts's EDGE_TYPES is a closed set of 8, so this
 * reads like renderCapsulePanel's slotLabel further down: the i18n scanner only
 * credits a key it can read as a plain quoted literal.
 */
function edgeTypeLabel(type) {
  if (type === 'relates_to') return t('board.edge.relates_to')
  if (type === 'follows') return t('board.edge.follows')
  if (type === 'supersedes') return t('board.edge.supersedes')
  if (type === 'decided') return t('board.edge.decided')
  if (type === 'about_person') return t('board.edge.about_person')
  if (type === 'part_of_project') return t('board.edge.part_of_project')
  if (type === 'caused_by') return t('board.edge.caused_by')
  if (type === 'drawn_from') return t('board.edge.drawn_from')
  return type
}

/**
 * "Kinds of links": the edge-type histogram /stats/graph already returns for
 * the connections tile, reused here via boardFetchOnce rather than fetched
 * twice. The three biggest types draw as bars; the rest as a compact
 * two-column count list, so a long tail of rare types stays readable instead
 * of a row of near-invisible slivers.
 */
async function renderLinksPanel(board) {
  const data = await boardFetchOnce('graph', '/stats/graph')
  const edgeTypes = data && data.edgeTypes
  if (!edgeTypes) return
  const rows = Object.entries(edgeTypes)
    .map(([type, count]) => ({ type, label: edgeTypeLabel(type), count: Number(count) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  if (!rows.length) return

  const total = rows.reduce((n, r) => n + r.count, 0)
  const panel = boardPanel('links', { title: t('board.linksTitle'), sub: tPlural('board.linksSub', total), span: 4 })
  const rest = rows.slice(3)
  let html = boardBars(rows.slice(0, 3))
  if (rest.length) {
    html += `<div class="link-chips">${rest
      .map((r) => `<div class="link-chip"><span>${escHtml(r.label)}</span><span class="num">${escHtml(formatNumberUI(r.count))}</span></div>`)
      .join('')}</div>`
  }
  panel.body.innerHTML = html
  board.appendChild(panel)
}

/** Upkeep: the chores a brain can name but not do for itself. */
async function renderUpkeepPanel(board) {
  const data = await boardFetch('/stats')
  if (!data) return
  const candidates = data.digest_candidates || []
  const unvectorized = data.unvectorized || 0
  const unclassified = data.unclassified || 0
  if (!candidates.length && !unvectorized && !unclassified) return

  const rows = candidates
    .slice(0, 4)
    .map(
      (c) =>
        `<div class="task"><div class="task-t">${escHtml(c.tag)}<span>${escHtml(tPlural('upkeep.digestEntries', c.count))}</span></div><button class="btn btn-secondary btn-sm" type="button" onclick="runDigest('${escAttr(c.tag)}', this)">${escHtml(t('upkeep.digestAction'))}</button></div>`,
    )
  if (unvectorized > 0) {
    rows.push(
      `<div class="task"><div class="task-t">${escHtml(t('upkeep.vectorizeLabel'))}<span>${escHtml(tPlural('upkeep.vectorizeNote', unvectorized))}</span></div><button class="btn btn-secondary btn-sm" type="button" onclick="runVectorize(this)">${escHtml(t('upkeep.vectorizeAction'))}</button></div>`,
    )
  }
  if (unclassified > 0) {
    rows.push(
      `<div class="task"><div class="task-t">${escHtml(t('upkeep.classifyLabel'))}<span>${escHtml(tPlural('upkeep.classifyNote', unclassified))}</span></div><button class="btn btn-secondary btn-sm" type="button" onclick="runClassify(this)">${escHtml(t('upkeep.classifyAction'))}</button></div>`,
    )
  }

  const panel = boardPanel('upkeep', { title: t('board.upkeepTitle'), sub: t('board.upkeepSub'), span: 3 })
  panel.body.innerHTML = `<div class="rows">${rows.join('')}</div>`
  board.appendChild(panel)
}

function integrationIcon(provider) {
  if (/^email-/.test(provider)) return 'ti-mail'
  if (/^calendar-/.test(provider)) return 'ti-calendar'
  if (provider === 'notion') return 'ti-brand-notion'
  return 'ti-plug'
}

/** Connected sources, each with its own last-sync line or a way to connect it. */
async function renderSourcesStatusPanel(board) {
  const data = await boardFetch('/integrations')
  const rows = (data && data.integrations) || []
  if (!rows.length) return

  const panel = boardPanel('sources', {
    title: t('board.sourcesTitle'),
    sub: t('board.sourcesSub'),
    span: 3,
    action: { label: t('board.manage'), onClick: () => openIntegrations() },
  })
  panel.body.innerHTML = `<div class="rows">${rows
    .map((r) => {
      const icon = integrationIcon(r.provider)
      const meta = r.connected
        ? `<i class="src-dot" style="background:var(--good)"></i>${escHtml(t('board.synced', { when: relativeTime(r.lastSyncedAt) }))}`
        : `${escHtml(t('board.notConnected'))} &middot; <a href="#" onclick="openIntegrations(); return false">${escHtml(t('auth.connect'))}</a>`
      return `<div class="src"><i class="ti ${icon}"></i><span class="src-name">${escHtml(r.name)}<span class="src-meta">${meta}</span></span></div>`
    })
    .join('')}</div>`
  board.appendChild(panel)
}

/** The prompt capsule: what every connected tool loads before anything else. */
async function renderCapsulePanel(board) {
  const data = await boardFetch('/prompt-capsules/core')
  if (!data) return
  const bySlot = new Map((data.sections || []).map((s) => [s.slot, s]))
  const omitted = new Set(data.omitted_slots || [])
  // Labels are literal translate-function calls, not a lookup table keyed by
  // slot id: the i18n suite's static scanner only credits a key as "used"
  // when it can read the call site without evaluating anything.
  const slotLabel = (id) => {
    if (id === 'identity') return t('board.slotIdentity')
    if (id === 'preferences') return t('board.slotPreferences')
    if (id === 'constraints') return t('board.slotConstraints')
    return t('board.slotPrinciples')
  }
  const slotIds = ['identity', 'preferences', 'constraints', 'principles']
  const filled = slotIds.filter((id) => bySlot.has(id))
  if (data.populated === false && !filled.length) return

  const countBySlot = new Map()
  for (const s of data.sections || []) countBySlot.set(s.slot, (countBySlot.get(s.slot) || 0) + 1)

  const rows = slotIds.map((id) => {
    const has = bySlot.has(id) && !omitted.has(id)
    const icon = has ? 'ti-circle-check' : 'ti-circle'
    const detail = has ? tPlural('board.slotMemories', countBySlot.get(id) || 1) : t('board.slotEmpty')
    const section = bySlot.get(id)
    const action = has
      ? `onclick="openCapsuleMemory('${escAttr(section.source_entry_id)}', this)"`
      : `onclick="openCapsuleComposer('${escAttr(id)}')"`
    return `<button type="button" class="slot${has ? '' : ' empty'}" ${action}><i class="ti ${icon}"></i><span class="slot-body">${escHtml(slotLabel(id))}<small>${escHtml(detail)}</small></span>${has ? '' : `<span class="slot-add">${escHtml(t('board.capsuleAdd'))}</span>`}</button>`
  })

  const panel = boardPanel('capsule', { title: t('board.capsuleTitle'), sub: t('board.capsuleSub'), span: 3 })
  panel.body.innerHTML = `<div class="slots">${rows.join('')}</div>`
  board.appendChild(panel)
}

function openCapsuleComposer(slot) {
  const field = document.getElementById('home-field')
  if (!field) return
  field.value = ''
  field.placeholder = t('board.capsuleAddHint', { tag: `capsule:core capsule-slot:${slot}` })
  if (typeof lockHomeMode === 'function') lockHomeMode('remember')
  field.focus()
}

// Registration order is display order. Rows fill 8/4, 7/5, 3/3/3/3, 4/4/4
// (see board.css's span classes and its 1240/900/700 breakpoints).
BOARD_PANELS.push(
  renderGrowthPanel,
  renderDecisionPanel,
  renderGraphPanel,
  renderRecalledPanel,
  renderNightPanel,
  renderUpkeepPanel,
  renderSourcesStatusPanel,
  renderCapsulePanel,
  renderResurfacePanel,
  renderLinksPanel,
  renderTopicsPanel,
)

/**
 * Worker version and index health, at the foot of the rail/top bar, plus
 * which Worker this is (from WORKER_URL's own host, never the page's. The
 * desktop app's page origin says nothing about which Worker it talks to).
 * Lets a reviewer tell production from a local Worker at a glance.
 */
async function renderRailNote() {
  let host = ''
  try { host = WORKER_URL ? new URL(WORKER_URL).host : '' } catch { host = '' }
  const hostLine = host ? t('board.railHost', { host }) : ''

  const topbarStatus = document.getElementById('topbar-status')
  if (topbarStatus) topbarStatus.title = hostLine

  const el = document.getElementById('sb-version-note')
  if (!el) return

  // Own fetch rather than boardFetch: /health answers 200 with ok:false
  // whenever Vectorize is absent, and boardFetch nulls any ok:false body.
  // This note renders from the 200 body regardless of the top-level ok flag.
  let body
  try {
    const res = await fetch(`${WORKER_URL}/health`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) { el.textContent = ''; return }
    body = await res.json()
  } catch { el.textContent = ''; return }

  const indexOk = !!(body.vectorize && body.vectorize.ok)
  el.innerHTML = `<b>${escHtml(t('board.railVersion', { v: body.version || '' }))}</b>${escHtml(indexOk ? t('board.railIndexOk') : t('board.railIndexDegraded'))}` +
    (hostLine ? `<br>${escHtml(hostLine)}` : '')
}

async function renderBoard(brief) {
  const tilesEl = document.getElementById('board-tiles'), board = document.getElementById('board')
  if (!tilesEl || !board) return
  // Claim this render pass. Any earlier pass still awaiting a fetch checks
  // this after it resumes and bails rather than appending into a container a
  // newer pass has already cleared and started repopulating.
  const token = ++_boardRenderToken
  tilesEl.style.display = ''
  board.style.display = ''
  _boardFetchCache = new Map()
  tilesEl.innerHTML = ''; board.innerHTML = ''
  const week = ((brief && brief.activity) || []).slice(-7).reduce((n, d) => n + (d.count || 0), 0)
  if (brief && brief.total) tilesEl.appendChild(boardTile('memories', { n: brief.total, label: t('board.tileMemories'), delta: t('board.tileWeek', { n: formatNumberUI(week) }), ariaLabel: t('board.tileOpenMemories'), onClick: () => switchTab('memories') }))
  const graph = await boardFetchOnce('graph', '/stats/graph')
  if (token !== _boardRenderToken) return
  if (graph && graph.edgeTypes) {
    const total = Object.values(graph.edgeTypes).reduce((a, b) => a + Number(b), 0)
    tilesEl.appendChild(boardTile('connections', { n: total, label: t('board.tileConnections'), ariaLabel: t('board.tileOpenGraph'), onClick: () => { switchTab('memories'); setMemoryView('graph') } }))
  }
  const recalled = await boardFetchOnce('recalled', '/stats/recalled?limit=5')
  if (token !== _boardRenderToken) return
  if (recalled && typeof recalled.total_recalls === 'number') {
    tilesEl.appendChild(boardTile('recalls', { n: recalled.total_recalls, label: t('board.tileRecalls'), delta: t('board.tileRecallsDelta'), quiet: true, ariaLabel: t('board.tileGoRecalled'), onClick: () => { const panel = board.querySelector('[data-panel="recalled"]'); if (panel) { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); const heading = panel.querySelector('h2'); if (heading) { heading.tabIndex = -1; heading.focus() } } } }))
  }
  // Same /stats/recalled response the recalls tile above reads (boardFetchOnce
  // shares the one fetch); total_contradictions is absent on an older Worker,
  // in which case the tile stays out rather than showing a false zero.
  if (recalled && typeof recalled.total_contradictions === 'number') {
    tilesEl.appendChild(boardTile('contradictions', { n: recalled.total_contradictions, label: t('board.tileContradictions'), delta: t('board.tileContradictionsDelta'), quiet: true, ariaLabel: t('board.tileOpenContradictions'), onClick: () => { onTagChange('contradiction-resolved'); switchTab('memories') } }))
  }
  tilesEl.hidden = tilesEl.children.length === 0
  for (const fn of BOARD_PANELS) {
    if (token !== _boardRenderToken) return
    try { await fn(board, brief) } catch (e) { console.error('board panel failed:', e) }
  }
  if (token !== _boardRenderToken) return
  try { await renderRailNote() } catch (e) { console.error('rail note failed:', e) }
}
