// ── Integrations (registry-driven) ────────────────────────────────────

// Ordered category groups for the two-level integrations UI. Only categories
// that have at least one registered provider are shown, so Email appears
// automatically once email providers are registered.
const CATEGORY_META = [
  { id: 'knowledge', icon: 'ti-notebook' },
  { id: 'calendar', icon: 'ti-calendar' },
  { id: 'email', icon: 'ti-mail' },
]

const INTEGRATION_ICONS = {
  notion: 'ti-brand-notion',
  'calendar-google': 'ti-brand-google',
  'calendar-outlook': 'ti-brand-windows',
  'calendar-icloud': 'ti-brand-apple',
}

/** Whether this caller may change connections; see loadIntegrations. */
let integrationsAdmin = true
/** Whether this caller IS the tenant owner; see loadIntegrations. Only the
 * owner may run POST /integrations/:provider/move (#347) — mirrored
 * memories live in the owner's own workspace. */
let integrationsOwner = true

function integrationCategoryName(id) {
  const keys = {
    knowledge: 'integrations.categoryKnowledge',
    calendar: 'integrations.categoryCalendars',
    email: 'integrations.categoryEmail',
    other: 'integrations.categoryOther',
  }
  return t(keys[id] || 'integrations.categoryOther')
}

function integrationNounKey(provider) {
  if (provider.startsWith('calendar')) return 'integrations.nounEvent'
  if (provider.startsWith('email')) return 'integrations.nounEmail'
  return 'integrations.nounItem'
}

function integrationNoun(provider, n) {
  return tPlural(integrationNounKey(provider), n)
}

function integrationConnectI18n(provider, field, apiFallback, fallbackKey) {
  const key = `integrations.connect.${provider}.${field}`
  const translated = t(key)
  if (translated !== key) return translated
  if (apiFallback) return apiFallback
  return fallbackKey ? t(fallbackKey) : ''
}

