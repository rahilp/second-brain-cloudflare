// ── Shared destructive-action sheet ─────────────────────────────────────────
//
// One `#confirm-dialog` element, parameterised, rather than one sheet per
// caller: two sheets diverge the first time either is restyled. Memory
// delete is the first caller of this general API (see memory-crud.js).

let pendingConfirmAction = null
let pendingConfirmClose = null

/**
 * Opens the shared sheet. `opts`:
 *   title, body, confirmLabel  — copy for the three text nodes
 *   onConfirm(checked)         — run by runConfirmAction(); owns its own
 *                                 progress/disabled state and error handling
 *   onClose                    — run once, by closeConfirm(), for state reset
 *   checkboxLabel              — optional; when present shows the checkbox row
 */
function openDangerConfirm(opts) {
  const titleEl = document.getElementById('confirm-title')
  if (titleEl) titleEl.textContent = opts.title
  const bodyEl = document.getElementById('confirm-body')
  if (bodyEl) bodyEl.textContent = opts.body
  const acceptBtn = document.getElementById('confirm-accept-btn')
  if (acceptBtn) {
    acceptBtn.textContent = opts.confirmLabel
    acceptBtn.disabled = false
  }
  pendingConfirmAction = opts.onConfirm
  pendingConfirmClose = opts.onClose ?? null
  const checkRow = document.getElementById('confirm-check-row')
  const checkLabel = document.getElementById('confirm-check-label')
  const checkbox = document.getElementById('confirm-checkbox')
  if (typeof opts.checkboxLabel === 'string' && opts.checkboxLabel) {
    if (checkLabel) checkLabel.textContent = opts.checkboxLabel
    if (checkbox) checkbox.checked = false
    if (checkRow) checkRow.style.display = ''
  } else {
    if (checkRow) checkRow.style.display = 'none'
  }
  const dialog = document.getElementById('confirm-dialog')
  if (dialog) dialog.classList.add('open')
}

function closeConfirm() {
  const dialog = document.getElementById('confirm-dialog')
  if (dialog) dialog.classList.remove('open')
  if (pendingConfirmClose) pendingConfirmClose()
  pendingConfirmAction = null
  pendingConfirmClose = null
}

async function runConfirmAction() {
  const checkbox = document.getElementById('confirm-checkbox')
  const checked = checkbox ? checkbox.checked : false
  await pendingConfirmAction?.(checked)
}
