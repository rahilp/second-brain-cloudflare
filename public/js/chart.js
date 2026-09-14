// The "Memories over time" stacked area chart. Pure math (monotonePath,
// niceMax, stackSeries) ported from docs/design-mockups/dashboard/template.html;
// renderActivityChart draws it into a container, reading series colors from
// the CSS custom properties (--s1..--s5) so dark mode repaints for free.

/** Fritsch-Carlson monotone cubic through every point; never overshoots. */
function monotonePath(pts) {
  const n = pts.length
  if (n < 2) return ''
  const dx = [], dy = [], m = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    dy.push(pts[i + 1][1] - pts[i][1])
    m.push(dy[i] / dx[i])
  }
  const t = [m[0]]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2)
  t.push(m[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b)
    if (h > 3) { t[i] = (3 * a / h) * m[i]; t[i + 1] = (3 * b / h) * m[i] }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C${pts[i][0] + h},${pts[i][1] + h * t[i]} ${pts[i + 1][0] - h},${pts[i + 1][1] - h * t[i + 1]} ${pts[i + 1][0]},${pts[i + 1][1]}`
  }
  return d
}

/** Rounds a value up to a friendly axis maximum: 1/1.5/2/2.5/3/4/5/6/8/10 * 10^n. */
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v || 1))), f = v / p
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  return (steps.find((s) => f <= s) ?? 10) * p
}

/** Per-row cumulative sums across a row's series values: the stacked tops. */
function stackSeries(rows, k) {
  const n = k || (rows[0] && rows[0].s.length) || 0
  return rows.map((r) => {
    let acc = 0
    const tops = []
    for (let i = 0; i < n; i++) { acc += r.s[i] || 0; tops.push(acc) }
    return tops
  })
}

function chartColor(i) {
  if (typeof getComputedStyle !== 'function') return '#8a8f99'
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--s${i + 1}`)
  return v ? v.trim() : '#8a8f99'
}

/** Sub-line and table caption for the mode the caller has bucketed rows into. */
function chartModeCopy(mode) {
  if (mode === 'week') return { sub: t('board.chartSubWeek'), caption: t('board.chartCaptionWeek'), unit: t('board.chartUnitWeek') }
  if (mode === 'avg7') return { sub: t('board.chartSubAvg'), caption: t('board.chartCaptionAvg'), unit: t('board.chartUnitDay') }
  return { sub: t('board.chartSubDay'), caption: t('board.chartCaptionDay'), unit: t('board.chartUnitDay') }
}

function chartCellText(mode, v) {
  return mode === 'avg7' ? (Math.round(v * 10) / 10).toFixed(1) : String(v)
}

function chartTipTotal(mode, total) {
  return mode === 'avg7' ? `${chartCellText(mode, total)} ${t('board.chartTipPerDay')}` : tPlural('board.chartTipMemories', total)
}

/**
 * Draws a stacked area chart into `el` (the `.chart` container, which must
 * hold an `<svg>` child), plus its legend, table view and hover tooltip
 * (#board-tip, one shared element for every chart on the page).
 *
 * opts: { rows: [{d, label?, s:[...]}, ...], series: [{name}], mode, subEl? }
 * mode picks the tooltip/table wording (day totals vs a 7-day average vs
 * weekly totals); the caller has already bucketed `rows` accordingly. subEl,
 * if given, is the panel's <p class="panel-sub"> — updated to match mode.
 */