async function loadIntegrations() {
  const el = document.getElementById('integrations-list')
  try {
    const res = await fetch(`${WORKER_URL}/integrations`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await res.json()
    integrationsInfo = data.integrations || []
    // Connections are one per provider for the whole brain, so only an admin can
    // change them. Absent (an older Worker) reads as admin, which is what a
    // single-user brain is.
    integrationsAdmin = data.admin !== false
    // Same absent-reads-as-true fallback as integrationsAdmin, for an older
    // Worker that predates the `owner` field — a solo brain has no other
    // owner it could be.
    integrationsOwner = data.owner !== false
    renderIntegrations()
  } catch {
    el.innerHTML = `<p class="digest-note">${escHtml(t('integrations.loadFailed'))}</p>`
  }
}

// Resolve a provider's category id, falling back to 'other' so nothing is lost.
function integrationCategoryId(info) {
  return CATEGORY_META.some((c) => c.id === info.category) ? info.category : 'other'
}

function categoryMeta(id) {
  return CATEGORY_META.find((c) => c.id === id) || { id, icon: 'ti-plug' }
}

// Categories present in the data, in CATEGORY_META order, with any leftover
// 'other' bucket last.
function presentCategories() {
  const present = new Set(integrationsInfo.map(integrationCategoryId))
  const ordered = CATEGORY_META.filter((c) => present.has(c.id))
  if (present.has('other')) ordered.push(categoryMeta('other'))
  return ordered
}

// Header back-button / title / intro reflect the current level.
function renderIntegrationsChrome() {
  const back = document.getElementById('integrations-back')
  const title = document.getElementById('integrations-title')
  const intro = document.getElementById('integrations-intro')
  if (currentCategory) {
    title.textContent = integrationCategoryName(currentCategory)
    back.setAttribute('title', t('integrations.backList'))
    back.onclick = backToCategoryList
    intro.style.display = 'none'
  } else {
    title.textContent = t('menu.integrations')
    back.setAttribute('title', t('integrations.backSettings'))
    back.onclick = backToMenu
    intro.style.display = ''
  }
}

function renderIntegrations() {
  renderIntegrationsChrome()
  const el = document.getElementById('integrations-list')
  if (!integrationsInfo.length) {
    el.innerHTML = `<p class="digest-note">${escHtml(t('integrations.none'))}</p>`
    return
  }
  if (currentCategory) {
    const cards = integrationsInfo
      .filter((i) => integrationCategoryId(i) === currentCategory)
      .map(renderIntegrationCard)
      .join('')
    el.innerHTML = cards || `<p class="digest-note">${escHtml(t('integrations.emptyCategory'))}</p>`
    return
  }
  el.innerHTML = presentCategories().map(renderCategoryRow).join('')
}

function renderCategoryRow(cat) {
  const items = integrationsInfo.filter((i) => integrationCategoryId(i) === cat.id)
  const connected = items.filter((i) => i.connected).length
  const summary = connected > 0 ? tPlural('integrations.summaryConnected', connected) : t('integrations.notConnected')
  return `
    <button class="integration-category-row" onclick="openCategory('${cat.id}')">
      <i class="ti ${cat.icon}"></i>
      <span class="integration-category-name">${escHtml(integrationCategoryName(cat.id))}</span>
      <span class="integration-category-summary">${escHtml(summary)}</span>
      <i class="ti ti-chevron-right integration-category-chevron"></i>
    </button>`
}

function openCategory(id) {
  currentCategory = id
  renderIntegrations()
}
function backToCategoryList() {
  currentCategory = null
  renderIntegrations()
}

function renderIntegrationCard(info) {
  const p = info.provider
  const icon = INTEGRATION_ICONS[p] || 'ti-plug'
  if (!info.connected) {
    const hint =
      p === 'notion'
        ? t('integrations.notionHint')
        : integrationConnectI18n(p, 'hint', info.connectHint, '')
    const label = escHtml(
      integrationConnectI18n(p, 'label', info.connectLabel, 'integrations.pasteSecret'),
    )
    const isEmail = p.startsWith('email')
    let inputs
    if (isEmail) {
      // Email needs two fields; connectIntegration packs them into the token.
      inputs =
        `<input type="email" id="email-${p}" placeholder="${escAttr(t('integrations.emailPlaceholder'))}" aria-label="${escAttr(t('integrations.emailAria'))}" autocomplete="off" />` +
        `<input type="password" id="tok-${p}" placeholder="${escHtml(
          integrationConnectI18n(p, 'placeholder', info.connectPlaceholder, 'integrations.appPassword'),
        )}" aria-label="${escAttr(t('integrations.appPasswordAria'))}" autocomplete="off" />`
    } else {
      const placeholder = escHtml(
        integrationConnectI18n(
          p,
          'placeholder',
          info.connectPlaceholder,
          p === 'notion' ? 'integrations.notionPlaceholder' : 'integrations.urlPlaceholder',
        ),
      )
      inputs = `<input type="password" id="tok-${p}" placeholder="${placeholder}" aria-label="${label}" autocomplete="off" />`
    }
    const mirrorLayer = TEAM_MODE
      ? `<span class="team-select-wrap"><select class="team-select" id="ws-${p}" title="${escAttr(t('integrations.mirrorLayerTitle'))}">
          <option value="personal">${escHtml(t('team.sharePersonal'))}</option>
          <option value="company">${escHtml(t('team.shareCompany'))}</option>
        </select><i class="ti ti-chevron-down"></i></span>`
      : ''
    const connectRow = integrationsAdmin
      ? `<div class="integration-connect-row${isEmail ? ' integration-connect-col' : ''}">
          ${inputs}
          ${mirrorLayer}
          <button class="digest-btn" onclick="connectIntegration('${p}', this)">${escHtml(t('auth.connect'))}</button>
        </div>
        <div class="integration-error" id="err-${p}"></div>`
      : `<p class="digest-note">${escHtml(t('integrations.adminsOnly'))}</p>`
    return `
      <div class="integration-row">
        <div class="integration-head"><i class="ti ${icon}"></i><span>${escHtml(info.name)}</span><span class="integration-state">${escHtml(t('integrations.notConnected'))}</span></div>
        <p class="digest-note">${hint}</p>
        ${connectRow}
      </div>`
  }
  const last = info.lastSyncedAt
    ? new Date(info.lastSyncedAt).toLocaleString(localeTag())
    : t('integrations.never')
  const count = tPlural('integrations.countSynced', info.itemCount, {
    noun: integrationNoun(p, info.itemCount),
  })
  const err = info.lastSyncError
    ? `<div class="integration-error">${escHtml(t('integrations.lastSyncFailed', { error: info.lastSyncError }))}</div>`
    : ''
  // Who to ask, where a synced page lands, and when it was connected — a member
  // can read what the connection IS even though only an admin can act on it
  // (adminsOnly below).
  //
  // THE WHOLE LINE is gated on TEAM_MODE, not merely its mirror-layer clause.
  // Two of these three facts are not new data: `connectedAt` has been on the
  // record since integrations shipped, and `connectedBy` resolves for any brain
  // whose roster carries a name. Gating only the middle element would therefore
  // grow a "Connected by Owner · Connected 3 Mar" line on a solo brain that did
  // nothing but upgrade — new UI with no user action, which is exactly what the
  // phase's backwards-compatibility constraint forbids. "Lands in the personal
  // layer" is separately meaningless where no other layer exists. So: no team,
  // no provenance line at all.
  const provenance = !TEAM_MODE
    ? ''
    : [
        info.connectedBy ? t('integrations.connectedByLabel', { name: info.connectedBy }) : null,
        // The backticks below are load-bearing, not decorative: the i18n
        // suite's call-site checker only resolves a ternary of quoted literals
        // when it is the sole `${}` inside a template literal (the form
        // public/js/auth.js uses) — the SAME ternary passed as a bare argument,
        // with no surrounding template literal, is invisible to it and registers
        // as an unpinned dynamic call site instead.
        t(`${info.mirrorWorkspace === 'company' ? 'integrations.mirrorShared' : 'integrations.mirrorPersonal'}`),
        info.connectedAt ? t('integrations.connectedOn', { when: new Date(info.connectedAt).toLocaleDateString(localeTag()) }) : null,
      ].filter(Boolean).join(' · ')
  // Admin-only control that lets an already-connected integration move layers
  // without a disconnect/reconnect. Same two-option markup as the not-connected
  // row's select, preselected from the record's current mirrorWorkspace. Gated
  // on TEAM_MODE && integrationsAdmin so a member or a solo brain sees neither
  // this select nor its error slot — see integration-provenance.test.ts's
  // pinned solo-brain fixtures, which this must leave untouched.
  const layerControl = TEAM_MODE && integrationsAdmin
    ? `<p class="digest-note">
        <span class="team-select-wrap"><select class="team-select" id="ws-${p}" title="${escAttr(t('integrations.mirrorLayerTitle'))}" onchange="changeIntegrationLayer('${p}', this, '${info.mirrorWorkspace === 'company' ? 'company' : 'personal'}')">
          <option value="personal"${info.mirrorWorkspace === 'company' ? '' : ' selected'}>${escHtml(t('team.sharePersonal'))}</option>
          <option value="company"${info.mirrorWorkspace === 'company' ? ' selected' : ''}>${escHtml(t('team.shareCompany'))}</option>
        </select><i class="ti ti-chevron-down"></i></span>
        ${escHtml(t('integrations.mirrorLayerNewSyncsOnly'))}
      </p>
      <div class="integration-error" id="err-${p}"></div>`
    : ''
  // Moving already-synced memories into the layer above (#347). Strictly
  // narrower than layerControl's own gate: only the tenant owner may run this,
  // because mirrored memories live in the owner's workspace and moveEntry run
  // as anyone else would silently match nothing. `move-note-${p}` is its own
  // element, deliberately NOT `note-${p}` — that one is sync's own progress
  // surface, and the two drains must not fight over one text node.
  const moveControl = TEAM_MODE && integrationsAdmin && integrationsOwner
    ? `<p class="digest-note">${escHtml(tPlural('integrations.moveHint', info.itemCount, {
        noun: integrationNoun(p, info.itemCount),
        layer: info.mirrorWorkspace === 'company' ? t('team.shareCompany') : t('team.sharePersonal'),
      }))}</p>
      <button class="digest-btn" id="move-${p}" onclick="confirmMoveIntegrationMemories('${p}', this)"><i class="ti ti-arrow-right"></i> ${escHtml(t('integrations.moveNow'))}</button>
      <p class="digest-note" id="move-note-${p}" aria-live="polite"></p>`
    : ''
  return `
    <div class="integration-row">
      <div class="integration-head"><i class="ti ${icon}"></i><span>${escHtml(info.name)}</span><span class="integration-state connected">${escHtml(info.workspaceName || t('integrations.connected'))}</span></div>
      <p class="digest-note" id="note-${p}">${escHtml(count)} &middot; ${escHtml(t('integrations.lastSync', { when: last }))}</p>
      ${provenance ? `<p class="digest-note">${escHtml(provenance)}</p>` : ''}
      ${layerControl}
      ${moveControl}
      ${err}
      ${integrationsAdmin
        ? `<div class="integration-actions">
        <button class="digest-btn" onclick="syncIntegration('${p}', this)"><i class="ti ti-refresh"></i> ${escHtml(t('integrations.syncNow'))}</button>
        <button class="digest-btn danger" onclick="disconnectIntegration('${p}', this)">${escHtml(t('menu.disconnect'))}</button>
      </div>`
        : `<p class="digest-note">${escHtml(t('integrations.adminsOnly'))}</p>`}
    </div>`
}

async function connectIntegration(provider, btn) {
  const errEl = document.getElementById(`err-${provider}`)
  let token
  if (provider.startsWith('email')) {
    const email = (document.getElementById(`email-${provider}`).value || '').trim()
    const pw = (document.getElementById(`tok-${provider}`).value || '').trim()
    if (!email || !pw) { errEl.textContent = t('integrations.needEmailPw'); return }
    token = JSON.stringify({ email: email, appPassword: pw })
  } else {
    token = (document.getElementById(`tok-${provider}`).value || '').trim()
    if (!token) { errEl.textContent = t('integrations.needSecret'); return }
  }
  const wsEl = document.getElementById(`ws-${provider}`)
  const workspace = wsEl && TEAM_MODE ? wsEl.value : 'personal'
  btn.disabled = true
  btn.textContent = t('auth.connectingEllipsis')
  errEl.textContent = ''
  try {
    const res = await fetch(`${WORKER_URL}/integrations/${provider}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ token, workspace }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || t('integrations.couldNotConnectShort'))
    await loadIntegrations()
    // Kick off the first sync automatically.
    const syncBtn = document.querySelector(`[onclick^="syncIntegration('${provider}'"]`)
    if (syncBtn) syncIntegration(provider, syncBtn)
  } catch (e) {
    errEl.textContent = e.message || t('auth.couldNotConnect')
    btn.disabled = false
    btn.textContent = t('auth.connect')
  }
}

/**
 * Move a connected integration's mirror layer without disconnecting.
 *
 * Only an EXPLICIT rejection from the Worker (a parsed JSON body with
 * `ok: false`, e.g. a 403) proves the write never landed — that is the one
 * case it is safe to restore `previousValue` locally. Two other failure
 * shapes can happen AFTER the Worker has already committed and audited the
 * change: `res.json()` throwing on a non-JSON body (a plain-text 404 from the
 * generic router, or a Cloudflare 502/504 HTML page replacing a response
 * whose origin write already succeeded) and the fetch promise rejecting after
 * the request was served. For those, guessing at `previousValue` could show
 * "personal" while the server holds "company", so instead this re-reads the
 * server's actual state via loadIntegrations() (which re-renders from a fresh
 * GET and swallows its own errors) and surfaces the error alongside it. The
 * select is disabled for the duration of the request so a second rapid
 * change cannot fire an overlapping last-write-wins request.
 */
async function changeIntegrationLayer(provider, selectEl, previousValue) {
  if (selectEl.disabled) return
  const errEl = document.getElementById(`err-${provider}`)
  if (errEl) errEl.textContent = ''
  selectEl.disabled = true
  const requested = selectEl.value
  try {
    let res
    try {
      res = await fetch(`${WORKER_URL}/integrations/${provider}/layer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ workspace: requested }),
      })
    } catch (e) {
      // The request may have already been served — do not guess.
      await loadIntegrations()
      if (errEl) errEl.textContent = e.message || t('integrations.layerChangeFailedShort')
      return
    }
    let data
    try {
      data = await res.json()
    } catch {
      // Non-JSON body (plain-text 404, or a gateway HTML page) — same "may
      // have already committed" uncertainty as above.
      await loadIntegrations()
      if (errEl) errEl.textContent = t('integrations.layerChangeFailedShort')
      return
    }
    if (!res.ok || !data.ok) {
      // An explicit, parsed rejection — the server did not commit, so
      // restoring the pre-change value is accurate, not a guess.
      selectEl.value = previousValue
      if (errEl) errEl.textContent = data.error || t('integrations.layerChangeFailedShort')
      return
    }
    await loadIntegrations()
  } finally {
    selectEl.disabled = false
  }
}

