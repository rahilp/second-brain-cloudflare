async function connect() {
  const url = document.getElementById('auth-url').value.trim().replace(/\/$/, '')
  const tok = document.getElementById('auth-token').value.trim()
  const err = document.getElementById('auth-error')
  const btn = document.getElementById('auth-connect')
  if (!url || !tok) {
    err.textContent = t('auth.fillBoth')
    return
  }
  btn.textContent = t('auth.connecting')
  btn.disabled = true
  err.textContent = ''
  try {
    const res = await fetch(`${url}/list?n=1`, { headers: { Authorization: `Bearer ${tok}` } })
    if (res.status === 401) {
      // The Worker says WHY (src/lib/identity.ts): a suspended or removed member
      // holds a token that is not wrong, so "Invalid token" sent them off to
      // re-copy a token that was never the problem. Only a token that hashes to
      // a real member can produce anything but invalid_token, so this cannot
      // report an account state to someone who guessed. An older Worker sends no
      // code at all, which falls through to the message it always sent.
      const body = await res.json().catch(() => ({}))
      throw new Error(
        t(
          `auth.${body.code === 'suspended' ? 'accountSuspended' : body.code === 'removed' ? 'accountRemoved' : 'invalidToken'}`,
        ),
      )
    }
    if (!res.ok) throw new Error(t('auth.serverError', { status: res.status }))
    localStorage.setItem('sb_url', url)
    localStorage.setItem('sb_token', tok)
    WORKER_URL = url
    AUTH_TOKEN = tok
    showApp()
  } catch (e) {
    err.textContent = e.message || t('auth.couldNotConnect')
    btn.textContent = t('auth.connect')
    btn.disabled = false
  }
}

function showApp() {
  document.getElementById('auth-overlay').style.display = 'none'
  document.getElementById('app').style.display = 'flex'
  if (typeof renderHome === 'function') renderHome(null) // greeting before the network
  refreshAll()
  checkVectorize()
  // Doubles as the admin check: the Team nav entries stay hidden unless this
  // probe answers 200. See js/team.js.
  if (typeof loadTeam === 'function') loadTeam()
}

function logout() {
  closeMenu()
  localStorage.removeItem('sb_url')
  localStorage.removeItem('sb_token')
  WORKER_URL = ''
  AUTH_TOKEN = ''
  document.getElementById('app').style.display = 'none'
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('auth-url').value = ''
  document.getElementById('auth-token').value = ''
  document.getElementById('auth-error').textContent = ''
}
