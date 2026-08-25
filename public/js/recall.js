function sendSuggestion(text) {
  document.getElementById('recall-input').value = text
  sendRecall()
}
function handleRecallKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendRecall()
  }
}

/**
 * Workers AI streams two different answer shapes depending on model
 * lineage: Llama-family models put the text directly on `response`;
 * OpenAI-lineage models (`@cf/openai/gpt-oss-*`) stream an OpenAI-style
 * chat-completion delta under `choices[0].delta.content` instead, and the
 * reasoning ones in that family emit chain-of-thought first as
 * `delta.reasoning` / `delta.reasoning_content` — deliberately never
 * returned here, since callers render this as the answer, not as reasoning
 * prose.
 *
 * This mirrors extractChunkText/consumeSseLine in src/lib/ai.ts, which has
 * the fuller explanation. The client can't reuse that helper directly:
 * POST /chat (src/routes/recall.ts) streams the raw Workers AI response
 * straight to the browser rather than through readStreamText, so this is a
 * second, hand-kept-in-sync implementation. A change to one should be a
 * prompt to check the other.
 */
function extractChatChunkText(d) {
  if (d && d.response) return d.response
  const content = d && d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content
  return typeof content === 'string' ? content : ''
}

function consumeChatSseLine(line, onText) {
  if (!line.startsWith('data: ') || line.includes('[DONE]')) return
  try {
    const d = JSON.parse(line.slice(6))
    const text = extractChatChunkText(d)
    if (text) onText(text)
  } catch (e) {
    // A parse failure here is on a COMPLETE line (buffering already held
    // back any partial one), so it's a genuine anomaly rather than a
    // chunk-boundary artifact — worth logging, but it must not interrupt
    // the stream: dropping one malformed SSE line beats losing everything
    // read so far.
    console.error('sendRecall: malformed SSE line (non-fatal):', e)
  }
}

/**
 * Feeds one decoded chunk of the /chat stream through line buffering, so an
 * SSE line split across a network chunk boundary isn't silently dropped.
 * `buffer` carries any trailing partial line across calls — pass the
 * returned value back in on the next call, and flush whatever is left with
 * consumeChatSseLine once the stream ends. Mirrors the buffering loop in
 * src/lib/ai.ts's readStreamText.
 */
function feedChatStream(buffer, decodedChunk, onText) {
  buffer += decodedChunk
  const lines = buffer.split('\n')
  // The last element is either "" (buffer ended on a newline) or an
  // incomplete line — either way it stays buffered for the next call.
  buffer = lines.pop() ?? ''
  for (const line of lines) consumeChatSseLine(line, onText)
  return buffer
}

function maybeRevealRecallLayer(health) {
  const wrap = document.getElementById('recall-layer-wrap')
  if (wrap) wrap.style.display = TEAM_MODE ? '' : 'none'
}

/** Layer filter changed: re-run the last query so the answer matches the filter. */
function onRecallLayerChange(value) {
  const last = [...document.querySelectorAll('#recall-messages .ex-q .q-text')]
  const lastQuery = last.length ? last[last.length - 1].textContent.trim() : ''
  if (lastQuery) sendRecall(lastQuery)
}

