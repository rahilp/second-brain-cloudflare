// The admin activity feed — who changed what on this team, newest first.
//
// A separate module rather than a section of team.js: team.js is already the
// roster, the token reveal, the team name and the org capture default, and a
// feed with its own paging, its own failure state and its own vocabulary is a
// module by any reading of the layer table in docs/dashboard-architecture.md.
//
// Admin-only. The whole section lives inside #team-body, which only renders
// once GET /team/members has answered 200, and GET /team/activity is behind
// requireAdmin on the Worker. The reveal ALSO stands down when team.js's probe
// has said this member is not an admin, so a member does not pay for a request
// that can only be a 403.
//
// Nothing here is editable. That is the point of a record: the screen shows
// what the trail says and offers no way to make it say something else.

/** Rows per page. The Worker caps `limit`; this is the request, not the cap. */
const ACTIVITY_PAGE = 50

/** Everything loaded so far, in the order the server sent it. Never re-sorted
 *  here — the server decides what "newest first" means, and two orderings of
 *  the same audit trail is one ordering too many. */
let activityRows = []

/**
 * The one place that decides whether a GET /team/activity body is usable.
 *
 * Shared by the view and the export ON PURPOSE. When those two disagreed, a
 * 200 whose body was the wrong shape stated a failure on screen and quietly
 * DOWNLOADED a header-only CSV — and an empty audit log is not an empty
 * result, it is a claim that nothing happened. One check means the two paths
 * cannot drift into disagreeing about the same response again.
 */
function activityEventsFrom(data) {
  if (!data || !Array.isArray(data.events)) throw new Error('failed')
  return data.events
}

/**
 * A row's timestamp as ISO 8601, or an empty cell if it does not have one.
 *
 * `at` is epoch milliseconds on the wire and an ISO string is also accepted,
 * but the case that matters is neither: a row with a missing or unparseable
 * `at` used to throw out of toISOString() and cost the admin the WHOLE file.
 * One unusable row is not a reason to refuse the other nine hundred.
 *
 * Empty, not a marker word and never a guess. `new Date(null)` is epoch 0, so
 * a bare `new Date()` would have this column assert, in a compliance record,
 * that the thing happened in 1970 — inventing a date is the one answer that is
 * never acceptable here. A literal like "unknown" would give an ISO-8601
 * column a second grammar for a parser to trip over; an empty cell is what
 * every other column in this document already uses for an absent value.
 */
