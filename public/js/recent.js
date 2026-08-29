// Loads the list and nothing else. It used to also refresh the count and the
// tags, which made it the de-facto "refresh the app" call and left everything
// it did not know about — the brief, and so the greeting's count — permanently
// stale. Refreshing the shell is refreshAll()'s job now; this owns one list.

/** Layer filter for the memories screen: null = all layers. */
let memoryLayerFilter = null
/** Author filter, meaningful only on the shared layer: null = everyone. */
let memoryActorFilter = null
/**
 * Whether the memories list is in selection mode.
 *
 * A mode rather than always-on checkboxes: the cost of a mode is one tap, and
 * the cost of always-on is that every visit to the screen people READ looks
 * like a bulk-edit tool. Only reachable through #mem-select-btn, which
 * renderBulkBar holds at display:none on a solo brain.
 */
let selectMode = false
/** The ticked ids. Survives a re-render; cleared on leaving the mode. */
const selectedMemoryIds = new Set()
/**
 * What renderRecent last put ON SCREEN — the filtered list, not allEntries.
 *
 * applyRecentFilters (nav.js) narrows allEntries by tag and time before
 * handing the result here, so "Select all" over allEntries would pick up rows
 * the user cannot see. Every bulk action reads this instead.
 */
let renderedEntries = []
/**
 * True while a bulk move is posting.
 *
 * The loop's only piece of module state, and it exists because the SHEET's
 * double-submit guard is per question rather than per caller: dismissing the
 * question does not stop the loop, and re-asking opens a new question the
 * guard cannot see. One flag, checked before a second batch can be asked for
 * and read by renderBulkBar so the two actions are visibly held down rather
 * than silently dead.
 */
let bulkMoveInFlight = false
/** { members, you } from GET /team/roster; null = not fetched yet. */
let memoryAuthors = null
/** The in-flight roster request, shared by concurrent callers. */
let memoryAuthorsPending = null

function maybeRevealMemoryLayerFilter(health) {
  // The outer span is what carries display:none — the select's immediate
  // parent is the inner chevron wrapper. Both branches, so the filter's
  // visibility always tracks TEAM_MODE rather than just being revealed once.
  const wrap = document.getElementById('layer-filter-wrap')
  if (wrap) wrap.style.display = TEAM_MODE ? '' : 'none'
  // Last, so a brain that stops being a team drops both controls together
  // rather than leaving an author filter behind over a layer filter that has
  // just gone away.
  maybeRevealActorFilter()
  // Last, and for the same reason: a brain that stops being a team drops the
  // Select button with the rest of the layer controls, and — because
  // renderBulkBar reads TEAM_MODE itself — the bulk bar with it.
  renderBulkBar()
}

/**
 * Enter or leave selection mode.
 *
 * Leaving clears the set: a selection that survived the exit would still be
 * there the next time someone pressed Select, over a list they may since have
 * re-filtered. Re-renders through applyRecentFilters either way, so the cards
 * gain or lose their checkbox.
 */
function toggleSelectMode() {
  selectMode = !selectMode
  if (!selectMode) selectedMemoryIds.clear()
  applyRecentFilters()
}

/**
 * Leave the mode because the LIST left the screen, not because Done was pressed.
 *
 * CLEARS rather than suspends. Selection is over what is ON SCREEN, and the
 * graph projection draws no cards at all, so a suspended selection would be a
 * second piece of state meaning "these rows, from a list you are no longer
 * looking at" — which is the thing toggleSelectMode already refuses to keep
 * across an exit, for the same reason: the list may have been re-filtered by
 * the time anyone comes back to it. Coming back to the list gives the mode
 * back, not the ticks.
 *
 * Renders the bar rather than the list: the list is hidden by now, and
 * re-filtering it would be work nobody can see.
 */
function exitSelectMode() {
  selectMode = false
  selectedMemoryIds.clear()
  renderBulkBar()
}

