// Team-edition flag for the whole dashboard: set once /health answers (see
// maybeRevealHomeLayer in home.js). Every layer control — capture target,
// share actions, layer filters — reads this, so solo brains never render any
// of it. Declared here because api.js loads before every consumer.
let TEAM_MODE = false
/** The composer's capture target: null = Auto (server-side member/org default decides). */
let homeLayer = null

async function apiMcp(toolName, args) {
  const res = await fetch(`${WORKER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args } }),
  })
  const text = await res.text()
  const match = text.match(/data: ({.+})/s)
  if (!match) throw new Error(t('common.invalidResponse'))
  const json = JSON.parse(match[1])
  if (json.error) throw new Error(json.error.message || t('common.mcpError'))
  return json.result?.content?.[0]?.text ?? ''
}

async function apiCapture(content, tags, source, workspace) {
  const res = await fetch(`${WORKER_URL}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    // workspace is omitted unless the user picked a layer explicitly — the
    // server's per-member/org default then decides, which is what makes admin
    // policy the quiet default rather than a hard-coded one here.
    body: JSON.stringify({ content, tags, source: source || 'web-ui', ...(workspace ? { workspace } : {}) }),
  })
  return res.json()
}

async function apiList(n = 50, workspace) {
  const params = new URLSearchParams({ n: String(n) })
  if (workspace) params.set('workspace', workspace)
  const res = await fetch(`${WORKER_URL}/list?${params}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
  return res.json()
}

/** Move a memory between the personal and company layers (MOVE semantics). */
async function apiShare(id, workspace) {
  const res = await fetch(`${WORKER_URL}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ id, workspace }),
  })
  return res.json()
}

/** Share/unshare with confirm + undo toast; refreshes via optional callback. */
async function toggleEntryLayer(id, currentLayer, onDone) {
  const goingShared = currentLayer !== 'company'
  const target = goingShared ? 'company' : 'personal'
  const previous = currentLayer === 'company' ? 'company' : 'personal'
  const question = goingShared ? t('team.shareConfirm') : t('team.unshareConfirm')
  if (!confirm(question)) return
  try {
    const r = await apiShare(id, target)
    if (!r.ok) throw new Error(r.error || t('team.actionFailed'))
    showToast(goingShared ? t('team.sharedToast') : t('team.unsharedToast'), {
      action: t('team.undo'),
      onAction: async () => {
        await apiShare(id, previous)
        if (typeof onDone === 'function') onDone()
        else if (typeof refreshAll === 'function') refreshAll()
      },
    })
    if (typeof onDone === 'function') onDone()
    else if (typeof loadRecent === 'function') loadRecent()
    else if (typeof refreshAll === 'function') refreshAll()
  } catch (e) {
    alert(e.message || t('team.actionFailed'))
  }
}