async function syncIntegration(provider, btn) {
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('integrations.syncing'))}`
  const note = document.getElementById(`note-${provider}`)
  try {
    // Each call processes a bounded batch and reports what's left — loop
    // until the backlog drains (same pattern as runVectorize).
    let remaining = 1, processed = 0, guard = 0
    while (remaining > 0 && guard < 40) {
      guard++
      const res = await fetch(`${WORKER_URL}/integrations/${provider}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || t('integrations.syncFailed'))
      processed += (data.created ?? 0) + (data.updated ?? 0)
      remaining = data.remaining ?? 0
      if (note) {
        note.textContent = t('integrations.syncingProgress', {
          n: processed,
          noun: integrationNoun(provider, processed),
        })
      }
      // A batch with zero progress means everything in it failed — stop.
      if ((data.created ?? 0) + (data.updated ?? 0) + (data.deleted ?? 0) === 0 && remaining > 0) break
    }
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-check"></i> ${escHtml(tPlural('integrations.synced', processed))}`
    btn.style.color = 'var(--good)'
    setTimeout(loadIntegrations, 900)
    refreshAll()
  } catch (e) {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-alert-triangle"></i> ${escHtml(t('integrations.syncFailed'))}`
    btn.style.color = 'var(--danger)'
    setTimeout(loadIntegrations, 3000)
  }
}

