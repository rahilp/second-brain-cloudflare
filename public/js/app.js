function init() {
  // First, so no authenticated request can outrun it: a token revoked while the
  // window sat open has to end the session rather than be swallowed. See
  // installAuthWatch in js/auth.js.
  installAuthWatch()
  initI18n()
  applyI18nDom()
  applyTheme()
  applyLocale()
  // Before anything renders, so the Memories screen is already showing the
  // projection this user last chose rather than snapping to it after paint.
  initMemoryView()
  if (typeof renderAboutCredits === 'function') renderAboutCredits()
  if (typeof renderDownloadButton === 'function') renderDownloadButton()
  // Auto-populate URL from the current page origin (UI is hosted on the same Worker)
  const origin = window.location.origin
  document.getElementById('auth-url').value = origin

  const url = localStorage.getItem('sb_url') || origin
  const tok = localStorage.getItem('sb_token')
  if (tok) {
    WORKER_URL = url
    AUTH_TOKEN = tok
    showApp()
  }
}

document.getElementById('confirm-dialog').addEventListener('click', (e) => {
  if (e.target === document.getElementById('confirm-dialog')) closeConfirm()
})
document.getElementById('append-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('append-sheet')) closeAppend()
})
document.getElementById('menu-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('menu-sheet')) closeMenu()
})
document.getElementById('integrations-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('integrations-sheet')) closeIntegrations()
})
document.getElementById('view-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('view-sheet')) closeView()
})
document.getElementById('edit-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('edit-sheet')) closeEdit()
})
document.getElementById('patterns-sheet').addEventListener('click', (e) => {
  if (e.target === document.getElementById('patterns-sheet')) closePatternsSheet()
})

init()