/**
 * The ticked rows that are ON SCREEN, in the order they are rendered.
 *
 * ONE reader for the bar and for the action, so the count, the two buttons and
 * the POSTs cannot disagree about what is selected. They did: nothing prunes
 * the set when the filter changes, so ticking two rows and then filtering them
 * away left the bar reading "2 selected" with both actions enabled over a list
 * containing neither — and pressing one opened no sheet, posted nothing and
 * said nothing. Derived rather than pruned, because a filter should hide a
 * selection and not destroy it: the ticks come back with the rows.
 *
 * Guards each element the way selectAllVisible does. Two readers of one array
 * that disagree about what can be in it is how one of them starts throwing.
 */
function selectedVisibleIds() {
  return renderedEntries.filter((e) => e && e.id && selectedMemoryIds.has(e.id)).map((e) => e.id)
}

/** "All" means what is on screen under the current filters. See renderedEntries. */
function selectAllVisible() {
  renderedEntries.forEach((e) => {
    if (e && e.id) selectedMemoryIds.add(e.id)
  })
  applyRecentFilters()
}

function clearSelection() {
  selectedMemoryIds.clear()
  applyRecentFilters()
}

/**
 * One checkbox tap.
 *
 * Re-renders the whole filtered list rather than patching the one card. The
 * card is reachable from the checkbox in a browser and not in the fake DOM the
 * UI suite runs against, but the real reason is the same one renderAuthorOptions
 * rebuilds rather than patches: one rendering path for selection, instead of
 * one for bulk changes and another for single taps. Fifty cards is cheap.
 */
function toggleMemorySelection(id, on) {
  if (on) selectedMemoryIds.add(id)
  else selectedMemoryIds.delete(id)
  applyRecentFilters()
}

/**
 * The Select button and the bulk bar, both branches, every render.
 *
 * Stated in both directions rather than revealed once, for the reason
 * maybeRevealMemoryLayerFilter states both: a brain that stops being a team
 * has to lose these controls, not merely never gain them.
 */
function renderBulkBar() {
  // The graph draws no cards, so there is nothing on it to select. Read here
  // as well as cleared in setMemoryView, and for the reason TEAM_MODE is read
  // here rather than pushed in: #mem-select-btn is a SIBLING of #mem-filters
  // and #mem-bulk-bar a sibling of the whole .mem-bar, so nothing the graph
  // path already hides takes either of them down, and a caller that knows
  // nothing about the projection — the layer filter's reveal, say — must not
  // put them back over one.
  const listing = memoryView !== 'graph'
  const bar = document.getElementById('mem-bulk-bar')
  // '' and not 'flex': the stylesheet owns the layout (.mem-bulk-bar), and an
  // inline display here would be one more place to change it.
  if (bar) bar.style.display = TEAM_MODE && selectMode && listing ? '' : 'none'
  const toggle = document.getElementById('mem-select-btn')
  if (toggle) {
    toggle.style.display = TEAM_MODE && listing ? '' : 'none'
    // A template whose one ${} is a ternary over quoted literals, which is the
    // form the catalog→call-site scraper resolves. A bare ternary between two
    // whole keys, passed as the argument instead, is an unresolvable call site
    // and would orphan both of them.
    toggle.textContent = t(`bulk.${selectMode ? 'exit' : 'select'}`)
  }
  // What is ticked AND on screen — the same list the action posts, so the
  // count cannot promise rows the action would not send.
  const visible = selectedVisibleIds()
  const count = document.getElementById('mem-bulk-count')
  if (count) count.textContent = tPlural('bulk.count', visible.length, { n: visible.length })
  // Nothing selected is not a refusal to explain — it is a button that cannot
  // do anything yet, and the count beside it says why. A batch still in flight
  // holds them down for the other reason: its rows are already spoken for.
  const none = visible.length === 0 || bulkMoveInFlight
  const share = document.getElementById('mem-bulk-share')
  if (share) share.disabled = none
  const makePrivate = document.getElementById('mem-bulk-private')
  if (makePrivate) makePrivate.disabled = none
}