/**
 * The confirmation gate (locked decision 11): openDangerConfirm is the
 * question, moveIntegrationMemories is the operation, and they are two
 * functions so the drain can keep running after the sheet closes, the same
 * way confirmBulkLayerMove's own drain outlives its sheet (public/js/recent.js).
 * Reads itemCount and mirrorWorkspace off integrationsInfo — the same source
 * disconnectIntegration reads its own confirmation facts from.
 */
function confirmMoveIntegrationMemories(provider, btn) {
  const info = integrationsInfo.find((i) => i.provider === provider) || {}
  const sharing = info.mirrorWorkspace === 'company'
  const noun = integrationNoun(provider, info.itemCount)
  // Captured HERE, at confirmation time, and threaded through every page of
  // the drain (#347 review item 5) — moveIntegrationMemories never re-reads
  // the connection's live layer mid-drain, so a layer flip after the user
  // confirmed cannot silently move memories somewhere they never agreed to.
  const expectedTarget = sharing ? 'company' : 'personal'
  openDangerConfirm({
    title: t('danger.confirmMoveTitle'),
    body: tPlural(`${sharing ? 'integrations.confirmMoveBodyShared' : 'integrations.confirmMoveBodyPersonal'}`, info.itemCount, {
      n: info.itemCount,
      noun,
    }),
    confirmLabel: t('integrations.moveNow'),
    // done() closes the sheet immediately and unconditionally — the drain
    // outlives the sheet (locked decision 11) — but the handler still awaits
    // moveIntegrationMemories so a caller driving confirmation programmatically
    // (or runConfirmAction itself) can await the full drain if it chooses to.
    onConfirm: async (_checked, done) => {
      done()
      await moveIntegrationMemories(provider, btn, expectedTarget)
    },
  })
}