async function sendRecall(retryQuery) {
  const input = document.getElementById('recall-input')
  const query = (retryQuery || input.value).trim()
  if (!query) return
  const msgs = document.getElementById('recall-messages')
  const welcome = document.getElementById('recall-welcome')
  if (welcome) welcome.remove()
  appendUserBubble(msgs, query)
  input.value = ''
  autoResize(input)
  const loadingEl = appendLoading(msgs)
  msgs.scrollTop = msgs.scrollHeight
  try {
    // Use the REST endpoint for structured results — parsing the MCP tool's
    // formatted text miscounts sources when memory content contains list items
    // hops=1 lets recall follow relationship edges one step out; direct matches
    // always outrank expanded ones (worker applies a graph-distance penalty)
    // full=1: the dashboard renders whole memories in its cards, so it opts out
    // of the snippet shortening that keeps API/agent responses small
    const params = new URLSearchParams({ query, topK: '5', hops: '1', full: '1' })
    if (selectedTag) params.set('tag', selectedTag)
    const layerSel = document.getElementById('recall-layer')
    const layer = layerSel ? layerSel.value : ''
    if (layer) params.set('workspace', layer)
    const recallRes = await fetch(`${WORKER_URL}/recall?${params}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    const data = await recallRes.json()
    // Server/auth errors must not render as "no results" — let the catch handle them
    if (!recallRes.ok || !data.ok) throw new Error(data.error || 'recall failed')
    loadingEl.remove()
    if (!data.results || !data.results.length) {
      appendBrainBubble(msgs, t('recall.empty'), 'recall-sys')
    } else {
      // REST scores are already 0–100 (one decimal); map directly rather than via
      // normalizeEntry, whose 0–1 rescale heuristic would turn a 0.8% match into 80%
      // created_at and source travel with the card now: a source you cannot
      // date or place is hard to weigh, and the answer above cites these by
      // number, so each card has to be able to say which number it is.
      const entries = data.results.map((m) => ({
        id: m.id,
        content: m.content,
        tags: m.tags || [],
        score: Math.min(100, Math.round(m.score)),
        hop: m.hop || 0,
        created_at: m.created_at,
        source: m.source,
        workspace: m.workspace || null,
      }))
      const answerBubble = document.createElement('div')
      answerBubble.className = 'ex-a-row'
      const answerEl = document.createElement('div')
      answerEl.className = 'ex-a'
      answerBubble.appendChild(answerEl)
      msgs.appendChild(answerBubble)

      // Serialize results for the /chat LLM context, mirroring the MCP tool's
      // format — dates/tags/source are needed for temporal questions
      const memories =
        (data.insight ? `Insight: ${data.insight}\n\n` : '') +
        data.results
          .map((m, i) => {
            // Month by name, never 8/2/2026: the answer prompt asks the model
            // to date its claims, and a numeric date is read as D/M in half the
            // world. It reported an August memory as "8 February 2026".
            const date = new Date(m.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            const tagList = m.tags && m.tags.length ? ` [${m.tags.join(', ')}]` : ''
            const src = m.source ? ` · ${m.source}` : ''
            const related = m.hop > 0 ? ` [related, ${m.hop} hop${m.hop > 1 ? 's' : ''}]` : ''
            return `${i + 1}. [${date}${src}${tagList}] (${Math.min(100, Math.round(m.score))}% match)${m.updated ? ' [updated]' : ''}${related}\n${m.content}`
          })
          .join('\n\n')
      const res = await fetch(`${WORKER_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ query, memories }),
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let buffer = ''
      const onText = (chunk) => {
        fullText += chunk
        answerEl.textContent = fullText
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // { stream: true } holds back a trailing partial multi-byte
          // sequence until the bytes that complete it arrive next read.
          buffer = feedChatStream(buffer, decoder.decode(value, { stream: true }), onText)
          msgs.scrollTop = msgs.scrollHeight
        }
        // Flush any bytes the decoder was holding back, then process a
        // final line that may have arrived with no trailing newline.
        buffer += decoder.decode()
        if (buffer) consumeChatSseLine(buffer, onText)
      } finally {
        reader.releaseLock()
      }

      // Render markdown once the stream is complete (kept plain while streaming for speed)
      answerEl.innerHTML = renderAnswerMarkdown(fullText)

      // 2. Sources toggle
      const sourcesToggle = document.createElement('div')
      sourcesToggle.className = 'sources-toggle'
      // "found · N sources" is the phrasing the marketing site uses for exactly
      // this moment; the dashboard should not invent a different one.
      sourcesToggle.innerHTML = `<button onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'flex' : 'none'">
      <i class="ti ti-files"></i> ${escHtml(tPlural('recall.sourcesFound', entries.length))}
    </button>
    <div class="brain-cards-wrapper" style="display:none"></div>`
      const wrapper = sourcesToggle.querySelector('.brain-cards-wrapper')
      entries.forEach((e, i) => {
        const card = makeRecallCard(e, i + 1)
        // The model cites by position in the list it was handed, which is this
        // order — so [2] and the second card are the same memory by construction.
        card.dataset.cite = String(i + 1)
        wrapper.appendChild(card)
      })
      msgs.appendChild(sourcesToggle)

      // Models sometimes cite past the end of the list they were given — [8]
      // against five sources. A chip that leads nowhere is worse than plain
      // text, so those revert to the literal marker they came from.
      answerEl.querySelectorAll('.cite').forEach((chip) => {
        const n = Number(chip.dataset.cite)
        if (!(n >= 1 && n <= entries.length)) chip.replaceWith(`[${chip.dataset.cite}]`)
      })

      // A citation chip opens the sources (they start collapsed) and walks the
      // reader to the memory the claim came from.
      answerEl.querySelectorAll('.cite').forEach((chip) => {
        chip.onclick = () => {
          const n = chip.dataset.cite
          const target = wrapper.querySelector(`[data-cite="${n}"]`)
          if (!target) return
          wrapper.style.display = 'flex'
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
          target.classList.add('memory-card--cited')
          setTimeout(() => target.classList.remove('memory-card--cited'), 1600)
        }
      })
      document.getElementById('recall-clear-btn').style.display = 'flex'
    }
  } catch {
    loadingEl.remove()
    appendBrainBubble(msgs, t('recall.error'), 'recall-sys')
  }
  msgs.scrollTop = msgs.scrollHeight
}