/**
 * Ask, then move them one at a time.
 *
 * THERE IS NO BULK ENDPOINT, and that is the requirement rather than a
 * shortcut. moveEntry (src/capture/share.ts) is the one place that decides who
 * may move what — personal → company is open, company → personal is refused
 * unless the caller is the entry's actor or an admin. A POST /share/bulk would
 * be a SECOND loop over that decision, with its own ordering, its own
 * partial-failure semantics and its own author-lock matrix, and the first time
 * one of them changed the two would disagree about a permission. Every row
 * here goes through apiShare — the same call the single-card control makes —
 * so the lock is enforced once, on the server, and this function never decides
 * who may move what. It is also the cheaper shape: fifty rows server-side is
 * fifty SELECTs and fifty batches in ONE Worker invocation, over 100
 * subrequests against a 50-subrequest ceiling, where fifty individual requests
 * are fifty invocations with fifty budgets.
 *
 * SEQUENTIAL, not Promise.all: fifty parallel POSTs against one D1 database is
 * a self-inflicted thundering herd, and the progress copy on the accept button
 * is only honest if the moves are ordered.
 *
 * A row that is refused is left SELECTED, which is how the user is told which
 * ones did not move without a second list to render or a second piece of state
 * to hold.
 *
 * A confirmation rather than the single-card control's undo toast: one card's
 * share is reversible in one tap and the toast IS that tap, but a bulk share
 * is a visibility decision over N memories whose reversal is N taps, and the
 * sheet is where this codebase asks about decisions it cannot cheaply undo.
 */
function confirmBulkLayerMove(target) {
  // Through renderedEntries rather than over the set, so the order the rows
  // are posted in is the order they are on screen — and so a row the current
  // filter has hidden cannot be posted at all.
  const ids = selectedVisibleIds()
  if (!ids.length) return
  // A batch already running owns these ids. closeConfirm — Escape, Cancel, the
  // backdrop — takes the question down without stopping the loop, and the
  // sheet's own double-submit guard is per QUESTION, so re-asking opened a
  // second question it could not see and ran a second loop over the same rows:
  // six POSTs for three, and, when the second target was the opposite of the
  // first, two /share calls racing over one id with each row's final layer
  // decided by whichever response landed last. The flag outlives the sheet
  // because the request does.
  if (bulkMoveInFlight) return
  const sharing = target === 'company'
  // Dismissing the question withdraws the request: rows the loop has not
  // reached yet were asked for by a question that is no longer on screen.
  // onClose is fired by Escape, Cancel, the backdrop AND by another sheet
  // replacing this one, which is every way this batch stops being the thing
  // the user is looking at.
  let cancelled = false
  openDangerConfirm({
    title: tPlural(`bulk.${sharing ? 'confirmShareTitle' : 'confirmPrivateTitle'}`, ids.length, { n: ids.length }),
    body: t(`bulk.${sharing ? 'confirmShareBody' : 'confirmPrivateBody'}`),
    confirmLabel: t(`bulk.${sharing ? 'shareAction' : 'privateAction'}`),
    onConfirm: async (_checked, done, progress) => {
      bulkMoveInFlight = true
      // So the two actions behind the sheet are visibly held down for as long
      // as this batch owns their rows, rather than being dead if it is
      // dismissed and pressed again.
      renderBulkBar()
      let moved = 0
      const refused = []
      try {
        for (let i = 0; i < ids.length; i++) {
          // Checked at the top of each turn, which is the only place the loop
          // can be stopped: the request already in flight has been sent and
          // will land whatever happens, and the rows after it have not.
          if (cancelled) break
          // Written through the handle this action was given, never onto
          // #confirm-accept-btn directly, and for the same reason as done():
          // that is ONE element, and a batch outliving its own question used
          // to label the question that replaced it — "Forget this memory?"
          // under a button reading "Moving 3 of 3…".
          progress(t('bulk.working', { done: i + 1, total: ids.length }))
          try {
            const r = await apiShare(ids[i], target)
            // r.ok is the whole classification, deliberately. A row already in
            // the target layer answers { ok: true, status: "no_change" } and
            // counts as moved — the user asked for a state and the row is in it.
            // A colleague's shared memory answers 403 and a row deleted since
            // the list was fetched answers 404; both are "this did not move",
            // which is the same sentence and is true of each.
            if (r && r.ok) {
              moved++
              selectedMemoryIds.delete(ids[i])
            } else {
              refused.push(ids[i])
            }
          } catch {
            // A network failure is a refusal for this row and nothing more:
            // aborting here would leave the user with a half-moved selection
            // and no way to tell which half.
            refused.push(ids[i])
          }
        }
      } finally {
        // In a finally, and only here: the last request has settled by the
        // time this runs, so nothing this batch sent can still be in the air
        // when the next one is allowed to start.
        bulkMoveInFlight = false
        renderBulkBar()
      }
      // Closed with the handle this action was given, never with
      // closeConfirm(): a batch can resolve long after its own question was
      // replaced, and by then "what is on screen" is someone else's.
      done()
      showToast(
        moved === 0
          ? t('bulk.resultNone')
          : refused.length === 0
            ? tPlural('bulk.resultMoved', moved, { n: moved })
            : `${tPlural('bulk.resultMoved', moved, { n: moved })} · ${tPlural('bulk.resultRefused', refused.length, { n: refused.length })}`,
      )
      loadRecent()
    },
    onClose: () => {
      cancelled = true
    },
  })
}

