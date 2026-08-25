// ── Team administration ───────────────────────────────────────────────────
//
// Members, tokens and suspensions for the Team Edition. Everything here hangs
// off one question — "is whoever is holding this bearer token an admin?" — and
// the Worker already answers it implicitly: GET /team/members is 200 for an
// admin and 403 for everyone else. That probe doubles as the data fetch, so
// the nav entries ship hidden and appear only once the roster is actually in
// hand; a personal install never sees the panel exist.

let teamMembers = []
let teamYouId = null
// The plaintext token the server hands back exactly once. Dropped the moment
// the reveal is dismissed — after that, rotation is the only way back.
let lastTeamToken = ''

/** The sidebar and bottom-bar entries exist in the markup, hidden by default. */
function setTeamNavVisible(visible) {
  ;['sb-tab-team', 'tab-team'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.style.display = visible ? '' : 'none'
  })
}

/**
 * Fetch the roster and decide, from how that goes, whether this user ever
 * sees the Team tab. Runs at connect time and again on every visit to the
 * screen, because suspensions and rotations can happen while the window sits.
 */
async function loadTeam() {
  if (!WORKER_URL || !AUTH_TOKEN) return
  try {
    const res = await fetch(`${WORKER_URL}/team/members`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    if (!data.ok || !Array.isArray(data.members)) throw new Error(t('common.invalidResponse'))
    teamMembers = data.members
    teamYouId = data.you ?? null
    setTeamNavVisible(true)
    renderTeam()
  } catch {
    // 401 (signed out), 403 (not an admin) and unreachable servers all land
    // here, and all mean the same thing: quietly stand down.
    setTeamNavVisible(false)
    renderTeamAdminsOnly()
  }
}

function renderTeamAdminsOnly() {
  const notice = document.getElementById('team-admins-only')
  const body = document.getElementById('team-body')
  if (notice) notice.style.display = ''
  if (body) body.style.display = 'none'
}

function teamRoleLabel(role) {
  return role === 'admin' ? t('team.roleAdmin') : t('team.roleMember')
}

function teamMemberLabel(m) {
  return m.name || m.email || m.userId
}

function teamMemberRow(m) {
  const isSelf = teamYouId != null && m.userId === teamYouId
  const actions = []
  if (!isSelf) {
    actions.push(
      `<button class="digest-btn" onclick="rotateTeamToken('${escAttr(m.userId)}')">${escHtml(t('team.rotateToken'))}</button>`,
    )
    if (m.suspended) {
      actions.push(
        `<button class="digest-btn" onclick="setTeamSuspended('${escAttr(m.userId)}', false)">${escHtml(t('team.restore'))}</button>`,
      )
    } else {
      actions.push(
        `<button class="digest-btn danger" onclick="setTeamSuspended('${escAttr(m.userId)}', true)">${escHtml(t('team.suspend'))}</button>`,
      )
    }
  }
  const chips = [
    `<span class="tag-chip">${escHtml(teamRoleLabel(m.role))}</span>`,
    isSelf ? `<span class="tag-chip">${escHtml(t('team.you'))}</span>` : '',
    m.suspended ? `<span class="tag-chip">${escHtml(t('team.suspendedChip'))}</span>` : '',
  ]
    .join('')
  const subline = [m.email, tPlural('team.privateEntries', Number(m.privateEntries) || 0)]
    .filter(Boolean)
    .map(escHtml)
    .join(' · ')
  const defaultSel = `
    <select class="filter-field" onchange="setMemberDefaultShare('${escAttr(m.userId)}', this.value)" title="${escAttr(t('team.defaultShareTitle'))}">
      ${['personal', 'company', 'inherit']
        .map((v) => `<option value="${v}"${(m.defaultShare || 'inherit') === v ? ' selected' : ''}>${escHtml(teamDefaultShareLabel(v))}</option>`)
        .join('')}
    </select>`
  return `
    <div class="digest-candidate-row">
      <div class="digest-candidate-label">
        <div>${escHtml(teamMemberLabel(m))} ${chips}</div>
        ${subline ? `<div class="digest-candidate-count">${subline}</div>` : ''}
      </div>
      <div class="card-actions">${defaultSel}${actions.length ? actions.join('') : ''}</div>
    </div>`
}

function renderTeam() {
  const notice = document.getElementById('team-admins-only')
  const body = document.getElementById('team-body')
  if (notice) notice.style.display = 'none'
  if (!body) return
  body.style.display = ''
  const list = document.getElementById('team-list')
  if (list) list.innerHTML = teamMembers.map(teamMemberRow).join('')
  loadTeamOrgDefault()
}

async function postTeam(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify(body),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  return { ok: res.ok, status: res.status, data }
}

function showTeamError(message) {
  const el = document.getElementById('team-add-error')
  if (!el) return
  el.textContent = message
  el.style.display = message ? '' : 'none'
}

/**
 * One-time token reveal. A section rather than a dialog: the token is long,
 * the point is to sit there until it has been copied, and a modal invites
 * dismissing it by accident.
 */
function showTeamToken(token, name) {
  lastTeamToken = token
  const wrap = document.getElementById('team-token-reveal')
  if (!wrap) return
  const sub = document.getElementById('team-token-for')
  if (sub) sub.textContent = t('team.tokenFor', { name })
  const val = document.getElementById('team-token-value')
  if (val) val.textContent = token
  const copyBtn = document.getElementById('team-copy-btn')
  if (copyBtn) copyBtn.textContent = t('team.copy')
  wrap.style.display = ''
  if (wrap.scrollIntoView) wrap.scrollIntoView({ block: 'nearest' })
}

function closeTeamTokenReveal() {
  const wrap = document.getElementById('team-token-reveal')
  if (wrap) wrap.style.display = 'none'
  const val = document.getElementById('team-token-value')
  if (val) val.textContent = ''
  lastTeamToken = ''
}

function copyTeamToken() {
  if (!lastTeamToken || !navigator.clipboard) return
  navigator.clipboard.writeText(lastTeamToken)
  const btn = document.getElementById('team-copy-btn')
  if (!btn) return
  btn.textContent = t('team.copied')
  setTimeout(() => {
    btn.textContent = t('team.copy')
  }, 1500)
}

async function submitNewMember() {
  const nameEl = document.getElementById('team-add-name')
  const emailEl = document.getElementById('team-add-email')
  const roleEl = document.getElementById('team-add-role')
  const btn = document.getElementById('team-add-btn')
  const name = (nameEl?.value || '').trim()
  const email = (emailEl?.value || '').trim()
  const role = roleEl?.value === 'admin' ? 'admin' : 'member'
  showTeamError('')
  if (!name) {
    showTeamError(t('team.needName'))
    return
  }
  if (btn) {
    btn.disabled = true
    btn.textContent = t('team.adding')
  }
  try {
    const r = await postTeam('/team/members', { name, ...(email ? { email } : {}), role })
    if (r.status === 409) throw new Error(t('team.duplicateEmail'))
    if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
    showTeamToken(r.data.token, r.data.member?.name || name)
    if (nameEl) nameEl.value = ''
    if (emailEl) emailEl.value = ''
    if (roleEl) roleEl.value = 'member'
    await loadTeam()
  } catch (e) {
    showTeamError(e.message || t('team.actionFailed'))
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = t('team.addAction')
    }
  }
}

