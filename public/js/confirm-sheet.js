// ── The destructive-action sheet ──────────────────────────────────────────
//
// One `#confirm-dialog` in the page, parameterised by its caller. Memory
// delete used to own it privately; every other irreversible action asked with
// `confirm()`, which the browser styles, cannot translate beyond its own UI
// language, and cannot say "and also throw the data away" without asking a
// second question. A second sheet would have solved that and then diverged
// from this one the first time either was restyled, so there is exactly one,
// and memory delete is now just its first caller.
//
// Two hazards come with replacing a modal browser dialog with one reused
// element, and both are handled here rather than left to each caller:
//
//   1. IDENTITY. `confirm()` was one dialog per call. Here a slow action whose
//      sheet has since been dismissed and replaced would otherwise close — and
//      reset the state behind — whatever question is on screen now. So an
//      action is not given a way to say "close the sheet"; it is given a
//      handle that can only close ITS OWN question, and does nothing once that
//      question has been superseded. The identity comes out of lexical scope,
//      which is the only thing that survives two actions being in flight at
//      once. Anything the module remembered about "which action is running"
//      would be ambient state, and two overlapping actions corrupt it.
//   2. DOUBLE SUBMIT. `confirm()` blocked the page, so it could not be
//      answered twice. An accept button can be tapped twice, and two POSTs go
//      out. `runConfirmAction` holds the button down for the duration.
//
// Depends on nothing but the DOM; `toast.js` loads before it only so callers
// can report failure from inside their own action.

/** The action the open sheet will run, and the reset its opener asked for. */
let pendingConfirmAction = null
let pendingConfirmClose = null

/**
 * Which question is on screen. Monotonic, and read only to compare — never
 * saved and restored, which is what makes it safe under interleaving.
 */
let confirmGeneration = 0

/** Generations with an action in flight — one sheet cannot submit twice. */
const runningConfirmActions = new Set()

/** Take the sheet down and hand the outgoing caller its state back. */
function dismissConfirmSheet() {
  document.getElementById('confirm-dialog').classList.remove('open')
  const onClose = pendingConfirmClose
  pendingConfirmAction = null
  pendingConfirmClose = null
  if (onClose) onClose()
}

/**
 * Ask before something irreversible.
 *
 * @param {object} opts
 * @param {string} opts.title          headline, already translated
 * @param {string} opts.body           the consequence, in plain words
 * @param {string} opts.confirmLabel   what the accept button says
 * @param {(checked: boolean, done: () => void) => any} opts.onConfirm  run on
 *   accept. `done()` closes this question and only this one.
 * @param {() => void} [opts.onClose]  run on dismiss, for the caller's state
 * @param {string} [opts.checkboxLabel] shows a modifier tick when non-empty
 * @returns {number} this question's generation — for tests and logging; the
 *   handle passed to `onConfirm` is what callers close with.
 */
function openDangerConfirm(opts) {
  // A sheet being replaced never got its dismissal, and its caller is still
  // holding the state that dismissal was going to clear.
  if (pendingConfirmClose) {
    const superseded = pendingConfirmClose
    pendingConfirmClose = null
    superseded()
  }
  confirmGeneration += 1
  const generation = confirmGeneration

  document.getElementById('confirm-title').textContent = opts.title
  document.getElementById('confirm-body').textContent = opts.body
  const accept = document.getElementById('confirm-accept-btn')
  if (accept) {
    accept.textContent = opts.confirmLabel
    // The previous action held this down while it worked. Releasing it here
    // means a caller that threw on the way out cannot leave the next opener
    // with a dead button.
    accept.disabled = false
  }

  pendingConfirmAction = opts.onConfirm
  pendingConfirmClose = opts.onClose ?? null

  // The row is shared, so both branches are stated: an opener that says
  // nothing about a modifier must not inherit the last one's label or tick.
  const row = document.getElementById('confirm-check-row')
  const box = document.getElementById('confirm-checkbox')
  if (typeof opts.checkboxLabel === 'string' && opts.checkboxLabel !== '') {
    document.getElementById('confirm-check-label').textContent = opts.checkboxLabel
    if (box) box.checked = false
    if (row) row.style.display = ''
  } else {
    if (row) row.style.display = 'none'
    if (box) box.checked = false
  }

  document.getElementById('confirm-dialog').classList.add('open')
  return generation
}

/**
 * Dismiss whatever question is on screen.
 *
 * This is the AMBIENT dismissal: for callers that genuinely mean "close what I
 * am looking at". The user dismissing the sheet is the usual one — the Cancel
 * button in the markup and the backdrop listener in `app.js` — and
 * `confirmForget`'s `done || closeConfirm` fallback is the other, reached only
 * when something calls it directly rather than through the sheet.
 *
 * It is deliberately not what an action uses. An action can resolve long after
 * its own sheet was replaced, and by then "what is on screen" is someone
 * else's question. Actions close with the handle `runConfirmAction` gives
 * them, which is inert once that question has gone.
 */
function closeConfirm() {
  dismissConfirmSheet()
}

/**
 * Run the open sheet's action.
 *
 * The action receives whether the modifier was ticked, and a `done()` bound by
 * lexical scope to the question it is answering — calling it after that
 * question has been superseded does nothing, with no bookkeeping to get wrong
 * and nothing for the caller to remember to pass back.
 *
 * The sheet owns the button's DISABLED state — a second tap while the first
 * request is in flight must not issue a second POST — and each caller owns its
 * own progress WORDING, which is what `confirmForget` does with
 * `t('memories.forgetting')`. Failures belong to the action: the button comes
 * back so the user can retry, and the error propagates rather than being
 * swallowed into silence.
 */
async function runConfirmAction() {
  const generation = confirmGeneration
  if (runningConfirmActions.has(generation)) return
  const action = pendingConfirmAction
  if (!action) return

  const checked = document.getElementById('confirm-checkbox')?.checked === true
  const accept = document.getElementById('confirm-accept-btn')
  const done = () => {
    if (generation === confirmGeneration) dismissConfirmSheet()
  }

  runningConfirmActions.add(generation)
  if (accept) accept.disabled = true
  try {
    await action(checked, done)
  } catch (e) {
    if (accept && confirmGeneration === generation) accept.disabled = false
    throw e
  } finally {
    runningConfirmActions.delete(generation)
  }
}