/**
 * The people whose shared memories this caller can filter by.
 *
 * Fetched here rather than read out of team.js's `teamRoster`, which is only
 * populated by a visit to the Team screen — a memories filter that works or
 * not depending on which screen you opened first is worse than one extra
 * request. A failure is recorded as an empty roster rather than left null, so
 * an unreachable or older Worker costs one request and not one per change of
 * filter.
 */
function loadMemoryAuthors() {
  if (!TEAM_MODE || memoryAuthors !== null) return Promise.resolve()
  // Memoised on the REQUEST, not on its result. Now that loadRecent no longer
  // waits for this, two loads can be in flight at once, and a result-only
  // memo would let both of them see `null` and both send the request.
  if (memoryAuthorsPending) return memoryAuthorsPending
  memoryAuthorsPending = (async () => {
    try {
      const res = await fetch(`${WORKER_URL}/team/roster`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      memoryAuthors = { members: Array.isArray(data.members) ? data.members : [], you: data.you ?? null }
    } catch {
      memoryAuthors = { members: [], you: null }
    } finally {
      memoryAuthorsPending = null
    }
  })()
  return memoryAuthorsPending
}

function renderAuthorOptions() {
  const select = document.getElementById('actor-filter-recent')
  if (!select || !memoryAuthors) return
  select.innerHTML =
    `<option value="">${escHtml(t('memories.allAuthors'))}</option>` +
    memoryAuthors.members
      .map(
        (m) =>
          `<option value="${escAttr(m.userId)}">${escHtml(m.userId === memoryAuthors.you ? t('memories.authorYou') : m.name)}</option>`,
      )
      .join('')
  // Restored rather than reset: rebuilding the list must not silently widen a
  // filter the user still has applied.
  select.value = memoryActorFilter || ''
}

/**
 * Show the author filter on the shared layer only, both branches, every call.
 *
 * On the personal layer every row is the caller's own, so the control would
 * offer one real choice; on a solo brain there is nobody else to filter by and
 * no roster is ever requested.
 */
async function maybeRevealActorFilter() {
  const wrap = document.getElementById('actor-filter-wrap')
  if (!wrap) return
  const show = TEAM_MODE && memoryLayerFilter === 'company'
  wrap.style.display = show ? '' : 'none'
  if (!show) {
    // The layer-change path clears this too (see onLayerFilterChange); this
    // one covers the other way the control can vanish — TEAM_MODE going false
    // under a filter that is already applied.
    memoryActorFilter = null
    return
  }
  await loadMemoryAuthors()
  renderAuthorOptions()
}

async function loadRecent() {
  const list = document.getElementById('recent-list')
  // Only show the loading state on a cold list. A refresh after a capture
  // would otherwise blank out rows the user is reading and snap them back.
  if (!allEntries.length) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-clock"></i><span>${escHtml(t('memories.loadingShort'))}</span></div>`
  }
  // Started here, deliberately NOT awaited. Its synchronous half — showing or
  // hiding the wrap, and clearing a filter that is going out of view — has
  // already run by the time this returns, which is all the request below
  // needs. Its asynchronous half is a roster fetch with no timeout and no
  // abort, and waiting for it would let one slow endpoint leave the memories
  // screen showing stale rows with no spinner and no error, indefinitely. The
  // author filter is a refinement of a list nobody can act on until it exists,
  // so it is allowed to populate a moment late.
  maybeRevealActorFilter()
  try {
    allEntries = await apiList(50, memoryLayerFilter, memoryActorFilter)
    // Through the filters, not straight to render: reloading used to reset the
    // list to everything while the filter controls still read "work" and
    // "past 7 days", which now happens after every capture rather than only
    // when someone pressed refresh.
    applyRecentFilters()
    showFirstRunIfEmpty(allEntries.length === 0)
  } catch {
    if (!allEntries.length) {
      list.innerHTML = `<div class="empty-state"><i class="ti ti-wifi-off"></i><span>${escHtml(t('memories.loadFailed'))}</span></div>`
    }
  }
  // Outside the try, so a failed load still gets a correct answer: whatever
  // survived in allEntries is what is on screen, and that is what the mark is
  // about.
  renderMemoriesCoach()
}