async function rotateTeamToken(id) {
  const m = teamMembers.find((x) => x.userId === id)
  if (!m) return
  if (!confirm(t('team.rotateConfirm', { name: teamMemberLabel(m) }))) return
  try {
    const r = await postTeam('/team/members/token', { id })
    if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
    showTeamToken(r.data.token, teamMemberLabel(m))
  } catch (e) {
    alert(e.message || t('team.actionFailed'))
  }
}

async function setTeamSuspended(id, suspended) {
  const m = teamMembers.find((x) => x.userId === id)
  if (!m) return
  const question = suspended ? t('team.suspendConfirm', { name: teamMemberLabel(m) }) : t('team.restoreConfirm', { name: teamMemberLabel(m) })
  if (!confirm(question)) return
  try {
    const r = await postTeam('/team/members/suspend', { id, suspended })
    if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
    await loadTeam()
  } catch (e) {
    alert(e.message || t('team.actionFailed'))
  }
}

// ── Capture-visibility defaults ───────────────────────────────────────────
//
// Where a member's new captures land when neither they nor their client say:
// the org default (config TEAM_DEFAULT_WORKSPACE), unless the member has their
// own override. Both controls live here so the policy is visible in one place.

function teamDefaultShareLabel(value) {
  return value === 'company' ? t('team.shareCompany') : value === 'personal' ? t('team.sharePersonal') : t('team.shareInherit')
}

async function setMemberDefaultShare(id, value) {
  const m = teamMembers.find((x) => x.userId === id)
  if (!m) return
  try {
    const r = await postTeam('/team/members/default-share', { id, default: value })
    if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
    m.defaultShare = value === 'inherit' ? '' : value
    renderTeam()
  } catch (e) {
    alert(e.message || t('team.actionFailed'))
    await loadTeam()
  }
}

async function loadTeamOrgDefault() {
  const sel = document.getElementById('team-org-default')
  if (!sel) return
  try {
    const res = await fetch(`${WORKER_URL}/config`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    sel.value = data?.config?.TEAM_DEFAULT_WORKSPACE === 'company' ? 'company' : 'personal'
  } catch {
    sel.value = 'personal'
  }
}

async function setTeamOrgDefault(value) {
  try {
    // PATCH /config is a sparse key→value patch for the whole settings blob.
    const res = await fetch(`${WORKER_URL}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ TEAM_DEFAULT_WORKSPACE: value }),
    })
    if (!res.ok) throw new Error(t('team.actionFailed'))
  } catch (e) {
    alert(e.message || t('team.actionFailed'))
    await loadTeamOrgDefault()
  }
}
