// The daily brief: what the brain did while you were away.
//
// Recall used to open on a hero line and a text box, with roughly 80% of the
// screen empty, on a brain holding thousands of memories that four nightly
// jobs had spent the night compressing, linking and judging. None of that work
// was visible anywhere until you went looking for it in a settings menu.
//
// Everything here is read back, never computed: one GET /brief, no AI calls —
// with one deliberate exception. /brief hands back a third pending insight
// beyond the two the card shows, purely as a sign a backlog exists; getting
// its exact size costs a second request, made only once that sign has fired
// (see loadMoreInsightsTotal below).
// The brief is deliberately small and quiet — if nothing happened it says
// almost nothing rather than inventing activity, because a home screen that
// manufactures news to justify itself is worse than an empty one.

/** Cached for the session: the brief describes the night, not the minute. */
let briefData = null
let homeInitialized = false

async function loadBrief() {
  const el = document.getElementById('brief')
  if (!el) return
  try {
    const res = await fetch(`${WORKER_URL}/brief`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) return // an older Worker has no /brief; the hero stays
    briefData = await res.json()
    if (!briefData.ok) return
    if ((briefData.patterns || []).length > 2) {
      briefData.patternsTotal = await loadMoreInsightsTotal()
    }
    if (typeof renderHome === 'function') renderHome(briefData)
    // returnHome() renders the brief itself (it may be showing a stale one
    // from before a conversation), so the first load must not also render it
    // here. Two un-awaited renderBoard() runs would race and interleave.
    if (!homeInitialized && typeof returnHome === 'function') {
      homeInitialized = true
      returnHome()
    } else {
      renderBrief(briefData)
    }
  } catch {
    // Offline or a stale deploy — the welcome hero is a fine fallback.
  }
}

/**
 * How many insights are actually waiting, asked for only when the brief
 * already knows there are more than it can show (a third row came back from
 * /brief's LIMIT 3). Same endpoint the Upkeep panel counts against
 * (loadPatternCount, patterns.js) — `limit=1` costs the same regardless of
 * how large the real queue is.
 */
