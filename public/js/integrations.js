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
  // Who to ask, and where a synced page lands — a member can read what the
  // connection IS even though only an admin can act on it (adminsOnly below).
  // Gated on TEAM_MODE, not on mirrorWorkspace having a value: on a solo brain
  // "lands in the personal layer" names a distinction that does not exist.
  const provenance = [
    info.connectedBy ? t('integrations.connectedByLabel', { name: info.connectedBy }) : null,
    TEAM_MODE ? t(`${info.mirrorWorkspace === 'company' ? 'integrations.mirrorShared' : 'integrations.mirrorPersonal'}`) : null,
    info.connectedAt ? t('integrations.connectedOn', { when: new Date(info.connectedAt).toLocaleDateString(localeTag()) }) : null,
  ].filter(Boolean).join(' · ')
  return `
    <div class="integration-row">
      <div class="integration-head"><i class="ti ${icon}"></i><span>${escHtml(info.name)}</span><span class="integration-state connected">${escHtml(info.workspaceName || t('integrations.connected'))}</span></div>
      <p class="digest-note" id="note-${p}">${escHtml(count)} &middot; ${escHtml(t('integrations.lastSync', { when: last }))}</p>
      ${provenance ? `<p class="digest-note">${escHtml(provenance)}</p>` : ''}
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
