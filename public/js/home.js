// One input for both halves of the product.
//
// Recall and Remember were separate tabs because they are separate verbs, but
// nobody arrives at their own brain thinking "I am now in capture mode" — they
// arrive with a sentence. The sentence itself says which verb it is, most of
// the time, and this reads that intent and shows its guess before acting on it.
//
// SHOWING the guess is the whole design. Getting it wrong silently is
// asymmetric: a question stored as a memory is junk in the brain forever, while
// a memory searched instead of stored is a strange answer and nothing lost. So
// the mode is always visible and always one tap from being overridden — a
// prediction the user can veto, never a guess acted on behind their back.

/** 'ask' | 'remember' — null until the field has enough to judge. */
let homeMode = null
/** Set once the user overrides, after which typing never changes it back. */
let homeModeLocked = false

// ── Capture layer (team edition) ──────────────────────────────────────────
// null/"" = Auto: no workspace in the request body, so the member's configured
// default decides. The dropdown only exists on team brains — /health says so
// and checkVectorize() reveals it; solo brains never see layer UI anywhere.

/** { defaultShare, orgDefault, effectiveDefault } from GET /team/me, or null
 * before it has answered (or on a solo brain, where it is never fetched). */
let captureDefault = null

function onHomeLayerChange(value) {
  homeLayer = value || null
  renderCaptureHint()
}

/** GET /team/me tells the composer what Auto will resolve to, and whose choice
 * that is — the member's own, or the org's fallback. Failure (offline, an
 * older Worker, a non-ok status) clears the hint rather than showing a stale
 * or guessed one. */