/**
 * Pure drain loop for POST /integrations/:provider/move — no DOM, so it can be
 * driven with a fake `post` in tests (see test/ui/move-loop.test.ts). Calls
 * `post(cursor)` with `undefined` first, then the previous response's own
 * `cursor`, until a response comes back with a falsy cursor.
 *
 * Unlike syncIntegration's guard-counted loop, a mid-drain failure here does
 * NOT throw away what was already moved: the thrown Error carries a `.partial`
 * totals object, so the caller can say "N moved so far, safe to resume"
 * instead of a bare "failed". A batch that reports `remaining > 0` but returns
 * the SAME cursor it was called with is a stalled drain (the server made no
 * forward progress through the item map) and fails loudly rather than
 * spinning forever — distinct from a batch that is all refusals but whose
 * cursor keeps advancing, which is real progress through the map even though
 * nothing moved.
 *
 * A finished pass (cursor exhausted) whose vectorFailures is greater than
 * zero means some entries moved in D1 but never got their Vectorize stamp
 * confirmed — moveEntry's no_change branch now carries vectorIds so a fresh
 * walk of the item map (a "repair pass": another call with no cursor) can
 * fix them, since they come back as alreadyThere and get re-stamped. Only
 * worth another pass while it is actually improving: each pass's
 * vectorFailures must be strictly less than the one before it (the first
 * pass is compared against Infinity, so any non-zero result earns one
 * attempt). That strictly-decreasing rule is the termination rule and stays
 * exactly as written — the ceiling below is a backstop against a future
 * regression of it, not a retry policy.
 *
 * A repair pass re-walks the WHOLE item map from index 0, so `missing` and
 * `refused` (and `errored` — see below) would double-count on every pass if
 * accumulated unconditionally: the same stale pointer is "missing" again on
 * every walk, not a newly discovered one. Only the first pass's counts (and
 * the progress denominator they drive) are shown to the operator; `moved`
 * and `alreadyThere` keep accumulating across every pass, since a repair
 * pass turning a moved-but-unstamped entry into a confirmed alreadyThere IS
 * new information.
 */
