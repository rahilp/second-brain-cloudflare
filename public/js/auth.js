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

/**
 * The session ended underneath us: an admin suspended or removed this member,
 * or rotated their token, while the window sat open. Phase 1 made the Worker
 * say WHY on every guarded route; connect() was the only thing reading it, so
 * a revocation mid-session showed up as four silently swallowed failures and a
 * screen full of numbers from before it happened.
 *
 * Self-disarming in two layers, both load-bearing. The watcher below is guarded
 * on AUTH_TOKEN, which covers a SEQUENTIAL burst; but refreshAll() fires four
 * requests at once, and all four get past that guard before any of them has
 * cleared it — so the guard on the first line here is what makes four
 * concurrent 401s produce one overlay. sb_url survives so the address stays
 * prefilled; only the token is dropped.
 *
 * Every element is guarded the same way. A missing one would throw part-way
 * through, INSIDE the interceptor's catch, which would swallow the sign-out and
 * leave a dead token on a screen with no message — the exact failure this whole
 * function exists to end.
 */
function sessionEnded(code) {
  if (!AUTH_TOKEN) return
  const url = WORKER_URL
  try { localStorage.removeItem('sb_token') } catch {}
  AUTH_TOKEN = ''
  const appEl = document.getElementById('app')
  if (appEl) appEl.style.display = 'none'
  const overlayEl = document.getElementById('auth-overlay')
  if (overlayEl) overlayEl.style.display = 'flex'
  const urlEl = document.getElementById('auth-url')
  if (urlEl) urlEl.value = url
  const tokEl = document.getElementById('auth-token')
  if (tokEl) tokEl.value = ''
  const errEl = document.getElementById('auth-error')
  if (errEl) {
    errEl.textContent = t(
      `auth.${code === 'suspended' ? 'accountSuspended' : code === 'removed' ? 'accountRemoved' : 'sessionExpired'}`,
    )
  }
}

/**
 * One interceptor rather than 45 call sites. Every authenticated request in
 * the dashboard goes through the global fetch, and nothing else does; the
 * response is returned untouched, and — see the detached read below — at the
 * same moment native fetch would have returned it, so no caller's behaviour
 * and no caller's TIMING changes.
 */
function installAuthWatch(scope) {
  const target = scope || (typeof globalThis !== 'undefined' ? globalThis : null)
  if (!target || typeof target.fetch !== 'function' || target.__sbAuthWatch) return
  const native = target.fetch
  target.__sbAuthWatch = true
  target.fetch = async (input, opts) => {
    const res = await native(input, opts)
    if (res.status !== 401 || !AUTH_TOKEN || !WORKER_URL) return res
    // fetch()'s first argument is a string, a Request, or a URL, and all three
    // spell the address differently. Reading only `.url` handled the first two
    // and silently produced `''` for a URL — which fails the same-Worker check
    // below, so a genuine revocation was ignored with nothing logged anywhere.
    // No call site passes a URL today; `fetch(new URL(path, WORKER_URL))` is
    // the idiomatic way to build one, so the next one will.
    const reqUrl =
      typeof input === 'string'
        ? input
        : typeof (input && input.url) === 'string'
          ? input.url // Request
          : typeof (input && input.href) === 'string'
            ? input.href // URL
            : ''
    // The boundary is the path separator, not a bare prefix: `startsWith` alone
    // would treat `https://brain.example.com.attacker.test/x` as this Worker and
    // let a lookalike host end a valid session. connect() strips the trailing
    // slash from what it stores and all 45 call sites build `${WORKER_URL}/…`,
    // so this excludes nothing the dashboard actually asks for.
    if (reqUrl !== WORKER_URL && !reqUrl.startsWith(WORKER_URL + '/')) return res
    // DETACHED, not awaited. `await res.clone().json()` would hold the caller
    // until the body finished streaming, while native fetch resolves at the
    // HEADERS — so a 401 whose body is slow (or never lands) would stall every
    // one of the 45 call sites behind a wrapper that is supposed to be
    // invisible. Reading it on its own chain restores native timing and only
    // moves the sign-out later, never away: sessionEnded still runs the moment
    // the body arrives. The `.catch` is load-bearing now that nothing awaits
    // this — a truncated or non-JSON body would otherwise become an unhandled
    // rejection with no owner.
    //
    // clone() itself is inside this try. Native fetch would have handed the
    // caller `res` untouched; a clone() that throws synchronously (a body
    // already read, a Response-like object that does not implement it) must
    // not turn that into a rejection the pre-wrapper code would never have
    // produced. The reason is simply unreachable then, same as a 401 from a
    // Worker too old to send a code — the session stands.
    try {
      res
        .clone()
        .json()
        .then((body) => {
          if (body && body.code) sessionEnded(body.code)
        })
        .catch(() => {})
    } catch {}
    return res
  }
}

/**
 * The sign-in overlay renders before any authenticated request, so TEAM_MODE
 * (set from GET /health, which requires a valid token) is not knowable here.
 * Probing team-mode unauthenticated would tell any visitor whether this
 * deployment has members — deployment shape leaking to the public internet.
 * So this ships unconditionally, as a single collapsed text link that issues
 * no request and causes no layout shift until pressed.
 */
function toggleInviteHelp() {
  const help = document.getElementById('auth-invite-help')
  const btn = document.getElementById('auth-invite-toggle')
  if (!help || !btn) return
  const opening = help.style.display === 'none'
  help.style.display = opening ? '' : 'none'
  btn.setAttribute('aria-expanded', String(opening))
  btn.textContent = opening ? t('auth.inviteHide') : t('auth.haveInvite')
  if (!opening) return
  // An invited member is, by construction, already looking at the Worker that
  // invited them — the URL is the one thing they do not have to be told, and
  // the token is the only thing they hold. Guarded on emptiness so this never
  // overwrites a URL someone typed; init() already prefills it anyway, so this
  // is a belt-and-braces path for a page loaded from a bookmark.
  const url = document.getElementById('auth-url')
  if (url && !url.value) url.value = window.location.origin
  const tok = document.getElementById('auth-token')
  if (tok) tok.focus()
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