/**
 * "Only the author can change a shared memory", once there is a shared memory
 * to say it about.
 *
 * The trigger is a property of the LIST rather than an event on the share,
 * because the fact being taught is about memories that exist and not about an
 * action the reader took. That covers a member's own first share — their row
 * is in the very next list — and it also covers the far commoner case of
 * someone joining a team that already has shared memories, whom a share-event
 * trigger would never reach at all.
 *
 * Above the list rather than on a card: the lock is a rule about the layer,
 * not about one row. The per-row expression of it is the greyed-out Edit that
 * applyCardAuthorLock already puts on the card.
 */
function renderMemoriesCoach() {
  const shared = Array.isArray(allEntries) && allEntries.some((e) => e && e.workspace === 'company')
  // A null copy is the primitive's own hide branch, so "no shared memories
  // yet" needs no second code path here.
  renderCoachMark('coach-memories', 'author-lock', shared ? { title: t('coach.lockTitle'), body: t('coach.lockBody') } : null)
}

function onLayerFilterChange(value) {
  memoryLayerFilter = value || null
  // An author filter that survives a move off the shared layer keeps
  // narrowing a list from a control the user can no longer see.
  if (memoryLayerFilter !== 'company') memoryActorFilter = null
  loadRecent()
}

function onActorFilterChange(value) {
  memoryActorFilter = value || null
  loadRecent()
}

// toggleEntryLayer lives in api.js (confirm + undo toast)

// A brand-new brain has nothing to recall, so the usual prompt and its
// suggestions would all come back empty. Say where things live instead.
function showFirstRunIfEmpty(isEmpty) {
  const welcome = document.getElementById('recall-welcome')
  const suggestions = document.querySelector('.suggestions-row')
  if (!welcome) return
  if (!isEmpty) {
    if (suggestions) suggestions.style.display = ''
    welcome.classList.remove('first-run')
    return
  }
  if (suggestions) suggestions.style.display = 'none'
  welcome.classList.add('first-run')
  welcome.innerHTML =
    `<div class="eyebrow">${escHtml(t('home.firstRunEyebrow'))}</div>` +
    `<div class="hero-line">${escHtml(t('home.firstRunHero'))}</div>` +
    `<ol class="first-run-steps">` +
    // Named after what is on screen. This used to point at a Remember tab and a
    // Recall tab, both of which are now the one box above.
    `<li>${escHtml(t('home.firstRunStep1'))}</li>` +
    `<li>${escHtml(t('home.firstRunStep2'))}</li>` +
    `<li>${escHtml(t('home.firstRunStep3'))}</li>` +
    `</ol>`
}

