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
// Two hazards come with replacing a modal browser dialog, and both are handled
// here rather than left to each caller, because a caller can only get them
// wrong by omission and every future caller would have to remember:
//
//   1. IDENTITY. `confirm()` was one dialog per call; this is one element
//      reused. A slow action whose sheet has since been dismissed and replaced
//      would otherwise close — and reset the state of — whatever question is
//      on screen now. Every open takes a generation, and a close from a
//      superseded generation is a no-op.
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
 * Which question is on screen. Bumped on every open, so a caller can say
 * "close the sheet I opened" rather than "close whatever is open now".
 */
let confirmGeneration = 0

/**
 * The generation whose action is running right now, so an unscoped
 * `closeConfirm()` from inside an action still resolves to that action's own
 * sheet. Saved and restored around the await, which keeps it correct when a
 * second action starts while the first is still in flight.
 */
let activeConfirmGeneration = 0

/** Generations with an action in flight — one sheet cannot submit twice. */
const runningConfirmActions = new Set()

/**
 * Ask before something irreversible.
 *
 * @param {object} opts
 * @param {string} opts.title          headline, already translated
 * @param {string} opts.body           the consequence, in plain words
 * @param {string} opts.confirmLabel   what the accept button says
 * @param {(checked: boolean, token: number) => any} opts.onConfirm  run on accept
 * @param {() => void} [opts.onClose]  run on dismiss, for the caller's state
 * @param {string} [opts.checkboxLabel] shows a modifier tick when non-empty
 * @returns {number} this question's token, for `closeConfirm(token)`
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
 * Dismiss the sheet.
 *
 * Keeps this name because the backdrop listener in `app.js` and the markup's
 * Cancel button both call it, and because an action that succeeds closes the
 * sheet itself.
 *
 * @param {number} [token] the value `openDangerConfirm` returned, or the second
 *   argument handed to `onConfirm`. When it names a question that has already
 *   been replaced, this does nothing — a POST that resolves late must not
 *   dismiss, or reset the state behind, whatever is on screen now. Called
 *   without a token from inside an action, the running action's own generation
 *   is assumed; called without one from outside (Cancel, the backdrop), the
 *   user means the sheet they are looking at.
 */
function closeConfirm(token) {
  const claimed = typeof token === 'number' ? token : activeConfirmGeneration || confirmGeneration
  if (claimed !== confirmGeneration) return
  document.getElementById('confirm-dialog').classList.remove('open')
  const onClose = pendingConfirmClose
  pendingConfirmAction = null
  pendingConfirmClose = null
  if (onClose) onClose()
}

/**
 * Run the open sheet's action, telling it whether the modifier was ticked and
 * which question it is answering.
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
  runningConfirmActions.add(generation)
  if (accept) accept.disabled = true
  const outer = activeConfirmGeneration
  activeConfirmGeneration = generation
  try {
    await action(checked, generation)
  } catch (e) {
    if (accept && confirmGeneration === generation) accept.disabled = false
    throw e
  } finally {
    activeConfirmGeneration = outer
    runningConfirmActions.delete(generation)
  }
}
