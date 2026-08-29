/** Lightweight toast with optional undo action. No dependency on a component library. */
let toastTimer = null

function showToast(message, opts = {}) {
  const { action, onAction, duration = 6000 } = opts
  let el = document.getElementById('app-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'app-toast'
    el.className = 'app-toast'
    el.setAttribute('role', 'status')
    document.body.appendChild(el)
  }
  if (toastTimer) clearTimeout(toastTimer)
  el.innerHTML =
    `<span class="app-toast-msg">${escHtml(message)}</span>` +
    (action
      ? `<button type="button" class="app-toast-action">${escHtml(action)}</button>`
      : '')
  el.classList.add('visible')
  const btn = el.querySelector('.app-toast-action')
  if (btn && onAction) {
    // Returned, not dropped: the action can be async and can fail, and its
    // caller — or a test — needs something to wait on. A promise is truthy, so
    // this does not suppress the click the way returning false would.
    btn.onclick = () => {
      el.classList.remove('visible')
      return onAction()
    }
  }
  toastTimer = setTimeout(() => el.classList.remove('visible'), duration)
}