function renderRecent(entries) {
  // First, so every path below — including the empty one — agrees with the bar
  // about what "everything on screen" means.
  renderedEntries = entries
  const list = document.getElementById('recent-list')
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-brain"></i><span>${escHtml(t('memories.empty'))}</span></div>`
    // In this branch too: a filter that empties the list must still leave the
    // bar and the Select button correct rather than showing the last count.
    renderBulkBar()
    return
  }
  const groups = {},
    now = new Date()
  const today = toDateStr(now),
    yesterday = toDateStr(new Date(now - 86400000))
  const sevenDaysAgo = now.getTime() - 7 * 86400000
  entries.forEach((entry) => {
    const d = new Date(entry.created_at),
      ds = toDateStr(d)
    let label
    if (ds === today) {
      label = t('memories.today')
    } else if (ds === yesterday) {
      label = t('memories.yesterday')
    } else if (entry.created_at >= sevenDaysAgo) {
      label = formatDateUI(d, { month: 'short', day: 'numeric' })
    } else {
      // Group by week: find the Monday of that week
      const dow = d.getDay()
      const diff = dow === 0 ? -6 : 1 - dow
      const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff)
      label = t('memories.weekOf', { date: formatDateUI(weekStart, { month: 'short', day: 'numeric' }) })
    }
    if (!groups[label]) groups[label] = []
    groups[label].push(entry)
  })
  list.innerHTML = ''
  Object.entries(groups).forEach(([label, group]) => {
    const g = document.createElement('div')
    g.className = 'date-group'
    g.innerHTML = `<div class="date-label">${label}</div>`
    const cards = document.createElement('div')
    cards.className = 'recent-cards'
    group.forEach((e) => cards.appendChild(makeRecentCard(e)))
    g.appendChild(cards)
    list.appendChild(g)
  })
  renderBulkBar()
}