async function loadMoreInsightsTotal() {
  try {
    const res = await fetch(`${WORKER_URL}/patterns?limit=1`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    return data.ok ? data.total : null
  } catch {
    return null // the card still reads fine without a number
  }
}

/**
 * Two weeks of captures as a bar strip. Deliberately unlabelled: the shape is
 * the information — whether the last fortnight was steady, bursty, or quiet —
 * and axis furniture would cost more space than it explains. Exact counts live
 * in the tooltips.
 */
function briefActivity(activity) {
  if (!activity || !activity.length) return ''
  const peak = Math.max(...activity.map((d) => d.count), 1)
  const bars = activity
    .map((d) => {
      const pct = Math.round((d.count / peak) * 100)
      const when = formatDateUI(d.day * 86400000, { month: 'short', day: 'numeric' })
      const title = tPlural('brief.activityTitle', d.count, { date: when })
      return `<span class="spark-bar${d.count ? '' : ' spark-bar--empty'}" style="height:${Math.max(pct, 3)}%" title="${escAttr(title)}"></span>`
    })
    .join('')
  return `<div class="brief-panel">
      <div class="brief-label">${escHtml(t('brief.lastDays', { n: activity.length }))}</div>
      <div class="spark">${bars}</div>
    </div>`
}

/** Where memories came from, as proportion rather than a list of numbers. */
function briefSources(sources) {
  if (!sources || !sources.length) return ''
  const total = sources.reduce((sum, s) => sum + s.count, 0) || 1
  const rows = sources
    .slice(0, 4)
    .map((s) => {
      const badge = sourceBadge(s.source)
      const pct = Math.round((s.count / total) * 100)
      return `<div class="src-row">
        <span class="src-name"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>
        <span class="src-bar"><span class="src-fill" style="width:${pct}%"></span></span>
        <span class="src-n">${s.count}</span>
      </div>`
    })
    .join('')
  return `<div class="brief-panel">
      <div class="brief-label">${escHtml(t('brief.whereFrom'))}</div>
      ${rows}
    </div>`
}

/**
 * The only row that asks for anything. Silent when there is nothing to do,
 * because a dashboard that always shows a chore invents chores.
 */
function briefAttention(a) {
  if (!a) return ''
  const items = []
  if (a.unindexed > 0) {
    items.push(`<button class="attn" onclick="openMenu()"><i class="ti ti-eye-off"></i>${escHtml(t('brief.attentionUnindexed', { n: a.unindexed }))}</button>`)
  }
  if (a.stale > 0) {
    // Opens the queue, not a search. The count is computed from an exact tag
    // predicate, so the entries behind it are knowable — asking the vector index
    // for the phrase "what might be out of date" instead returned whichever
    // memories happened to contain those words, which is never reliably the ones
    // the number refers to.
    items.push(`<button class="attn" onclick="openStaleSheet()"><i class="ti ti-clock-exclamation"></i>${escHtml(t('brief.attentionStale', { n: a.stale }))}</button>`)
  }
  if (!items.length) return ''
  return `<div class="brief-attention">${items.join('')}</div>`
}

function renderBrief(data) {
  const el = document.getElementById('brief')
  const hero = document.getElementById('recall-welcome')

  // The board (board.js) owns every one of these panels now: the decisions
  // thread has the patterns and the attention chips, the growth chart has the
  // activity strip and (in its legend) the source proportions, and its own
  // reread panel has the resurfaced memory. Rendering the legacy #brief block
  // alongside it would show the same insights and numbers twice on one
  // screen, so this only falls back to the inline block below when board.js
  // has not loaded (a stale cache, or a build that predates it).
  if (typeof renderBoard === 'function') {
    if (el) el.style.display = 'none'
    renderBoard(data)
    return
  }

  // Topics live under the home input, where they read as questions worth
  // asking. Repeating them here as a panel said the same thing twice on one
  // screen.
  const panels = [briefActivity(data.activity), briefSources(data.sources)].filter(Boolean)

  const cards = []
  // Patterns are excluded from recall until ruled on, so one sitting unseen in
  // a settings menu is the same as one thrown away.
  const pending = data.patterns || []
  for (const p of pending.slice(0, 2)) {
    // An insight IS the content, not a headline for it — clipping it to a
    // title-length snippet asked for a Confirm/Dismiss decision on a sentence
    // the card cut off. The pass writes one or two sentences and rejects
    // anything under 40 characters, so the full text is always this short.
    const { text, shape } = splitInsightShape(p.content)
    const label = shape
      ? `${t('brief.patternNoticed')}${t('brief.shapeSuffix', { shape: t(`patterns.shapes.${shape}`) })}`
      : t('brief.patternNoticed')
    cards.push(`
      <div class="brief-card" data-pattern="${escAttr(p.id)}">
        <div class="brief-label">${escHtml(label)}</div>
        <div class="brief-body">${escHtml(text)}</div>
        <div class="brief-actions">
          <button class="digest-btn digest-btn--primary" onclick="briefResolvePattern('${escAttr(p.id)}', 'confirm', this)">${escHtml(t('brief.confirm'))}</button>
          <button class="digest-btn danger" onclick="briefResolvePattern('${escAttr(p.id)}', 'dismiss', this)">${escHtml(t('brief.dismiss'))}</button>
        </div>
      </div>`)
  }
  // The brief only ever shows two; a brain that has been running a while has
  // more behind them, and the only route there used to be the "⋯" menu's
  // Upkeep group, which stays hidden unless a chore happens to be pending.
  // The /brief query itself fetches one row past what the card shows
  // (LIMIT 3, see src/routes/admin.ts) purely as this signal — asking for the
  // real total would be a seventh D1 query on every app open, so that only
  // happens once the signal has actually fired (loadBrief, below).
  if (pending.length > 2) {
    const moreLabel =
      typeof data.patternsTotal === 'number' && data.patternsTotal > 2
        ? tPlural('brief.moreInsights', data.patternsTotal - 2)
        : t('brief.moreInsightsGeneric')
    cards.push(`<button class="digest-more brief-more" onclick="openPatternsSheet()">${escHtml(moreLabel)}</button>`)
  }
  if (data.resurface) {
    const when = data.resurface.created_at
      ? formatDateUI(data.resurface.created_at, { year: 'numeric', month: 'short', day: 'numeric' })
      : ''
    cards.push(`
      <div class="brief-card brief-card--quiet">
        <div class="brief-label">${escHtml(when ? `${t('brief.worthRereading')}${t('brief.fromDate', { date: when })}` : t('brief.worthRereading'))}</div>
        <div class="brief-body">${escHtml(titleLine(data.resurface.content, 180))}</div>
      </div>`)
  }

  const attention = briefAttention(data.attention)
  // Attention is the most actionable thing here, so it decides on its own
  // whether the brief has something to say. Gating it behind the panels meant a
  // brain whose only news was "2 not searchable" showed nothing at all.
  if (!attention && !panels.length && !cards.length) return

  // The home composition owns the top of the screen now, so the brief renders
  // below it and leads with the row that asks for something rather than with
  // the headline count, which the greeting already carries.
  if (hero) hero.style.display = 'none'
  el.style.display = ''
  el.innerHTML =
    attention +
    `<div class="brief-eyebrow">${escHtml(t('brief.eyebrow'))}</div>` +
    (panels.length ? `<div class="brief-grid">${panels.join('')}</div>` : '') +
    cards.join('')
}

/** Confirm or dismiss without leaving the brief; the row settles in place. */
async function briefResolvePattern(id, action, btn) {
  const card = btn.closest('.brief-card')
  card.querySelectorAll('button').forEach((b) => (b.disabled = true))
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('upkeep.working'))}`
  try {
    const res = await fetch(`${WORKER_URL}/patterns/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id, action }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'failed')
    card.innerHTML = `<div class="brief-label" aria-live="polite">${escHtml(action === 'confirm' ? t('brief.confirmed') : t('brief.dismissed'))}</div>`
    card.classList.add('brief-card--quiet', 'stop--settled')
    const label = card.querySelector('.brief-label')
    if (label) { label.tabIndex = -1; label.focus() }
    // Settling this stop shrinks it (its body and actions hide), so the
    // thread (sized once at first render for the taller layout) has to be
    // refit or it runs on past the last dot into the panel below. The
    // ResizeObserver in board.js's fitThread also catches this, but that
    // fires async on the next frame; refitting here too keeps it in sync
    // with the same paint the collapse happens in.
    const panelBody = card.closest('.panel-body')
    if (panelBody && typeof refitThread === 'function') refitThread(panelBody)
  } catch {
    card.querySelectorAll('button').forEach((b) => (b.disabled = false))
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = escHtml(t('brief.failedRetry'))
  }
}
