function appendBrainBubble(container, text, cls) {
  const el = document.createElement('div')
  el.className = cls || 'recall-sys'
  el.textContent = text
  container.appendChild(el)
}

// Lightweight markdown → HTML for AI answers (headings, bold/italic, bullet & numbered lists).
function renderAnswerMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Citations the answer prompt asks for: [2] refers to the second memory
      // in the numbered list the model was given, which is the second source
      // card. Rendered as a chip that reveals and highlights that card, so a
      // claim can be checked against the memory it came from in one tap.
      .replace(/\[(\d{1,2})\]/g, (_, n) => `<button class="cite" data-cite="${n}" title="${escAttr(t('recall.citeTitle', { n }))}">${n}</button>`)

  // Some models stream lists inline ("... tools: * a * b * c") with no newlines.
  // Re-break a run of " * " markers onto their own lines so they parse as a list.
  let text = String(src || '').replace(/\r/g, '')
  if (!/\n\s*[*\-+]\s/.test(text) && (text.match(/\s\*\s/g) || []).length >= 2) {
    text = text.replace(/\s\*\s+/g, '\n* ')
  }

  const lines = text.split('\n')
  let html = ''
  let listType = null // 'ul' | 'ol'
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`
      listType = null
    }
  }

  lines.forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      closeList()
      return
    }

    let m
    if ((m = trimmed.match(/^(#{1,4})\s+(.*)$/))) {
      closeList()
      const lvl = Math.min(m[1].length + 2, 4) // h3/h4
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`
    } else if ((m = trimmed.match(/^[*\-+•]\s+(.*)$/))) {
      if (listType !== 'ul') {
        closeList()
        html += '<ul>'
        listType = 'ul'
      }
      html += `<li>${inline(m[1])}</li>`
    } else if ((m = trimmed.match(/^\d+[.)]\s+(.*)$/))) {
      if (listType !== 'ol') {
        closeList()
        html += '<ol>'
        listType = 'ol'
      }
      html += `<li>${inline(m[1])}</li>`
    } else {
      closeList()
      html += `<p>${inline(trimmed)}</p>`
    }
  })
  closeList()
  return html
}
function appendUserBubble(container, text) {
  const q = document.createElement('div')
  q.className = 'ex-q'
  q.innerHTML = `<span class="q-label">${escHtml(t('recall.youAsked'))}</span><span class="q-dash">\u2014</span><span class="q-text"></span>`
  q.querySelector('.q-text').textContent = text
  container.appendChild(q)
}
function appendLoading(container) {
  const row = document.createElement('div')
  row.className = 'bubble-row brain'
  row.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div>`
  container.appendChild(row)
  return row
}
function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 80) + 'px'
}
/**
 * The parts of the recall column that are not the conversation, and so must
 * survive clearing it.
 *
 * Wiping innerHTML was safe when this container held nothing but bubbles. Home,
 * the brief and the board moved in with them, and the wipe took all three,
 * permanently, in a desktop window that has no reload to recover with.
 */
const RECALL_FURNITURE = new Set(['home', 'brief', 'recall-welcome', 'board-tiles', 'board'])

function clearRecall() {
  const msgs = document.getElementById('recall-messages')
  for (const el of [...msgs.children]) {
    if (!RECALL_FURNITURE.has(el.id)) el.remove()
  }
  document.getElementById('recall-clear-btn').style.display = 'none'
  if (typeof returnHome === 'function') returnHome()
}