async function runMoveLoop(provider, post, onProgress) {
  const totals = { moved: 0, alreadyThere: 0, missing: 0, refused: 0, errored: 0 }
  let cursor
  let pass = 0
  let passCount = 0
  let prevPassFailures = Infinity
  let passFailures = 0
  // The first pass's own progress figure, frozen once it finishes — used
  // both to pin the progress denominator during repair passes (which must
  // not inflate it) and to derive the ceiling below, since a repair pass
  // cannot discover more items than the first pass already found.
  let mapSize = null
  for (;;) {
    const sentCursor = cursor
    let res
    try {
      res = await post(cursor)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      err.partial = { ...totals }
      throw err
    }
    totals.moved += res.moved ?? 0
    totals.alreadyThere += res.alreadyThere ?? 0
    if (pass === 0) {
      totals.missing += res.missing ?? 0
      totals.refused += res.refused ?? 0
      totals.errored += res.errored ?? 0
    }
    // The server reports vectorFailures once per call, so a multi-page pass
    // accumulates it across its own pages.
    passFailures += res.vectorFailures ?? 0
    const remaining = res.remaining ?? 0
    let done, total
    if (pass === 0) {
      // Reflects actual moves (plus already-there, which is idempotent
      // success), never missing, refused, or errored — those didn't move
      // anything, so counting them here would inflate the in-progress figure
      // past what actually happened.
      done = totals.moved + totals.alreadyThere
      total = done + remaining
    } else {
      // A repair pass re-walks the same map — it cannot make the map bigger
      // or reveal new items, so the operator sees the size the first pass
      // already established, not an inflated repeat count.
      done = mapSize
      total = mapSize
    }
    if (onProgress) onProgress({ done, total })
    if (remaining > 0 && res.cursor === sentCursor) {
      throw new Error('Move did not advance — the cursor is stalled')
    }
    cursor = res.cursor
    if (!cursor) {
      if (pass === 0) mapSize = done
      if (passFailures > 0 && passFailures < prevPassFailures) {
        prevPassFailures = passFailures
        passFailures = 0
        pass++
        passCount++
        // Backstop against a regression of the strictly-decreasing check
        // above (a mutation-tested `<=` spins forever): the number of
        // repair passes can never exceed the number of items in the map,
        // since vectorFailures is itself bounded by mapSize and strictly
        // decreases by at least 1 each pass. Anything past that is not a
        // slow repair, it is a broken termination rule.
        const ceiling = Math.max(mapSize, 1)
        if (passCount > ceiling) {
          throw new Error(
            `Move did not finish: repair passed ${passCount} times without converging. Stop and check Vectorize/D1 before retrying.`
          )
        }
        // Yield to the macrotask queue between passes so a spinning loop
        // (e.g. from a regression of the check above) stays interruptible
        // instead of starving the event loop with a pure microtask cycle.
        // setTimeout isn't available in every harness this file loads into
        // (see test/ui/move-loop.test.ts's bare vm context), so fall back to
        // a plain microtask there rather than throwing.
        await (typeof setTimeout === 'function'
          ? new Promise((resolve) => setTimeout(resolve, 0))
          : Promise.resolve())
        continue // cursor is already falsy — next call starts a fresh pass
      }
      totals.vectorFailures = passFailures
      return totals
    }
  }
}