async function loadCaptureDefault() {
  try {
    const res = await fetch(`${WORKER_URL}/team/me`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    const p = data.profile || {}
    captureDefault = { defaultShare: p.defaultShare, orgDefault: p.orgDefault, effectiveDefault: p.effectiveDefault }
  } catch {
    captureDefault = null
  }
  renderCaptureHint()
}

/**
 * Writes #home-layer-hint. Exhaustive table (a defaultShare that disagrees
 * with effectiveDefault cannot occur — the server computes one from the
 * other):
 *
 *   homeLayer | effectiveDefault | defaultShare | key
 *   null      | personal         | 'personal'   | autoPersonalYours
 *   null      | personal         | ''           | autoPersonalOrg
 *   null      | company          | 'company'    | autoSharedYours
 *   null      | company          | ''           | autoSharedOrg
 *   'personal'| —                | —            | pinnedPersonal
 *   'company' | —                | —            | pinnedShared
 *
 * The four Auto rows are chosen by captureDefaultKey() in utils.js rather than
 * inline, because the Team screen's own readout (js/team.js) has to reach the
 * same answer from the same profile and there must be exactly one table.
 */
function renderCaptureHint() {
  const el = document.getElementById('home-layer-hint')
  if (!el) return
  if (!TEAM_MODE || captureDefault === null) {
    el.style.display = 'none'
    el.textContent = ''
    return
  }
  let key
  if (homeLayer === 'personal') key = 'home.pinnedPersonal'
  else if (homeLayer === 'company') key = 'home.pinnedShared'
  else key = captureDefaultKey(captureDefault)
  el.style.display = ''
  el.textContent = t(key)
}

/** /health reports whether more than one member exists; solo brains never see layer UI. */
async function maybeRevealHomeLayer(health) {
  TEAM_MODE = !!(health && health.team)
  // Every layer control states both branches: the flag is the single source of
  // truth, so a re-probe can always correct a stale reveal.
  const wrap = document.getElementById('home-layer-wrap')
  if (wrap) wrap.style.display = TEAM_MODE ? '' : 'none'
  // Both branches: a brain that stops being a team drops the hint rather than
  // leaving it to describe a policy that no longer applies to anyone.
  if (TEAM_MODE) await loadCaptureDefault()
  else renderCaptureHint()
}

/** Leading words that make a sentence a question even without a question mark. */
const ASK_OPENERS_EN =
  /^(who|what|when|where|why|how|which|whose|did|do|does|is|are|was|were|can|could|should|would|will|have|has|had|am|tell me|show me|find|search|remind me what|list)\b/i
/** Italian interrogatives only — statement starters like ho/sono/devo are excluded. */
const ASK_OPENERS_IT =
  /^(chi|cosa|quando|dove|perché|perche|come|quale|quali|di chi|può|puoi|posso|possono|dovrei|vorrei|dimmi|mostrami|trova|cerca|elenca)\b/i

function askOpenersForLocale() {
  return getLocale() === 'it' ? ASK_OPENERS_IT : ASK_OPENERS_EN
}

/**
 * Read the sentence, not the user's mind.
 *
 * Ordered by how strong the signal is. A trailing question mark is the closest
 * thing to certainty; an interrogative opener is nearly as good. Everything
 * else is a memory, because that is the safer default on a tie: an unwanted
 * search costs a moment, an unwanted memory costs a cleanup.
 */
function detectHomeMode(text) {
  const s = String(text || '').trim()
  if (!s) return null
  if (s.endsWith('?')) return 'ask'
  if (askOpenersForLocale().test(s)) return 'ask'
  // "remember that…" / "note:" are explicit the other way.
  if (/^(remind me to|ricordami di|remember|note|todo|log|ricorda|nota|promemoria|registra)\b/i.test(s))
    return 'remember'
  return 'remember'
}

function applyHomeMode(mode) {
  homeMode = mode
  const btn = document.getElementById('home-mode')
  const label = document.getElementById('home-mode-label')
  if (!btn || !label) return
  const asking = mode === 'ask'
  label.textContent = asking ? t('home.willSearch') : t('home.willRemember')
  btn.classList.toggle('home-mode--remember', !asking)
  btn.style.visibility = mode ? 'visible' : 'hidden'
}

function onHomeInput(el) {
  autoResize(el)
  if (homeModeLocked) return
  applyHomeMode(detectHomeMode(el.value))
}

/** The override. Locks the mode so the next keystroke does not undo the choice. */
function toggleHomeMode() {
  homeModeLocked = true
  applyHomeMode(homeMode === 'ask' ? 'remember' : 'ask')
}

/**
 * Set the mode from elsewhere and hold it — for callers that already know which
 * verb the user is here for, so an empty field does not read as "will remember"
 * only to flip on the first typed word.
 */
function lockHomeMode(mode) {
  homeModeLocked = true
  applyHomeMode(mode)
}

function handleHomeKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitHome()
  }
}

/**
 * Hand the sentence to whichever half of the app owns it.
 *
 * Asking leaves home behind and becomes the conversation; remembering keeps
 * you here, because capture is a thing you do repeatedly and being thrown into
 * another view each time would be hostile.
 */
