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
/** The caller's teams, oldest first — [0] is the one "share with the team" means. */
let teamWorkspaces = []
// The plaintext token the server hands back exactly once. Dropped the moment
// the reveal is dismissed — after that, rotation is the only way back.
let lastTeamToken = ''

/**
 * The team's name, for everyone.
 *
 * Deliberately NOT part of loadTeam(): that probes /team/members, which is 403
 * for a member, so anything hanging off it is admin-only by construction. A
 * member needs the name more than an admin does — it is how they know which
 * company they are about to share into.
 */
async function loadTeamName() {
  if (!WORKER_URL || !AUTH_TOKEN) return
  const el = document.getElementById('sb-team-name')
  try {
    const res = await fetch(`${WORKER_URL}/team/workspaces`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    teamWorkspaces = Array.isArray(data.teams) ? data.teams : []
  } catch {
    teamWorkspaces = []
  }
  renderTeamName()
}

/**
 * Both branches are always set, never just the reveal: TEAM_MODE can go from
 * true to false when the last member is removed, and a name left on screen
 * would name a team that no longer has anyone in it.
 */
function renderTeamName() {
  const name = TEAM_MODE ? (teamWorkspaces[0]?.name || '').trim() : ''
  // Sidebar and mobile topbar both: they are two renderings of one header, and
  // the sidebar is hidden at phone widths.
  for (const id of ['sb-team-name', 'topbar-team-name']) {
    const el = document.getElementById(id)
    if (!el) continue
    el.textContent = name
    el.style.display = name ? '' : 'none'
  }
  const input = document.getElementById('team-name-input')
  if (input && document.activeElement !== input) input.value = teamWorkspaces[0]?.name || ''
}

async function submitTeamName() {
  const input = document.getElementById('team-name-input')
  const btn = document.getElementById('team-name-btn')
  if (!input || !btn) return
  const name = (input.value || '').trim()
  if (!name) { showToast(t('team.nameNeeded')); return }
  btn.disabled = true
  try {
    const r = await postTeam('/team/workspaces/rename', { name })
    if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
    if (teamWorkspaces[0]) teamWorkspaces[0].name = r.data.name
    else teamWorkspaces = [{ id: r.data.id, name: r.data.name, memberCount: 0 }]
    renderTeamName()
    showToast(t('team.nameSaved'))
  } catch (e) {
    showToast(e.message || t('team.actionFailed'))
  } finally {
    btn.disabled = false
  }
}

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
      `<button class="team-icon-btn" title="${escAttr(t('team.rotateToken'))}" aria-label="${escAttr(t('team.rotateToken'))}" onclick="rotateTeamToken('${escAttr(m.userId)}')"><i class="ti ti-key"></i></button>`,
    )
    if (m.suspended) {
      actions.push(
        `<button class="team-icon-btn" title="${escAttr(t('team.restore'))}" aria-label="${escAttr(t('team.restore'))}" onclick="setTeamSuspended('${escAttr(m.userId)}', false)"><i class="ti ti-player-play"></i></button>`,
      )
    } else {
      actions.push(
        `<button class="team-icon-btn" title="${escAttr(t('team.suspend'))}" aria-label="${escAttr(t('team.suspend'))}" onclick="setTeamSuspended('${escAttr(m.userId)}', true)"><i class="ti ti-user-pause"></i></button>`,
      )
    }
    actions.push(
      `<button class="team-icon-btn danger" title="${escAttr(t('team.remove'))}" aria-label="${escAttr(t('team.remove'))}" onclick="removeTeamMember('${escAttr(m.userId)}')"><i class="ti ti-trash"></i></button>`,
    )
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
  return `
    <div class="team-row${m.suspended ? ' suspended' : ''}">
      <div style="min-width: 0">
        <div class="team-name">${escHtml(teamMemberLabel(m))} ${chips}</div>
        ${subline ? `<div class="team-sub">${subline}</div>` : ''}
      </div>
      <label class="team-capture-label" title="${escAttr(t('team.defaultShareTitle'))}">
        ${escHtml(t('team.defaultShareLabel'))}
        <span class="team-select-wrap">
          <select class="team-select" onchange="setMemberDefaultShare('${escAttr(m.userId)}', this.value)">
            ${['personal', 'company', 'inherit']
              .map((v) => `<option value="${v}"${(m.defaultShare || 'inherit') === v ? ' selected' : ''}>${escHtml(teamDefaultShareLabel(v))}</option>`)
              .join('')}
          </select><i class="ti ti-chevron-down"></i>
        </span>
      </label>
      <div class="team-actions">${actions.join('')}</div>
    </div>`
}

function renderTeam() {
  const notice = document.getElementById('team-admins-only')
  const body = document.getElementById('team-body')
  if (notice) notice.style.display = 'none'
  if (!body) return
  body.style.display = ''
  const list = document.getElementById('team-list')
  if (list) {
    list.innerHTML = `
      <div class="team-table">
        <div class="team-head">
          <span>${escHtml(t('team.colMember'))}</span>
          <span>${escHtml(t('team.colCaptures'))}</span>
          <span></span>
        </div>
        ${teamMembers.map(teamMemberRow).join('')}
      </div>`
  }
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

/**
 * Hard offboarding. The server refuses self-removal and last-admin removal;
 * the confirm here carries the destructive detail — the member's PRIVATE
 * memories die with the account, shared ones stay.
 */
async function removeTeamMember(id) {
  const m = teamMembers.find((x) => x.userId === id)
  if (!m) return
  const question = t('team.removeConfirm', {
    name: teamMemberLabel(m),
    n: Number(m.privateEntries) || 0,
  })
  if (!confirm(question)) return
  try {
    const r = await postTeam('/team/members/remove', { id })
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