/**
 * Drive runMoveLoop against the real Worker route, reporting progress into
 * move-note-${provider} and, on a mid-drain failure, saying plainly that the
 * move stopped partway and that resuming is safe — the upkeep.restore*
 * convention, not syncIntegration's bare "failed" with no count.
 */
async function moveIntegrationMemories(provider, btn, expectedTarget) {
  if (btn.disabled) return
  const note = document.getElementById(`move-note-${provider}`)
  btn.disabled = true
  btn.classList.add('digest-btn--loading')
  btn.innerHTML = `<i class="ti ti-loader-2"></i> ${escHtml(t('integrations.moving'))}`
  const post = async (cursor) => {
    const res = await fetch(`${WORKER_URL}/integrations/${provider}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ ...(cursor ? { cursor } : {}), ...(expectedTarget ? { expectedTarget } : {}) }),
    })
    let data
    try {
      data = await res.json()
    } catch {
      const err = new Error(t('integrations.moveFailedShort'))
      err.status = res.status
      throw err
    }
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || t('integrations.moveFailedShort'))
      err.status = res.status
      throw err
    }
    return data
  }
  try {
    const totals = await runMoveLoop(provider, post, ({ done }) => {
      if (note) {
        note.textContent = t('integrations.movingProgress', {
          n: done,
          noun: integrationNoun(provider, done),
        })
      }
    })
    // The success condition is "did anything productive happen", never a
    // single named field — a D1 problem that makes every item throw reports
    // moved:0 errored:10 forever advancing, and a future counter meaning
    // failure must trip this the same way `errored` and `missing` already do.
    const nothingProductive = totals.moved + totals.alreadyThere === 0
    const failedCount = (totals.refused ?? 0) + (totals.errored ?? 0)
    // Only stale item-map pointers, nothing else went wrong: the existing
    // "nothing left to move" empty state.
    const onlyMissing = nothingProductive && totals.missing > 0 && failedCount === 0
    // Refusals and/or errors, not just stale pointers — a real failure, not
    // an empty map.
    const hasFailures = nothingProductive && failedCount > 0
    // A drain that finishes with outstanding vectorFailures did move the D1
    // rows, but the repair passes inside runMoveLoop couldn't close the gap
    // (a genuinely broken index, most likely) — real, not the "all clear"
    // checkmark, since search still can't see those entries in their new layer.
    const hasVectorFailures = (totals.vectorFailures ?? 0) > 0
    if (hasFailures) {
      // Same short label a network-level failure gets — the operator sees
      // the consequence spelled out in the note below, not here.
      btn.innerHTML = `<i class="ti ti-alert-triangle"></i> ${escHtml(t('integrations.moveFailedShort'))}`
      btn.style.color = ''
    } else if (onlyMissing) {
      btn.innerHTML = `<i class="ti ti-alert-triangle"></i> ${escHtml(t('integrations.moveResultNone'))}`
      btn.style.color = ''
    } else if (hasVectorFailures) {
      btn.innerHTML = `<i class="ti ti-alert-triangle"></i> ${escHtml(t('integrations.moveResultNeedsRepair'))}`
      btn.style.color = ''
    } else {
      btn.innerHTML = `<i class="ti ti-check"></i> ${escHtml(tPlural('integrations.moveResultMoved', totals.moved, { n: totals.moved }))}`
      btn.style.color = 'var(--good)'
    }
    btn.classList.remove('digest-btn--loading')
    btn.disabled = false
    if (note) {
      if (hasFailures) {
        // States the count, that those memories could NOT be moved, and what
        // to do — the consequence, not the field name (`refused`/`errored`).
        note.textContent = tPlural('integrations.moveResultFailed', failedCount, { n: failedCount })
      } else {
        const parts = []
        if (totals.moved > 0) parts.push(tPlural('integrations.moveResultMoved', totals.moved, { n: totals.moved }))
        if (totals.refused > 0) parts.push(tPlural('integrations.moveResultRefused', totals.refused, { n: totals.refused }))
        if (totals.missing > 0) parts.push(tPlural('integrations.moveResultMissing', totals.missing, { n: totals.missing }))
        note.textContent = parts.length ? parts.join(' · ') : t('integrations.moveResultNone')
        if (hasVectorFailures) {
          note.textContent += ' ' + tPlural('integrations.moveVectorFailures', totals.vectorFailures, { n: totals.vectorFailures })
        }
      }
    }
    setTimeout(loadIntegrations, 900)
    refreshAll()
  } catch (e) {
    btn.classList.remove('digest-btn--loading')
    btn.innerHTML = `<i class="ti ti-alert-triangle"></i> ${escHtml(t('integrations.moveFailedShort'))}`
    btn.style.color = 'var(--danger)'
    btn.disabled = false
    const movedSoFar = e.partial ? e.partial.moved : 0
    if (note) {
      if (e.status === 403) {
        // A permission refusal, never a transient failure — retrying (or
        // "resuming") can never fix it, so this copy is deliberately never
        // the retry-safe / resume-safe family, no matter how much already
        // moved before the refusal landed.
        note.textContent = t('integrations.moveRefusedOwner')
      } else if (e.status === 409) {
        // The confirmed layer no longer matches the connection's current
        // one — a fresh confirmation is required, not a resume: blindly
        // continuing would move memories into a layer the user never agreed to.
        note.textContent = t('integrations.moveLayerChanged')
      } else if (movedSoFar > 0) {
        note.textContent = t('integrations.moveStoppedPartway', { n: movedSoFar })
      } else {
        note.textContent = t('integrations.moveFailedFirstCall')
      }
    }
  }
}

/**
 * Drop a connection, optionally taking what it synced with it.
 *
 * This used to ask twice in a row: disconnect?, then delete the memories?.
 * Two stacked dialogs for one action is what teaches people to click through
 * without reading, and the second question was never a second decision — it
 * modifies the first. So it is a checkbox on the one sheet, and it is only
 * offered when there is actually something to delete. A hidden checkbox
 * reports false, which is the same default the second confirm had.
 */
async function disconnectIntegration(provider, btn) {
  const info = integrationsInfo.find((i) => i.provider === provider) || {}
  openDangerConfirm({
    title: t('danger.disconnectTitle'),
    body: t('integrations.disconnectConfirm', { name: info.name || provider }),
    confirmLabel: t('menu.disconnect'),
    checkboxLabel:
      info.itemCount > 0
        ? tPlural('integrations.purgeConfirm', info.itemCount, {
            noun: tPlural('integrations.nounMemory', info.itemCount),
          })
        : '',
    onConfirm: async (purge, done) => {
      btn.disabled = true
      btn.textContent = t('integrations.disconnecting')
      try {
        const res = await fetch(`${WORKER_URL}/integrations/${provider}/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
          body: JSON.stringify({ purge }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || t('integrations.disconnectFailed'))
        await loadIntegrations()
        if (purge) refreshAll()
      } catch (e) {
        btn.disabled = false
        btn.textContent = t('menu.disconnect')
        showToast(e.message || t('integrations.disconnectFailed'))
      }
      done()
    },
  })
}
