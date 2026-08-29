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
// Depends on nothing but the DOM; `toast.js` loads before it only so callers
// can report failure from inside their own action.

/** The action the open sheet will run, and the reset its opener asked for. */
let pendingConfirmAction = null
let pendingConfirmClose = null

/**
 * Ask before something irreversible.
 *
 * @param {object} opts
 * @param {string} opts.title          headline, already translated
 * @param {string} opts.body           the consequence, in plain words
 * @param {string} opts.confirmLabel   what the accept button says
 * @param {(checked: boolean) => any} opts.onConfirm  run on accept
 * @param {() => void} [opts.onClose]  run on dismiss, for the caller's state
 * @param {string} [opts.checkboxLabel] shows a modifier tick when non-empty
 */
function openDangerConfirm(opts) {
  document.getElementById('confirm-title').textContent = opts.title
  document.getElementById('confirm-body').textContent = opts.body
  const accept = document.getElementById('confirm-accept-btn')
  accept.textContent = opts.confirmLabel
  // A previous action disables this while it works and re-enables it in its
  // own `finally`; re-enabling here too means a caller that throws on the way
  // out cannot leave the next opener with a dead button.
  accept.disabled = false

  pendingConfirmAction = opts.onConfirm
  pendingConfirmClose = opts.onClose ?? null

  // The row is shared, so both branches are stated: an opener that says
  // nothing about a modifier must not inherit the last one's label or tick.
  const row = document.getElementById('confirm-check-row')
  const box = document.getElementById('confirm-checkbox')
  if (typeof opts.checkboxLabel === 'string' && opts.checkboxLabel !== '') {
    document.getElementById('confirm-check-label').textContent = opts.checkboxLabel
    box.checked = false
    row.style.display = ''
  } else {
    row.style.display = 'none'
    box.checked = false
  }

  document.getElementById('confirm-dialog').classList.add('open')
}

/**
 * Dismiss the sheet.
 *
 * Keeps this name because the backdrop listener in `app.js` and the markup's
 * Cancel button both call it, and because an action that succeeds closes the
 * sheet itself.
 */
function closeConfirm() {
  document.getElementById('confirm-dialog').classList.remove('open')
  if (pendingConfirmClose) pendingConfirmClose()
  pendingConfirmAction = null
  pendingConfirmClose = null
}

/**
 * Run the open sheet's action, telling it whether the modifier was ticked.
 *
 * Deliberately not in charge of the button's text or disabled state: each
 * action has its own progress wording, and each owns its own failure — an
 * error here propagates rather than being swallowed into silence.
 */
async function runConfirmAction() {
  const checked = document.getElementById('confirm-checkbox').checked === true
  await pendingConfirmAction?.(checked)
}