function renderActivityChart(el, opts) {
  if (!el) return
  // totalsRows: the unbucketed daily rows behind `rows`, for the legend and
  // aria-label window totals. In avg7 mode `rows` holds overlapping 7-day
  // averages, so summing it directly would count each real capture roughly
  // seven times over, diluted; falls back to `rows` itself when the caller
  // has nothing more raw to offer (day and week modes, where summing `rows`
  // is already exact).
  const { rows, series, mode, subEl, totalsRows } = opts
  const sumRows = totalsRows || rows
  const svg = el.querySelector('svg')
  if (!svg) return
  const copy = chartModeCopy(mode)
  if (subEl) subEl.textContent = copy.sub
  const W = el.clientWidth || 640, H = el.clientHeight || 280
  const padL = 30, padR = 6, padT = 10, padB = 24
  const innerW = W - padL - padR, innerH = H - padT - padB
  const colors = series.map((_, k) => chartColor(k))

  if (!rows.length) { svg.innerHTML = ''; el._chart = null; return }

  const totals = rows.map((r) => r.s.reduce((a, b) => a + b, 0))
  const yMax = niceMax(Math.max(...totals) * 1.06)
  const x = (i) => padL + (rows.length > 1 ? (i / (rows.length - 1)) * innerW : innerW / 2)
  const y = (v) => padT + innerH - (v / yMax) * innerH

  const tops = stackSeries(rows, series.length)
  const stacks = series.map((_, k) => rows.map((_, i) => [x(i), y(tops[i][k])]))
  const base = rows.map((_, i) => [x(i), y(0)])

  let out = '<g class="grid">'
  const ticks = [0, yMax / 4, yMax / 2, (yMax * 3) / 4, yMax]
  ticks.forEach((v) => { out += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>` })
  out += '</g><g class="axis">'
  ticks.forEach((v) => { out += `<text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${Number.isInteger(v) ? v : Math.round(v * 10) / 10}</text>` })
  out += '</g>'
  for (let k = series.length - 1; k >= 0; k--) {
    const top = stacks[k], bottom = k === 0 ? base : stacks[k - 1]
    const area = monotonePath(top) + ' L' + [...bottom].reverse().map((p) => p.join(',')).join(' L') + ' Z'
    out += `<path class="area" data-series="${k}" d="${area}" fill="${colors[k]}"/>`
  }
  for (let k = 0; k < series.length; k++) out += `<path class="line" data-series="${k}" d="${monotonePath(stacks[k])}" stroke="${colors[k]}"/>`
  out += `<line class="cross" id="board-cross" x1="0" x2="0" y1="${padT}" y2="${padT + innerH}"/>`
  series.forEach((_, k) => { out += `<circle class="cross-dot" id="board-dot${k}" r="4" fill="${colors[k]}"/>` })
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.innerHTML = out

  const legend = el.parentElement && el.parentElement.querySelector('.legend')
  let solo = null
  const applySolo = () => {
    svg.querySelectorAll('.area, .line').forEach((path) => {
      const selected = Number(path.dataset.series) === solo
      path.classList.toggle('is-solo', solo !== null && selected)
      path.classList.toggle('is-muted', solo !== null && !selected)
    })
    if (legend) {
      legend.querySelectorAll('.legend-item').forEach((item, index) => {
        const selected = index === solo
        item.classList.toggle('is-solo', solo !== null && selected)
        item.classList.toggle('is-muted', solo !== null && !selected)
        item.setAttribute('aria-pressed', String(selected))
      })
    }
  }
  if (legend) {
    const sums = series.map((_, k) => sumRows.reduce((n, r) => n + (r.s[k] || 0), 0))
    const all = sums.reduce((a, b) => a + b, 0) || 1
    legend.innerHTML = ''
    series.forEach((s, k) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'legend-item'
      item.setAttribute('aria-pressed', 'false')
      item.innerHTML = `<i style="background:${colors[k]}"></i>${escHtml(s.name)} <span class="num">${escHtml(formatNumberUI(sums[k]))} · ${Math.round((sums[k] / all) * 100)}%</span>`
      item.onclick = () => { solo = solo === k ? null : k; applySolo() }
      legend.appendChild(item)
    })
  }

  const table = el.parentElement && el.parentElement.querySelector('.data-table')
  if (table) {
    const caption = table.querySelector('caption')
    if (caption) caption.textContent = copy.caption
    const colLabel = mode === 'week' ? t('board.chartColWeek') : t('board.chartColDay')
    table.querySelector('thead').innerHTML =
      `<tr><th>${escHtml(colLabel)}</th>` + series.map((s) => `<th>${escHtml(s.name)}</th>`).join('') + `<th>${escHtml(t('board.chartColTotal'))}</th></tr>`
    table.querySelector('tbody').innerHTML = rows
      .map((r) => `<tr><td>${escHtml(r.label || r.d)}</td>${r.s.map((v) => `<td class="num">${chartCellText(mode, v)}</td>`).join('')}<td class="num">${chartCellText(mode, r.s.reduce((a, b) => a + b, 0))}</td></tr>`)
      .join('')
  }

  const grandTotal = sumRows.reduce((n, r) => n + r.s.reduce((a, b) => a + b, 0), 0)
  // `days` is the real calendar span (sumRows holds one row per actual day,
  // even in week mode where `rows` holds ~52 weekly buckets); using
  // rows.length there read "53 days" for a 365-day range.
  el.setAttribute('aria-label', t('board.chartAriaLabel', { n: rows.length, unit: copy.unit, days: sumRows.length, total: formatNumberUI(grandTotal) }))

  // Live geometry the shared hover/keyboard handlers below read fresh on every
  // event, rather than closing over this call's rows/x/y: the handlers are
  // wired once (el._boardChartWired) but renderActivityChart is called again
  // on every range change, so the geometry they act on must update in place.
  el._chart = { rows, x, y, padL, innerW, mode, series, colors, svg }

  // ── Hover/keyboard tooltip, one shared #board-tip element ────────────────
  const tip = document.getElementById('board-tip')
  if (!el._boardChartWired && el.addEventListener) {
    el._boardChartWired = true

    const showAt = (i) => {
      const st = el._chart
      if (!st) return null
      i = Math.max(0, Math.min(st.rows.length - 1, i))
      const row = st.rows[i], cx = st.x(i)
      const cross = st.svg.querySelector('#board-cross')
      if (cross) { cross.setAttribute('x1', cx); cross.setAttribute('x2', cx) }
      let acc = 0
      row.s.forEach((v, k) => {
        acc += v
        const dot = st.svg.querySelector(`#board-dot${k}`)
        if (dot) { dot.setAttribute('cx', cx); dot.setAttribute('cy', st.y(acc)) }
      })
      if (tip) {
        const total0 = row.s.reduce((a, b) => a + b, 0)
        tip.innerHTML = `<b>${escHtml(row.label || row.d)}</b> · ${escHtml(chartTipTotal(st.mode, total0))}` +
          row.s.map((v, k) => `<div class="row"><span><i style="background:${st.colors[k]}"></i>${escHtml(st.series[k].name)}</span><em class="num">${chartCellText(st.mode, v)}</em></div>`).join('')
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 }
        tip.style.left = r.left + cx + 'px'
        tip.style.top = r.top - 8 - (tip.offsetHeight || 0) + 'px'
        tip.classList.add('on')
      }
      el.classList.add('hover')
      el._kbIndex = i
      return i
    }
    const hide = () => {
      el.classList.remove('hover')
      if (tip) tip.classList.remove('on')
    }
    el.addEventListener('mousemove', (e) => {
      const st = el._chart
      if (!st) return
      const r = el.getBoundingClientRect()
      showAt(Math.round(((e.clientX - r.left - st.padL) / st.innerW) * (st.rows.length - 1)))
    })
    el.addEventListener('mouseleave', hide)
    // Legend-item buttons are siblings of the svg, not descendants of it, so a
    // keydown while one of them has focus (the natural place focus sits right
    // after toggling isolation) never bubbles to a listener on just the chart
    // container. One handler, wired to both targets, so Escape clears the
    // isolation from wherever focus actually is.
    const handleChartKeydown = (e) => {
      const st = el._chart
      if (!st) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const base = el._kbIndex == null ? st.rows.length - 1 : el._kbIndex
        showAt(base + (e.key === 'ArrowRight' ? 1 : -1))
      } else if (e.key === 'Escape') {
        solo = null
        applySolo()
        hide()
      }
    }
    el.addEventListener('keydown', handleChartKeydown)
    if (legend && legend.addEventListener) legend.addEventListener('keydown', handleChartKeydown)
  }
}