function makeRecentCard(entry) {
  let tags = []
  try {
    tags = JSON.parse(entry.tags || '[]')
  } catch {}
  const isSynthesized = tags.includes('synthesized')
  const isRolledUp = tags.includes('rolled-up')
  const isStale = tags.includes('stale:as-of')

  let vectorIds = []
  try {
    vectorIds = JSON.parse(entry.vector_ids || '[]')
  } catch {}
  const vectorized = vectorIds.length > 0
  // Pending state is computed at render time; won't auto-flip — reload required
  const pending = !vectorized && Date.now() - (entry.created_at || 0) < vectorizeGraceMs
  const vec = vectorized ? 'on' : pending ? 'pending' : 'off'

  const vecChip =
    vec === 'on'
      ? `<span class="tag-chip vec-chip vec-chip--on" title="${escAttr(t('memories.vecOnTitle'))}"><i class="ti ti-circle-check"></i></span>`
      : vec === 'pending'
        ? `<span class="tag-chip vec-chip vec-chip--pending" title="${escAttr(t('memories.vecPendingTitle'))}"><i class="ti ti-clock"></i></span>`
        : `<span class="tag-chip vec-chip vec-chip--off" title="${escAttr(t('memories.vecOffTitle'))}">${escHtml(t('memories.vecNotIndexed'))}</span>`
  // Layer badge: shared memories are the team's — say so. Personal is the
  // quiet default and system rows (digests, insights) carry no badge. Built by
  // layerChipHtml in utils.js, which the review queue also calls, so the two
  // surfaces cannot come to describe the same row differently.
  const layerChip = layerChipHtml(entry, TEAM_MODE)

  const title = titleLine(entry.content)
  const preview = previewAfterTitle(entry.content, title)
  const shown = humanTags(tags)
  const badge = sourceBadge(entry.source)
  const created = Number(entry.created_at) || 0
  // Selection mode, on a team brain, and nothing else. Outside it both
  // expressions are the empty string and the card's markup is byte-identical
  // to what it was before multi-select existed — which is what keeps a solo
  // brain, and every card test written against it, untouched.
  const selecting = TEAM_MODE && selectMode
  const picked = selecting && selectedMemoryIds.has(entry.id)
  const selectBox = selecting
    ? `<label class="card-select"><input type="checkbox" ${picked ? 'checked' : ''} onchange="toggleMemorySelection('${escAttr(entry.id)}', this.checked)" /></label>`
    : ''
  const card = document.createElement('div')
  card.className = 'memory-card' + (isSynthesized ? ' card--synthesized' : '') + (isRolledUp ? ' card--rolled-up' : '') + (isStale ? ' card--stale' : '') + (picked ? ' memory-card--selected' : '')
  card.dataset.id = entry.id
  card.innerHTML =
    selectBox +
    `
<div class="card-content" style="cursor: pointer;">
  <div class="card-title">${escHtml(title)}</div>
  ${preview ? `<div class="card-preview">${escHtml(preview)}</div>` : ''}
</div>
<div class="card-footer">
  <div class="card-meta">
    <span class="card-source"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>
    ${created ? `<span class="card-time" title="${escAttr(new Date(created).toLocaleString(localeTag()))}">${escHtml(relativeTime(created))}</span>` : ''}
  </div>
  <div class="card-tags">${shown.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}${layerChip}${vecChip}</div>
  <div class="card-actions">
    <button class="card-action-btn append-btn" onclick="openAppend('${escAttr(entry.id)}', '${escAttr(entry.content.slice(0, 80))}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>
    <button class="card-action-btn edit-btn"><i class="ti ti-pencil"></i> ${escHtml(t('memories.edit'))}</button>
    <div class="card-overflow">
      <button class="card-action-btn overflow-btn" aria-label="${escAttr(t('memories.moreActions'))}" aria-haspopup="true" aria-expanded="false"><i class="ti ti-dots"></i></button>
      <div class="card-overflow-menu" hidden>
        ${TEAM_MODE ? `<button class="card-overflow-item share-btn"><i class="ti ti-users-group"></i> ${escHtml(entry.workspace === 'company' ? t('memories.makePrivate') : t('memories.shareWithTeam'))}</button>` : ''}
        <button class="card-overflow-item danger forget-btn"><i class="ti ti-trash"></i> ${escHtml(t('memories.forgetThis'))}</button>
      </div>
    </div>
  </div>
</div>`
  // Forget is permanent and used to sit at equal weight beside Edit on every
  // row. It lives behind the overflow now — one deliberate extra tap, and the
  // only destructive control in the list.
  const overflow = card.querySelector('.card-overflow')
  const overflowBtn = card.querySelector('.overflow-btn')
  const overflowMenu = card.querySelector('.card-overflow-menu')
  overflowBtn.onclick = (ev) => {
    ev.stopPropagation()
    const open = !overflowMenu.hidden
    document.querySelectorAll('.card-overflow-menu').forEach((m) => (m.hidden = true))
    overflowMenu.hidden = open
    overflowBtn.setAttribute('aria-expanded', String(!open))
    if (!open) card.classList.add('card--menu-open')
    else card.classList.remove('card--menu-open')
  }
  card.querySelector('.forget-btn').onclick = (ev) => {
    ev.stopPropagation()
    overflowMenu.hidden = true
    card.classList.remove('card--menu-open')
    openConfirm(entry.id, overflowBtn)
  }
  const shareBtn = card.querySelector('.share-btn')
  if (shareBtn) {
    shareBtn.onclick = (ev) => {
      ev.stopPropagation()
      overflowMenu.hidden = true
      card.classList.remove('card--menu-open')
      toggleEntryLayer(entry.id, entry.workspace)
    }
  }
  overflow.addEventListener('click', (ev) => ev.stopPropagation())
  card.querySelector('.card-content').onclick = () => openView({ id: entry.id, content: entry.content, tags }, card)
  card.querySelector('.edit-btn').onclick = () => openEdit(entry.id, entry.content, tags)
  // Last, so it runs over the finished markup and after the handlers it
  // disables. GET /list reports `can_edit` per row; without reading it here a
  // member taps Edit on a colleague's shared card, types, saves, and only then
  // meets the 403. Same helper the detail sheet uses, so the two surfaces
  // cannot drift apart on who may change what.
  applyCardAuthorLock(entry, card)
  return card
}
