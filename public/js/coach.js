/**
 * First-run coach marks: one small, dismissible callout rendered inline, in a
 * container that sits directly under the control it explains.
 *
 * Not an anchored popover. The dashboard's UI tests run public/ in a Node vm
 * against a hand-rolled fake DOM with no layout and no getBoundingClientRect,
 * so a positioned popover would be the only part of the team onboarding with
 * no test that could fail before and pass after — and a callout placed under
 * the control says the same sentence with no positioning code at all.
 *
 * Dismissal lives in localStorage, like every other piece of per-user UI state
 * the dashboard remembers (sb_theme, sb_memory_view, sb-locale), and is not
 * cleared on logout — which means a shared browser inherits the previous
 * person's dismissals. That is the same trade the theme already makes.
 */

const COACH_DISMISS_KEY = 'sb_coach_dismissed'

/** The dismissed ids, as a list. Empty on any storage failure — see below. */
function coachDismissedIds() {
  try {
    return String(localStorage.getItem(COACH_DISMISS_KEY) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (_) {
    // Fail OPEN. An unreadable record means the mark shows again, which costs
    // one extra dismissal; treating an unreadable record as "dismissed" would
    // silently delete onboarding for anyone whose browser refuses storage.
    return []
  }
}

function coachDismissed(id) {
  return coachDismissedIds().includes(id)
}

/**
 * Record a dismissal and take the mark off screen.
 *
 * Takes the container id as well as the mark id, and the onclick emitted by
 * renderCoachMark passes both, so the handler is a pure function of what
 * rendered it: no DOM scan for a `.coach-mark` (querySelectorAll returns []
 * in the test harness, so that dismissal could not be tested), and no hidden
 * state tying an id to wherever it was last drawn.
 */
function dismissCoachMark(id, containerId) {
  const ids = coachDismissedIds()
  if (!ids.includes(id)) ids.push(id)
  try {
    localStorage.setItem(COACH_DISMISS_KEY, ids.join(','))
  } catch (_) {
    // Safari private mode throws on setItem. The mark still goes away for
    // this session; it comes back on the next load, which is the honest
    // outcome when nothing can be written down.
  }
  const el = document.getElementById(containerId)
  if (!el) return
  el.hidden = true
  el.innerHTML = ''
}

/**
 * Draw (or hide) one coach mark.
 *
 * `copy` is `{ title, body }` of already-translated strings: the primitive
 * never builds a catalog key, so every call site passes literals and the i18n
 * call-site check stays a closed set.
 *
 * States both branches on every call, the convention maybeRevealHomeLayer and
 * maybeRevealMemoryLayerFilter already follow — a brain that stops being a
 * team drops its coach marks on the next render rather than keeping them
 * until reload. TEAM_MODE is read here rather than by each caller so every
 * future caller inherits the solo-brain guarantee instead of re-stating it.
 */
function renderCoachMark(containerId, id, copy) {
  const el = document.getElementById(containerId)
  if (!el) return
  // TEAM_MODE first, so a solo brain does not so much as read the key.
  if (!TEAM_MODE || !copy || coachDismissed(id)) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.innerHTML =
    `<div class="coach-mark-title">${escHtml(copy.title)}</div>` +
    `<p class="coach-mark-body">${escHtml(copy.body)}</p>` +
    `<button class="coach-mark-dismiss" type="button" onclick="dismissCoachMark('${escAttr(id)}', '${escAttr(containerId)}')" aria-label="${escAttr(t('coach.dismissAria'))}">${escHtml(t('coach.dismiss'))}</button>`
  el.hidden = false
}
