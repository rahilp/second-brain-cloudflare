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

/**
 * What had the keyboard before the sheet took it, so closing can give it back.
 *
 * Captured only when the sheet was not already open: an opener that replaces a
 * live question would otherwise record the sheet's own Cancel button, and
 * closing would hand focus to a control that is no longer on screen.
 */
let confirmReturnFocus = null

/** Take the sheet down and hand the outgoing caller its state back. */
function dismissConfirmSheet() {
  document.getElementById('confirm-dialog').classList.remove('open')
  const onClose = pendingConfirmClose
  pendingConfirmAction = null
  pendingConfirmClose = null
  // Before the caller's onClose, not after: onClose can open another sheet,
  // and that opener has to be free to capture its own return target.
  const returnTo = confirmReturnFocus
  confirmReturnFocus = null
  if (returnTo && typeof returnTo.focus === 'function') returnTo.focus()
  if (onClose) onClose()
}

/**
 * The controls a Tab may reach while the sheet is up, in visual order.
 *
 * Named rather than discovered: the sheet's markup is fixed and owned by this
 * module, and a selector sweep would also have to reason about the checkbox
 * row being hidden and the accept button being held down mid-action, which are
 * exactly the two cases this gets right by construction.
 */
function confirmFocusables() {
  const out = []
  const row = document.getElementById('confirm-check-row')
  const box = document.getElementById('confirm-checkbox')
  if (box && row && row.style.display !== 'none') out.push(box)
  const cancel = document.getElementById('confirm-cancel-btn')
  if (cancel) out.push(cancel)
  const accept = document.getElementById('confirm-accept-btn')
  // Held down while an action is in flight, and a trap that parks focus on a
  // disabled button is worse than no trap.
  if (accept && !accept.disabled) out.push(accept)
  return out
}

/**
 * Escape and Tab, which `confirm()` used to give us.
 *
 * Escape goes through `closeConfirm` — the ambient path, the same one Cancel
 * and the backdrop take, because a user pressing Escape means exactly "close
 * what is on screen". Tab cycles inside the sheet: a modal whose focus walks
 * out into the page behind it is asking a question the user cannot see.
 *
 * Registered here rather than in `app.js` so the sheet arrives complete — the
 * markup carries `role="dialog"` and `aria-modal`, and this is the behaviour
 * those two attributes promise.
 */
function onConfirmKeydown(e) {
  const dialog = document.getElementById('confirm-dialog')
  if (!dialog || !dialog.classList.contains('open')) return
  if (e.key === 'Escape') {
    if (typeof e.preventDefault === 'function') e.preventDefault()
    closeConfirm()
    return
  }
  if (e.key !== 'Tab') return
  const focusable = confirmFocusables()
  if (focusable.length === 0) return
  const at = focusable.indexOf(document.activeElement)
  // From the sheet itself (at === -1) Tab enters at the top and Shift+Tab at
  // the bottom, which is what a wrap around an empty position means.
  const next = e.shiftKey
    ? focusable[(at <= 0 ? focusable.length : at) - 1]
    : focusable[at === focusable.length - 1 ? 0 : at + 1]
  if (typeof e.preventDefault === 'function') e.preventDefault()
  if (next && typeof next.focus === 'function') next.focus()
}

document.addEventListener('keydown', onConfirmKeydown)

/**
 * Ask before something irreversible.
 *
 * @param {object} opts
 * @param {string} opts.title          headline, already translated
 * @param {string} opts.body           the consequence, in plain words
 * @param {string} opts.confirmLabel   what the accept button says
 * @param {(checked: boolean, done: () => void, progress: (text: string) => void) => any} opts.onConfirm
 *   run on accept. `done()` closes this question and only this one, and
 *   `progress(text)` writes the accept button of this question and only this
 *   one.
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

  const dialog = document.getElementById('confirm-dialog')
  // Only on the way in from the page: replacing a live question must not
  // overwrite the target the first opener recorded.
  if (!dialog.classList.contains('open')) confirmReturnFocus = document.activeElement ?? null
  dialog.classList.add('open')
  // The sheet, not its first button: it is what carries the label and the
  // description, so focusing it is what gets the question read out.
  if (typeof dialog.focus === 'function') dialog.focus()
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
 * The action receives whether the modifier was ticked, a `done()` bound by
 * lexical scope to the question it is answering, and a `progress()` bound the
 * same way — calling either after that question has been superseded does
 * nothing, with no bookkeeping to get wrong and nothing for the caller to
 * remember to pass back.
 *
 * The sheet owns the button's DISABLED state — a second tap while the first
 * request is in flight must not issue a second POST — and each caller owns its
 * own progress WORDING, which is what `confirmForget` does with
 * `t('memories.forgetting')`. But `#confirm-accept-btn` is ONE element, so the
 * words go through `progress()`: an action long enough to report progress is
 * long enough to outlive its own question, and the bulk layer move used to
 * label a "Forget this memory?" sheet with "Moving 3 of 3…". Failures belong
 * to the action: the button comes back so the user can retry, and the error
 * propagates rather than being swallowed into silence.
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
  // The same lexical identity, for the other thing an action touches. Nothing
  // ambient decides which question this writes to; the generation it closed
  // over does, exactly as `done()` does.
  const progress = (text) => {
    if (generation !== confirmGeneration) return
    if (accept) accept.textContent = text
  }

  runningConfirmActions.add(generation)
  if (accept) accept.disabled = true
  try {
    await action(checked, done, progress)
  } catch (e) {
    if (accept && confirmGeneration === generation) accept.disabled = false
    throw e
  } finally {
    runningConfirmActions.delete(generation)
  }
}