async function submitHome() {
  const field = document.getElementById('home-field')
  const text = field.value.trim()
  if (!text) return
  const mode = homeMode || detectHomeMode(text) || 'remember'

  if (mode === 'ask') {
    field.value = ''
    autoResize(field)
    leaveHome()
    const input = document.getElementById('recall-input')
    input.value = text
    sendRecall()
    return
  }

  // Capture in place, with the receipt that was the deleted Remember tab's one
  // good idea (captureReceipt, still in remember.js).
  field.disabled = true
  const receipts = document.getElementById('home-more')
  try {
    const tags = []
    const tagRe = /#([a-zA-Z][\w-]*)/g
    let m
    while ((m = tagRe.exec(text)) !== null) tags.push(m[1])
    const content = text.replace(/#[a-zA-Z][\w-]*/g, '').trim() || text

    const result = await apiCapture(content, tags, 'web-ui', homeLayer)
    field.value = ''
    autoResize(field)
    if (result.duplicate) {
      receipts.innerHTML = `<div class="receipt"><div class="receipt-headline"><span class="receipt-dot"></span>${escHtml(t('home.receiptAlreadyKept'))}</div><div class="receipt-note">${escHtml(t('home.receiptAlreadyKeptNote'))}</div></div>`
    } else {
      receipts.innerHTML = ''
      receipts.appendChild(captureReceipt(result, tags))
    }
    // Outside the try: a refresh hiccup must never rewrite a successful
    // capture's receipt as "could not save" — that lie cost a user trust once.
    Promise.resolve(refreshAll()).catch((e) => console.error('refresh after capture failed:', e))
  } catch {
    receipts.innerHTML = `<div class="receipt"><div class="receipt-headline"><span class="receipt-dot"></span>${escHtml(t('home.receiptCouldNotSave'))}</div><div class="receipt-note">${escHtml(t('home.receiptCouldNotSaveNote'))}</div></div>`
  } finally {
    field.disabled = false
    field.focus()
  }
}

/** Home gives way to the conversation, and the brief goes with it. */
function leaveHome() {
  // Without dropping this class the old input bar stays hidden and the
  // conversation has nothing to type into.
  const screen = document.getElementById('screen-home')
  if (screen) screen.classList.remove('home-visible')
  const home = document.getElementById('home')
  if (home) home.style.display = 'none'
  const brief = document.getElementById('brief')
  if (brief) brief.style.display = 'none'
}

/**
 * And back again. A conversation is a state home enters, not a place the user
 * travels to, so it needs an exit — before this, asking one question replaced
 * home for the rest of the session and the only way back was pressing the tab
 * you were already on.
 */
function returnHome() {
  const screen = document.getElementById('screen-home')
  if (screen) screen.classList.add('home-visible')
  const home = document.getElementById('home')
  if (home) home.style.display = ''

  // A fresh start, so the field makes no claim about a sentence nobody has
  // written yet — coming back from a question otherwise left "will search"
  // sitting under an empty box, and any earlier override still in force.
  homeModeLocked = false
  applyHomeMode(null)
  // Re-rendered rather than merely re-shown: the brief may have gone stale
  // while the conversation was on top of it.
  if (typeof briefData !== 'undefined' && briefData) {
    renderHome(briefData)
    renderBrief(briefData)
  }
}

/**
 * The greeting. Time of day is reliable and never wrong about you, which is
 * what a greeting has to be — a brain-derived line ("you have been on signpath
 * all week") is more charming and occasionally says something false about how
 * someone spent their week.
 */
function greetingFor(date) {
  const h = date.getHours()
  if (h < 5) return t('home.greetingStillUp')
  if (h < 12) return t('home.greetingMorning')
  if (h < 17) return t('home.greetingAfternoon')
  if (h < 22) return t('home.greetingEvening')
  return t('home.greetingLate')
}

/** Fills the greeting and the one number worth putting above the input. */
function renderHome(data) {
  const screen = document.getElementById('screen-home')
  if (screen) screen.classList.add('home-visible')
  const greet = document.getElementById('home-greeting')
  if (greet) greet.textContent = greetingFor(new Date())

  const sub = document.getElementById('home-sub')
  if (sub && data) {
    const bits = []
    if (data.total)
      bits.push(tPlural('home.subMemory', data.total, { n: formatNumberUI(data.total) }))
    // Summed from the activity strip rather than reusing `captured`, which is a
    // 48-hour count and would have been labelled "this week" incorrectly.
    const week = (data.activity || []).slice(-7).reduce((n, d) => n + (d.count || 0), 0)
    if (week) bits.push(t('home.subThisWeek', { n: formatNumberUI(week) }))
    sub.textContent = bits.join(' · ')
  }

  const topics = document.getElementById('home-topics')
  if (topics && data && (data.topics || []).length) {
    // What you could ask, drawn from what you have actually been writing about.
    topics.innerHTML = data.topics
      .filter((t) => !isSystemTag(t.tag))
      .slice(0, 4)
      .map(
        (t) =>
          `<button class="topic-chip" onclick="askAbout('${escAttr(t.tag)}')">${escHtml(t.tag)}<span>${t.count}</span></button>`,
      )
      .join('')
  }
}

function askAbout(tag) {
  leaveHome()
  const input = document.getElementById('recall-input')
  input.value = t('home.askAbout', { tag })
  sendRecall()
}
