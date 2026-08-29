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
/** GET /team/roster's members — names and roles only. The member view's list. */
let teamRoster = []
/** GET /team/roster's teams, same shape as teamWorkspaces but for a member. */
let teamRosterTeams = []
/** { defaultShare, orgDefault, effectiveDefault } from GET /team/me, or null. */
let teamMyDefault = null
/** The caller's teams, oldest first — [0] is the one "share with the team" means. */
let teamWorkspaces = []
// The plaintext token the server hands back exactly once, plus who it is for.
// The token is dropped the moment the reveal is dismissed — after that,
// rotation is the only way back.
let lastTeamInvite = { name: '', email: '', token: '' }

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
 * Fetch the roster and decide, from how that goes, which of the screen's three
 * states this user gets. Runs at connect time and again on every visit to the
 * screen, because suspensions and rotations can happen while the window sits.
 *
 * The admin probe stays first and stays exactly as it was: an admin makes ONE
 * request and /team/members is both their answer and their data. Only a caller
 * it refuses pays for a second call, and /team/roster is the endpoint that can
 * tell the three refusals apart — 403-because-not-an-admin has a screen now,
 * 401 and unreachable still do not.
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
    await loadTeamMemberView()
  }
}

/**
 * The member's half of the screen.
 *
 * /team/roster is identity-scoped (requireIdentity, not requireAdmin), so a
 * signed-in member gets 200 here after the admin probe gave them 403. Anything
 * else — 401 from a token that no longer resolves, 404 from a Worker older than
 * this endpoint, a network failure — leaves the screen where it was: hidden nav,
 * quiet notice, nothing claimed.
 *
 * `admin` in the response is the caller's OWN role, so it needs no third probe
 * to be trusted. Reaching here having been told yes means /team/members failed
 * for some reason other than permission, and a member view is the wrong answer
 * for an admin — so that stands down too.
 */