function makeRecallCard(entry, citeIndex) {
  const card = document.createElement('div')
  const isSynthesized = entry.tags.includes('synthesized')
  const isRolledUp = entry.tags.includes('rolled-up')
  const isStale = entry.stale_as_of || entry.tags.includes('stale:as-of')
  card.className = 'memory-card' + (isSynthesized ? ' card--synthesized' : '') + (isRolledUp ? ' card--rolled-up' : '') + (isStale ? ' card--stale' : '')
  card.innerHTML = `
    <div class="match-line">
${citeIndex ? `<span class="cite-badge" title="${escAttr(t('recall.citedAs', { n: citeIndex }))}">${citeIndex}</span>` : ''}
<span class="match-pct">${entry.score}%</span>
${entry.hop > 0 ? `<span class="tag-chip" style="background:var(--accent-soft);color:var(--accent);flex-shrink:0">${escHtml(tPlural('recall.relatedHop', entry.hop))}</span>` : ''}
<div class="match-bar-bg"><div class="match-bar-fill" style="width:${entry.score}%"></div></div>
    </div>
    <div class="card-content" style="cursor: pointer;">${escHtml(stripToPlainText(entry.content))}</div>
    ${(() => {
      const badge = sourceBadge(entry.source)
      const at = Number(entry.created_at) || 0
      if (!entry.source && !at) return ''
      return `<div class="card-meta">
        <span class="card-source"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>
        ${at ? `<span class="card-time" title="${escAttr(new Date(at).toLocaleString(localeTag()))}">${escHtml(relativeTime(at))}</span>` : ''}
      </div>`
    })()}
    <div class="card-footer">
<div class="card-tags">${humanTags(entry.tags).map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}</div>
<div class="card-actions">
  ${
    entry.id
      ? `<button class="card-action-btn" onclick="openAppend('${escAttr(entry.id)}', '${escAttr(entry.content.slice(0, 80))}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>
      ${TEAM_MODE ? `<button class="card-action-btn" onclick="toggleEntryLayer('${escAttr(entry.id)}', '${escAttr(entry.workspace || '')}')"><i class="ti ti-users-group"></i> ${escHtml(entry.workspace === 'company' ? t('memories.makePrivate') : t('memories.shareWithTeam'))}</button>` : ''}`
      : `<button class="card-action-btn" onclick="openAppendFromContent('${escAttr(entry.content)}')"><i class="ti ti-writing"></i> ${escHtml(t('memories.append'))}</button>`
  }
</div>
    </div>`
  card.querySelector('.card-content').onclick = () => openView(entry, card)
  return card
}