function activityIsoAt(at) {
  if (at === null || at === undefined || at === '') return ''
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/**
 * Fetch a page of the trail.
 *
 * `append` is the whole difference between the two callers: a cold load
 * replaces and may state a failure, an append extends and must not — losing
 * fifty rows on screen because the fifty-first page timed out is a worse
 * outcome than the missing page.
 */
async function loadTeamActivity({ append = false } = {}) {
  if (!WORKER_URL || !AUTH_TOKEN) return
  const list = document.getElementById('activity-list')
  try {
    const res = await fetch(
      `${WORKER_URL}/team/activity?limit=${ACTIVITY_PAGE}&offset=${append ? activityRows.length : 0}`,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    )
    if (!res.ok) throw new Error(String(res.status))
    const events = activityEventsFrom(await res.json())
    activityRows = append ? [...activityRows, ...events] : events
    renderActivity()
  } catch {
    if (append) {
      // The rows stay. The button goes back to being a button, because a
      // Show-more left disabled says there is more and refuses to fetch it.
      const btn = document.getElementById('activity-more')
      if (btn) {
        btn.disabled = false
        btn.textContent = t('activity.more')
      }
    } else if (list) {
      list.innerHTML = `<p class="digest-note"><i class="ti ti-wifi-off"></i> ${escHtml(t('activity.loadFailed'))}</p>`
    }
  }
}

/** Same shape loadMorePatterns already uses: disable, say so, then fetch. */
function loadMoreActivity(btn) {
  btn.disabled = true
  btn.textContent = t('activity.loading')
  loadTeamActivity({ append: true })
}

/**
 * The audit event name → the sentence a person reads.
 *
 * A literal map, deliberately the same shape as timelineEventLabel() in
 * memory-crud.js: it is the one dynamic i18n call site this work is allowed,
 * and keeping it to a single known form is what lets test/ui/i18n.test.ts hold
 * the set of dynamic sites closed. An event name with no entry falls through
 * to itself rather than to a blank line. That fallback is permanent, not
 * transitional: the endpoint's admin arm has no event filter, so any name
 * added to AdminEventName reaches this map with no route change at all.
 * test/ui/team-activity.test.ts pins the map against that union so the
 * divergence is a red test rather than an unlabelled row in a browser.
 */
function activityEventLabel(event) {
  const keys = {
    member_created: 'activity.evMemberCreated',
    member_removed: 'activity.evMemberRemoved',
    member_suspended: 'activity.evMemberSuspended',
    member_unsuspended: 'activity.evMemberUnsuspended',
    member_token_rotated: 'activity.evMemberTokenRotated',
    member_default_share_set: 'activity.evMemberDefaultShareSet',
    member_profile_updated: 'activity.evMemberProfileUpdated',
    team_renamed: 'activity.evTeamRenamed',
    integration_connected: 'activity.evIntegrationConnected',
    integration_disconnected: 'activity.evIntegrationDisconnected',
    shared: 'activity.evShared',
    unshared: 'activity.evUnshared',
    insight_confirmed: 'activity.evInsightConfirmed',
    insight_dismissed: 'activity.evInsightDismissed',
  }
  return keys[event] ? t(keys[event]) : event || ''
}

/**
 * One line of the record: who, what, to whom, about which memory.
 *
 * An actor the trail has outlived is named "Removed account" rather than left
 * blank — a blank subject reads as a bug, and "someone removed Bob" with the
 * someone missing is the half of the sentence that matters. A memory whose
 * row is gone gets the same treatment for the same reason.
 */
function activityRow(row) {
  return (
    `<div class="activity-row">` +
    `<div class="activity-line">${[
      escHtml(row.actor || t('activity.unknownActor')),
      escHtml(activityEventLabel(row.event)),
      row.subject ? escHtml(row.subject) : '',
      row.kind === 'entry' ? escHtml(row.title ? `“${row.title}”` : t('activity.memoryGone')) : '',
    ]
      .filter(Boolean)
      .join(' · ')}</div>` +
    `<div class="activity-when">${escHtml(new Date(row.at).toLocaleString(localeTag()))}</div>` +
    `</div>`
  )
}

/**
 * Paint the rows and re-state the button.
 *
 * The button's three properties are set on BOTH branches. `hidden` follows the
 * last page's size — a page that came back short is the last page — and
 * `disabled`/`textContent` are reset unconditionally, so the control cannot be
 * left mid-fetch by a render that happened to arrive from somewhere else.
 */
function renderActivity() {
  const list = document.getElementById('activity-list')
  if (list) {
    list.innerHTML = activityRows.length
      ? activityRows.map(activityRow).join('')
      : `<p class="digest-note">${escHtml(t('activity.empty'))}</p>`
  }
  const btn = document.getElementById('activity-more')
  if (btn) {
    btn.hidden = activityRows.length % ACTIVITY_PAGE !== 0 || activityRows.length === 0
    btn.disabled = false
    btn.textContent = t('activity.more')
  }
}

/**
 * Whether the roster probe has positively said this member is NOT an admin.
 *
 * GET /team/activity is behind requireAdmin, so for a member it can only ever
 * be a 403 — one per Team-tab visit, whose failure line lands in a panel they
 * cannot see. team.js's probe has already answered the question by the time
 * switchTab gets here, so the request is simply not made.
 *
 * Only a positive NO stands the feed down. `teamIsAdmin` is null until the
 * probe answers and absent entirely where team.js is not loaded, and both of
 * those must behave exactly as before: showing an admin an empty feed because
 * a signal was missing is a far worse failure than one avoidable 403.
 */
function activityAdminRefused() {
  return typeof teamIsAdmin !== 'undefined' && teamIsAdmin === false
}

/**
 * Show or hide the section, and load it the first time it is looked at.
 *
 * Called from switchTab, which is already the one place that decides the Team
 * screen is being looked at. BOTH branches are written: a brain whose second
 * member was just removed can be a team one render and a solo one the next,
 * and a reveal that only ever reveals leaves the feed on screen for a brain
 * that no longer has a team.
 */
function maybeRevealActivity() {
  const el = document.getElementById('team-activity')
  if (!el) return
  if (!TEAM_MODE || activityAdminRefused()) {
    el.style.display = 'none'
    return
  }
  el.style.display = ''
  if (activityRows.length === 0) return loadTeamActivity()
}

/** Rows one export will read. Ten pages; a trail longer than this is a
 *  database export, not a button. */
const ACTIVITY_EXPORT_MAX = 1000

/**
 * The trail as a CSV.
 *
 * Built in the browser, because there is no build step and the tree ships to
 * Workers: a server-side /team/activity.csv would be a second response format,
 * a second content-type path and a second projection of the same rows that can
 * drift from the JSON one — and it would have to page an unbounded trail
 * inside one Worker invocation. The DATA is deliberately not client-side: this
 * re-reads the same endpoint the view reads, so there is exactly one
 * implementation of what an activity row is.
 *
 * The seven column names are English literals in both locales, and `when` is
 * ISO 8601 while the screen shows a locale-formatted date. A CSV is read by a
 * compliance tool and by a spreadsheet formula someone wrote last quarter; a
 * header row that changes with the operator's browser language is a file
 * format that changes with the operator's browser language.
 */
async function exportActivityCsv(btn) {
  if (btn) {
    btn.disabled = true
    btn.textContent = t('activity.loading')
  }
  try {
    // The same endpoint the view reads, page by page. Not a second query and
    // not the rows already on screen: "export what I can see" is a different
    // document depending on how many times someone pressed Show more.
    const all = []
    while (all.length < ACTIVITY_EXPORT_MAX) {
      const res = await fetch(
        `${WORKER_URL}/team/activity?limit=${ACTIVITY_PAGE}&offset=${all.length}`,
        { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
      )
      if (!res.ok) throw new Error(String(res.status))
      // The same check the view runs: a 200 whose body is not a feed is a
      // failure to state, not an empty file to hand someone.
      const page = activityEventsFrom(await res.json())
      all.push(...page)
      if (page.length < ACTIVITY_PAGE) break
    }
    const ts = new Date().toISOString().slice(0, 10)
    downloadTextFile(
      document,
      csvDocument(
        ['when', 'event', 'actor', 'subject', 'memory_id', 'memory', 'detail'],
        all.map((r) => [
          activityIsoAt(r.at),
          r.event,
          r.actor ?? '',
          r.subject ?? '',
          r.entryId ?? '',
          r.title ?? '',
          JSON.stringify(r.detail ?? {}),
        ]),
      ),
      `second-brain-activity-${ts}.csv`,
      'text/csv;charset=utf-8',
    )
  } catch {
    showToast(t('activity.exportFailed'))
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = t('activity.exportCsv')
    }
  }
}