async function loadTeamMemberView() {
  try {
    const res = await fetch(`${WORKER_URL}/team/roster`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    if (!data.ok || !Array.isArray(data.members)) throw new Error(t('common.invalidResponse'))
    if (data.admin) throw new Error('admin')
    teamRoster = data.members
    teamRosterTeams = Array.isArray(data.teams) ? data.teams : []
    teamYouId = data.you ?? null
    await loadMyCaptureDefault()
    setTeamNavVisible(true)
    renderTeamMember()
  } catch {
    setTeamNavVisible(false)
    renderTeamAdminsOnly()
  }
}

/**
 * Where this member's next capture lands, straight from the server.
 *
 * The same GET /team/me the composer hint reads (js/home.js), fetched again
 * rather than shared: the composer's copy is loaded on a /health reveal that
 * this screen does not wait for, and a Team screen showing a policy from
 * whenever the window was opened is worse than one round trip.
 *
 * A failure leaves it null and the readout is omitted entirely — a guessed
 * default is the one thing this section must never show.
 */
async function loadMyCaptureDefault() {
  try {
    const res = await fetch(`${WORKER_URL}/team/me`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (!res.ok) throw new Error(String(res.status))
    const p = (await res.json()).profile || {}
    teamMyDefault = { defaultShare: p.defaultShare, orgDefault: p.orgDefault, effectiveDefault: p.effectiveDefault }
  } catch {
    teamMyDefault = null
  }
}

/** One row of the member-facing roster: a name, a role, and — for the caller's
 *  own row — the same "you" chip the admin panel uses. Deliberately NOT built
 *  on teamMemberRow/teamMemberLabel: those fall back to an email and carry
 *  counts, timestamps and actions, none of which /team/roster returns and none
 *  of which a member may see. */
function teamRosterRow(m) {
  const isSelf = teamYouId != null && m.userId === teamYouId
  const chips = [
    `<span class="tag-chip">${escHtml(teamRoleLabel(m.role))}</span>`,
    isSelf ? `<span class="tag-chip">${escHtml(t('team.you'))}</span>` : '',
  ].join('')
  return `
    <div class="team-row">
      <div style="min-width: 0">
        <div class="team-name">${escHtml(m.name || m.userId)} ${chips}</div>
      </div>
    </div>`
}

/**
 * All three states are set every time, never just the one being revealed: the
 * screen is re-rendered on every visit, and an admin demoted to member (or the
 * reverse) while the window sits would otherwise be left looking at the panel
 * their new role no longer entitles them to.
 */
function renderTeamMember() {
  const notice = document.getElementById('team-admins-only')
  const body = document.getElementById('team-body')
  const view = document.getElementById('team-member-view')
  if (notice) notice.style.display = 'none'
  if (body) body.style.display = 'none'
  if (!view) return
  view.style.display = ''
  const teamName = (teamRosterTeams[0]?.name || '').trim()
  // Verbatim from effectiveDefault — see captureDefaultKey in utils.js, which
  // the composer hint reads too so the two can never say different things.
  // POST /team/me/default-share (below, setMyDefaultShare) makes the member
  // the owner of this value on both screens, so this is the same key the
  // composer would read for the same profile — no per-screen wording.
  const defaultKey = captureDefaultKey(teamMyDefault)
  view.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 24px;">
      ${teamName ? `<div>
        <div class="digest-section-label">${escHtml(t('team.nameLabel'))}</div>
        <div class="team-table"><div class="team-row">
          <div class="team-name">${escHtml(teamName)}</div>
        </div></div>
      </div>` : ''}
      ${defaultKey ? `<div>
        <div class="digest-section-label">${escHtml(t('team.yourCaptureTitle'))}</div>
        <div class="team-table"><div class="team-row">
          <div style="min-width: 0">
            <div class="team-name">${escHtml(t(defaultKey))}</div>
            <div class="team-sub">${escHtml(t('team.yourCaptureHint'))}</div>
          </div>
          ${teamShareSelect({
            id: 'team-my-default',
            onchange: 'setMyDefaultShare(this.value)',
            selected: teamMyDefault.defaultShare,
            title: t('team.myDefaultLabel'),
            label: t('team.myDefaultLabel'),
          })}
        </div></div>
      </div>` : ''}
      <div>
        <div class="digest-section-label">${escHtml(t('team.membersLabel'))}</div>
        <div class="team-table">${teamRoster.map(teamRosterRow).join('')}</div>
        <p class="digest-note" style="margin: 8px 2px 0;">${escHtml(t('team.rosterHint'))}</p>
      </div>
    </div>`
}

function renderTeamAdminsOnly() {
  const notice = document.getElementById('team-admins-only')
  const body = document.getElementById('team-body')
  const view = document.getElementById('team-member-view')
  if (notice) notice.style.display = ''
  if (body) body.style.display = 'none'
  // Both branches, every render: a member whose token stops resolving while the
  // window sits must not keep their colleagues' names on screen.
  if (view) {
    view.style.display = 'none'
    view.innerHTML = ''
  }
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
  // Whether a token is still in use is the question an admin is actually asking
  // before they rotate or suspend one. Up to an hour stale by design, so the
  // relative form is the honest one — an exact clock time would claim a
  // precision the throttled write does not have.
  const lastUsed = Number(m.lastUsedAt) > 0
    ? t('team.lastUsed', { when: relativeTime(m.lastUsedAt) })
    : t('team.lastUsedNever')
  const subline = [m.email, tPlural('team.privateEntries', Number(m.privateEntries) || 0), lastUsed]
    .filter(Boolean)
    .map(escHtml)
    .join(' · ')
  return `
    <div class="team-row${m.suspended ? ' suspended' : ''}">
      <div style="min-width: 0">
        <div class="team-name">${escHtml(teamMemberLabel(m))} ${chips}</div>
        ${subline ? `<div class="team-sub">${subline}</div>` : ''}
      </div>
      ${teamShareSelect({
        onchange: `setMemberDefaultShare('${escAttr(m.userId)}', this.value)`,
        selected: m.defaultShare,
        title: t('team.defaultShareTitle'),
        label: t('team.defaultShareLabel'),
      })}
      <div class="team-actions">${actions.join('')}</div>
    </div>`
}

function renderTeam() {
  const notice = document.getElementById('team-admins-only')
  const body = document.getElementById('team-body')
  const view = document.getElementById('team-member-view')
  if (notice) notice.style.display = 'none'
  // Both branches: the member view and the admin panel are alternatives, and a
  // member promoted to admin mid-session renders this one next.
  if (view) {
    view.style.display = 'none'
    view.innerHTML = ''
  }
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
  loadTeamInsights()
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
function showTeamToken(token, name, email) {
  lastTeamInvite = { name, email: email || '', token }
  const wrap = document.getElementById('team-token-reveal')
  if (!wrap) return
  const sub = document.getElementById('team-token-for')
  if (sub) sub.textContent = t('team.tokenFor', { name })
  const val = document.getElementById('team-token-value')
  if (val) val.textContent = token
  const copyBtn = document.getElementById('team-copy-btn')
  if (copyBtn) copyBtn.textContent = t('team.copy')
  const mailBtn = document.getElementById('team-invite-mail-btn')
  // Both branches: a member added without an email has no address to mail.
  if (mailBtn) mailBtn.style.display = lastTeamInvite.email ? '' : 'none'
  wrap.style.display = ''
  if (wrap.scrollIntoView) wrap.scrollIntoView({ block: 'nearest' })
}

function closeTeamTokenReveal() {
  const wrap = document.getElementById('team-token-reveal')
  if (wrap) wrap.style.display = 'none'
  const val = document.getElementById('team-token-value')
  if (val) val.textContent = ''
  lastTeamInvite.token = ''
}

function copyTeamToken() {
  if (!lastTeamInvite.token || !navigator.clipboard) return
  navigator.clipboard.writeText(lastTeamInvite.token)
  const btn = document.getElementById('team-copy-btn')
  if (!btn) return
  btn.textContent = t('team.copied')
  setTimeout(() => {
    btn.textContent = t('team.copy')
  }, 1500)
}

/** The covering note an admin would otherwise have to compose by hand, every time. */
function inviteMessage() {
  return t('invite.body', { name: lastTeamInvite.name, url: WORKER_URL, token: lastTeamInvite.token })
}

function copyInviteMessage() {
  if (!lastTeamInvite.token || !navigator.clipboard) return
  navigator.clipboard.writeText(inviteMessage())
  const btn = document.getElementById('team-invite-copy-btn')
  if (!btn) return
  btn.textContent = t('invite.copied')
  setTimeout(() => {
    btn.textContent = t('invite.copy')
  }, 1500)
}

/**
 * The one-time token rides in this URL's `body` parameter. A plain mailto:
 * handoff to the OS mail client is not a navigation and leaves no history
 * entry, but a user with a WEBMAIL protocol handler registered (e.g. Gmail
 * via registerProtocolHandler) gets this rewritten by the browser into a real
 * navigation — `https://mail.google.com/…?url=mailto%3A…` — which lands the
 * token in browser history and in that webmail provider's request logs.
 *
 * Kept anyway: the admin has already chosen to send a credential by email,
 * which is an insecure channel regardless — the token sits in the
 * recipient's inbox and the sender's Sent folder no matter what this
 * function does. The webmail-handler path adds history and a provider log
 * on top of a risk the admin already accepted; stripping the token from the
 * email would leave an invite nobody can act on, which defeats the feature.
 * `copyInviteMessage()` (clipboard, no URL, no navigation) is the
 * lower-exposure option and is the button placed first/primary in the row.
 */
function emailInvite() {
  if (!lastTeamInvite.token) return
  window.location.href = `mailto:${encodeURIComponent(lastTeamInvite.email)}?subject=${encodeURIComponent(t('invite.subject'))}&body=${encodeURIComponent(inviteMessage())}`
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
    showTeamToken(r.data.token, r.data.member?.name || name, email)
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
  openDangerConfirm({
    title: t('team.rotateTitle'),
    body: t('team.rotateConfirm', { name: teamMemberLabel(m) }),
    confirmLabel: t('team.rotateToken'),
    // Progress copy is this action's to own — runConfirmAction disables the
    // button for the duration, but has no idea what to say while it waits.
    onConfirm: async (_checked, done) => {
      const btn = document.getElementById('confirm-accept-btn')
      if (btn) btn.textContent = t('team.rotating')
      try {
        const r = await postTeam('/team/members/token', { id })
        if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
        showTeamToken(r.data.token, teamMemberLabel(m), m.email)
      } catch (e) {
        showToast(e.message || t('team.actionFailed'))
      }
      // `done`, not `closeConfirm()`: this POST can resolve long after the
      // user dismissed this sheet and asked something else, and by then "what
      // is on screen" belongs to another caller. `done` closes this question
      // and is inert once this question has been superseded.
      done()
    },
  })
}

/**
 * Suspending someone else's access is destructive enough to gate on the
 * sheet; restoring it is not. Restore is instantly reversible by the Suspend
 * button sitting right beside it, and a confirmation dialog in front of an
 * undoable act only trains people to dismiss dialogs without reading them.
 */
async function setTeamSuspended(id, suspended) {
  const m = teamMembers.find((x) => x.userId === id)
  if (!m) return
  if (!suspended) {
    try {
      const r = await postTeam('/team/members/suspend', { id, suspended })
      if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
      await loadTeam()
      showToast(t('team.restoredToast'))
    } catch (e) {
      showToast(e.message || t('team.actionFailed'))
    }
    return
  }
  openDangerConfirm({
    title: t('team.suspendTitle'),
    body: t('team.suspendConfirm', { name: teamMemberLabel(m) }),
    confirmLabel: t('team.suspend'),
    onConfirm: async (_checked, done) => {
      const btn = document.getElementById('confirm-accept-btn')
      if (btn) btn.textContent = t('team.suspending')
      try {
        const r = await postTeam('/team/members/suspend', { id, suspended })
        if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
        await loadTeam()
      } catch (e) {
        showToast(e.message || t('team.actionFailed'))
      }
      done()
    },
  })
}

/**
 * Hard offboarding. The server refuses self-removal and last-admin removal;
 * the sheet body carries the destructive detail — the member's PRIVATE
 * memories die with the account, shared ones stay.
 */
async function removeTeamMember(id) {
  const m = teamMembers.find((x) => x.userId === id)
  if (!m) return
  openDangerConfirm({
    title: t('team.removeTitle'),
    body: t('team.removeConfirm', { name: teamMemberLabel(m), n: Number(m.privateEntries) || 0 }),
    confirmLabel: t('team.remove'),
    onConfirm: async (_checked, done) => {
      const btn = document.getElementById('confirm-accept-btn')
      if (btn) btn.textContent = t('team.removing')
      try {
        const r = await postTeam('/team/members/remove', { id })
        if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
        await loadTeam()
      } catch (e) {
        showToast(e.message || t('team.actionFailed'))
      }
      done()
    },
  })
}

// ── Capture-visibility defaults ───────────────────────────────────────────
//
// Where a member's new captures land when neither they nor their client say:
// the org default (config TEAM_DEFAULT_WORKSPACE), unless the member has their
// own override. Both controls live here so the policy is visible in one place.

function teamDefaultShareLabel(value) {
  return value === 'company' ? t('team.shareCompany') : value === 'personal' ? t('team.sharePersonal') : t('team.shareInherit')
}

/** The three values every capture-default control offers, in display order. */
const TEAM_SHARE_VALUES = ['personal', 'company', 'inherit']

/**
 * The capture-default control itself: an admin picks it for a member's row
 * (teamMemberRow), and a member now picks it for their own (renderTeamMember).
 * "The member's control is the admin's control, byte for byte" only holds if
 * there is exactly one control to change — two copies of the same markup can
 * still drift the moment someone adds a fourth option to one and not the
 * other. This is that one place.
 *
 * `title`/`label` are already-resolved strings, not i18n keys: each caller
 * translates with its own literal key before reaching here. Threading the
 * KEY through instead and translating it in here would read as the same
 * amount of sharing, but it turns a lookup the i18n suite's call-site
 * checker can verify into an opaque forwarded variable it cannot — trading a
 * caught typo for a silently-broken translation.
 */
function teamShareSelect({ id, onchange, selected, title, label }) {
  const idAttr = id ? ` id="${escAttr(id)}"` : ''
  return `<label class="team-capture-label" title="${escAttr(title)}">
        ${escHtml(label)}
        <span class="team-select-wrap">
          <select class="team-select"${idAttr} onchange="${onchange}">
            ${TEAM_SHARE_VALUES
              .map((v) => `<option value="${v}"${(selected || 'inherit') === v ? ' selected' : ''}>${escHtml(teamDefaultShareLabel(v))}</option>`)
              .join('')}
          </select><i class="ti ti-chevron-down"></i>
        </span>
      </label>`
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
    showToast(e.message || t('team.actionFailed'))
    await loadTeam()
  }
}

/**
 * The member's own copy of setMemberDefaultShare: same endpoint shape, but
 * writing the caller's own row rather than one an admin picked — POST
 * /team/me/default-share carries no `id`.
 *
 * The failure path is lighter on purpose, not by oversight: neither function
 * mutates its in-memory copy until the response confirms success, so a bare
 * re-render is always safe here. setMemberDefaultShare still reloads the
 * whole roster on failure, matching the other admin mutations (remove,
 * suspend) that touch state shared across the team; this one only ever
 * touches the caller's own already-in-hand profile, so there is nothing a
 * reload would refresh that a re-render does not already have.
 */
async function setMyDefaultShare(value) {
  try {
    const r = await postTeam('/team/me/default-share', { default: value })
    if (!r.ok || !r.data.ok) throw new Error(r.data.error || t('team.actionFailed'))
    teamMyDefault = {
      defaultShare: r.data.defaultShare,
      orgDefault: r.data.orgDefault,
      effectiveDefault: r.data.effectiveDefault,
    }
    renderTeamMember()
    showToast(t('team.myDefaultSaved'))
    // The composer's copy of this profile was loaded on a /health reveal
    // this screen does not wait for, so without this the hint under the
    // layer dropdown keeps describing the policy the member just changed.
    if (typeof loadCaptureDefault === 'function') loadCaptureDefault()
  } catch (e) {
    showToast(e.message || t('team.actionFailed'))
    renderTeamMember()
  }
}

/**
 * Read one config key into one <select>.
 *
 * `narrow` maps whatever the server has to one of the option values, because
 * config values are free text in KV and a <select> whose value is not one of
 * its options renders blank — which reads as "unset" for a setting that is
 * very much set.
 */
async function loadTeamConfigSelect(selectId, key, narrow) {
  const sel = document.getElementById(selectId)
  if (!sel) return
  try {
    const res = await fetch(`${WORKER_URL}/config`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    sel.value = narrow(data?.config?.[key])
  } catch {
    sel.value = narrow(undefined)
  }
}

/** Write one config key, and put the control back if the server refused. */
async function setTeamConfigValue(selectId, key, value, narrow) {
  try {
    // PATCH /config is a sparse key→value patch for the whole settings blob.
    const res = await fetch(`${WORKER_URL}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ [key]: value }),
    })
    if (!res.ok) throw new Error(t('team.actionFailed'))
  } catch (e) {
    showToast(e.message || t('team.actionFailed'))
    await loadTeamConfigSelect(selectId, key, narrow)
  }
}

async function loadTeamOrgDefault() {
  await loadTeamConfigSelect('team-org-default', 'TEAM_DEFAULT_WORKSPACE', (v) => (v === 'company' ? 'company' : 'personal'))
}

async function setTeamOrgDefault(value) {
  await setTeamConfigValue('team-org-default', 'TEAM_DEFAULT_WORKSPACE', value, (v) => (v === 'company' ? 'company' : 'personal'))
}

async function loadTeamInsights() {
  await loadTeamConfigSelect('team-insights', 'TEAM_INSIGHTS', (v) => (v === 'on' ? 'on' : 'off'))
}

async function setTeamInsights(value) {
  await setTeamConfigValue('team-insights', 'TEAM_INSIGHTS', value, (v) => (v === 'on' ? 'on' : 'off'))
}
