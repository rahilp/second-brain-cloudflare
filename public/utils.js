/* utils.js — helper functions for the Second Brain UI.
 *
 * In production these are served from the Worker root. This file mirrors
 * them so the UI is fully functional in preview / offline as well.
 * (Path resolves to the same /utils.js when index.html is served at root.)
 */

/* Escape text for safe insertion into HTML. */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Escape text for safe insertion into a single-quoted HTML attribute / inline JS string. */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

/* yyyy-mm-dd in local time, for day-grouping. */
/**
 * Source text as a person would read it.
 *
 * Captured memories arrive as whatever the source sent: email bodies with
 * `*****` rules and `[Sign in to your account]` link text, GitHub PR bodies
 * full of markdown headers. Rendering that raw made every Recent row start
 * with punctuation instead of meaning.
 *
 * Deliberately lossy and deliberately not a markdown parser — the goal is a
 * readable first impression, and the full text is one tap away.
 */
function stripToPlainText(s) {
  return String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The line a row leads with: the first sentence, or the first clause long
 * enough to mean something. Falls back to a hard truncation so a wall of
 * text without punctuation still yields a title.
 */
function titleLine(content, max = 90) {
  const plain = stripToPlainText(content)
  if (!plain) return t('memories.untitled')
  const sentence = plain.match(/^.{10,}?[.!?](\s|$)/)
  const line = (sentence ? sentence[0] : plain).trim()
  if (line.length <= max) return line

  // Break at a word boundary, not a character count.
  //
  // This used to be a bare `slice(max - 1)`, which severed the word it landed
  // in — and previewAfterTitle resumes at exactly this offset, so the card
  // showed the two halves as separate lines: "…agreed to hire o…" above "ne
  // more backend engineer." Cutting on the space fixes both ends at once.
  //
  // The 60% floor is for the case a boundary cannot help: a title whose first
  // word is enormous would otherwise collapse to almost nothing, so past that
  // point the hard cut is the better of two bad options.
  const cut = line.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const head = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut
  return head.trimEnd() + '…'
}

/**
 * The weekly insight pass appends its own provenance to what it writes —
 * `\n\n[Insight: <shape> — drawn from N memories]` — so the one stored string
 * can answer both "what should a person read" and "what shape of observation
 * is this" (src/insight/weekly.ts). Every surface that displays a pending
 * insight's content reads it back through here, so the sentence a person
 * judges and the bookkeeping that produced it never appear as one blob of
 * text.
 *
 * An insight with no such suffix (or content that is not a pending insight at
 * all) just gets trimmed and returned with shape: null — this is safe to call
 * on any entry's content, not only auto-insight rows.
 */
function splitInsightShape(content) {
  const s = String(content ?? '')
  const m = s.match(/\n\n\[Insight:\s*(contradiction|throughline|connection)\s*—[^\]]*\]\s*$/)
  return m ? { text: s.slice(0, m.index).trim(), shape: m[1] } : { text: s.trim(), shape: null }
}

/**
 * Source text laid out for reading, without changing what is stored.
 *
 * Emails arrive wrapped and indented by whatever client sent them, and
 * `white-space: pre-wrap` reproduces every bit of it: paragraphs that start
 * two-thirds of the way across the screen, runs of blank lines, and a leading
 * `#` from a subject line the sync wrote as a markdown heading. The row
 * preview strips all structure (stripToPlainText); this keeps paragraphs and
 * lists, and removes only the accidents of transport.
 *
 * Render-time only. The stored content stays byte-identical, because export,
 * restore and the embeddings all read it.
 */
function normalizeForDisplay(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n')
  let inFence = false
  const lines = src.split('\n').map((line) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    // Inside a fence the indentation is the content.
    if (inFence) return line.replace(/\s+$/, '')
    return line.replace(/^[ \t]+/, '').replace(/\s+$/, '')
  })
  return lines
    .join('\n')
    // A subject line the mail sync wrote as a heading reads better as a title.
    .replace(/^#{1,6}\s+/, '')
    // Mail clients pad with blank lines; more than one says nothing extra.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The preview line: what is left after the title has already said its piece.
 *
 * Rendering the full stripped text under a title derived from its first
 * sentence showed the same words twice — the top of a row was pure
 * duplication. Empty means the title said everything, and the caller should
 * render no preview at all rather than a blank line.
 */
function previewAfterTitle(content, title) {
  const plain = stripToPlainText(content)
  if (!plain) return ''
  const head = String(title ?? '').replace(/…$/, '').trim()
  if (head && plain.startsWith(head)) return plain.slice(head.length).trim()
  return plain
}

/** Relative time for UI rows — absolute dates stay on hover via title attributes. */
function relativeTime(ts) {
  const then = Number(ts)
  if (!Number.isFinite(then) || then <= 0) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return t('common.justNow')
  const mins = Math.round(secs / 60)
  if (mins < 60) return t('common.minutesAgo', { n: formatNumberUI(mins) })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('common.hoursAgo', { n: formatNumberUI(hours) })
  const days = Math.round(hours / 24)
  if (days < 7) return t('common.daysAgo', { n: formatNumberUI(days) })
  const weeks = Math.round(days / 7)
  if (weeks < 5) return t('common.weeksAgo', { n: formatNumberUI(weeks) })
  const months = Math.round(days / 30)
  if (months < 12) return t('common.monthsAgo', { n: formatNumberUI(months) })
  return t('common.yearsAgo', { n: formatNumberUI(Math.round(days / 365)) })
}

/**
 * Icon and label for where a memory came from.
 *
 * Real brand marks wherever the icon font has one — Tabler ships OpenAI,
 * GitHub, Google, Apple and Notion, and a recognisable logo reads faster than
 * any glyph. Where it has none (Anthropic, Obsidian) the fallback describes
 * the *kind* of source honestly rather than reaching for a generic AI sparkle:
 * a Claude memory came from a conversation, so it gets a conversation icon.
 *
 * Ordered most specific first — "claude-code" is a terminal, not a chat, and
 * "email-gmail" is Google before it is mail.
 */
const SOURCE_BADGE_I18N = {
  'claude code': 'common.sourceClaudeCode',
  cli: 'common.sourceCli',
  email: 'common.sourceEmail',
  chat: 'common.sourceChat',
  browser: 'common.sourceBrowser',
  dashboard: 'common.sourceDashboard',
  phone: 'common.sourcePhone',
  voice: 'common.sourceVoice',
  import: 'common.sourceImport',
  system: 'common.sourceSystem',
  manual: 'common.sourceManual',
}

const SOURCE_BADGES = [
  // Terminals and code tools. `cli` is the Second Brain CLI; an earlier version
  // of this table matched it to GitHub, which was simply wrong.
  [/claude-code/, 'ti-terminal-2', 'claude code'],
  [/^cli$|command-line|terminal/, 'ti-terminal-2', 'cli'],
  [/git-hook|github|^git$/, 'ti-brand-github', 'github'],
  // Mail, branded by provider where we know it.
  [/gmail/, 'ti-brand-google', 'gmail'],
  [/icloud/, 'ti-brand-apple', 'icloud'],
  [/mail/, 'ti-mail', 'email'],
  // Assistants. OpenAI has a brand mark; Anthropic does not, so Claude takes
  // the conversation icon rather than a sparkle that means nothing.
  [/chatgpt|openai|codex/, 'ti-brand-openai', 'chatgpt'],
  [/claude/, 'ti-message-2', 'claude'],
  [/conversation|^chat$/, 'ti-message-2', 'chat'],
  // Surfaces.
  [/notion/, 'ti-brand-notion', 'notion'],
  [/obsidian/, 'ti-notes', 'obsidian'],
  [/extension|browser/, 'ti-browser', 'browser'],
  [/web-ui|dashboard/, 'ti-browser', 'dashboard'],
  [/phone|ios|shortcut/, 'ti-device-mobile', 'phone'],
  [/voice|microphone/, 'ti-microphone', 'voice'],
  [/import|restore/, 'ti-upload', 'import'],
  // Written by the brain itself: compression, pattern mining, digests.
  [/^system$|^auto/, 'ti-cpu', 'system'],
  [/^user$|manual|^api$/, 'ti-writing', 'manual'],
]

function sourceBadgeLabel(label) {
  const key = SOURCE_BADGE_I18N[label]
  return key ? t(key) : label
}

function sourceBadge(source) {
  const raw = String(source ?? '').trim().toLowerCase()
  if (!raw) return { icon: 'ti-writing', label: t('common.sourceManual') }
  for (const [pattern, icon, label] of SOURCE_BADGES) {
    if (pattern.test(raw)) return { icon, label: sourceBadgeLabel(label) }
  }
  // Some rows carry a whole sentence as their source ("ChatGPT conversation on
  // AI-native SDLC"). Show something rather than nothing, but never let it set
  // the width of the meta line.
  const label = raw.length > 18 ? raw.slice(0, 17) + '…' : raw
  return { icon: 'ti-writing', label }
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* Parse the text returned by the `recall` MCP tool into entry objects.
 * Tolerant of a few shapes: JSON array, or a numbered / bulleted text list
 * with an optional [NN%] score, inline #hashtags, and a trailing (id: …).
 * Returns: [{ score, content, tags: string[], id }]
 */
function parseRecallResult(result) {
  if (!result) return [];

  // 1) JSON payload
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    const arr = Array.isArray(data) ? data : (data.results || data.memories || data.entries);
    if (Array.isArray(arr)) {
      return arr.map(e => normalizeEntry(e));
    }
  } catch (_) { /* not JSON — fall through to text parsing */ }

  // 2) Text list
  const text = String(result);
  const blocks = text
    .split(/\n(?=\s*(?:\d+[.)]|[-*•]|\[))/)   // split on new list items
    .map(b => b.trim())
    .filter(Boolean);

  const entries = [];
  blocks.forEach(block => {
    let body = block.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '');

    // score like [87%] or (87%)
    let score = null;
    const sm = body.match(/[\[(]\s*(\d{1,3})\s*%\s*[\])]/);
    if (sm) { score = parseInt(sm[1], 10); body = body.replace(sm[0], '').trim(); }

    // trailing (id: xxx)
    let id = null;
    const im = body.match(/\(id:\s*([^)]+)\)\s*$/i);
    if (im) { id = im[1].trim(); body = body.replace(im[0], '').trim(); }

    // hashtags
    const tags = [];
    let tm; const tagRe = /#([a-zA-Z0-9_-]+)/g;
    while ((tm = tagRe.exec(body)) !== null) tags.push(tm[1]);
    const content = body.replace(/#[a-zA-Z0-9_-]+/g, '').replace(/\s{2,}/g, ' ').trim();

    if (content) {
      entries.push({
        score: score == null ? 0 : score,
        content,
        tags,
        id
      });
    }
  });

  return entries;
}

/* Coerce a structured recall entry into the shape the UI expects. */
function normalizeEntry(e) {
  let tags = e.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (_) { tags = tags ? [tags] : []; }
  }
  if (!Array.isArray(tags)) tags = [];
  let score = e.score != null ? e.score : (e.similarity != null ? e.similarity : 0);
  if (score > 0 && score <= 1) score = Math.round(score * 100);   // 0–1 → percent
  return {
    score: Math.round(score) || 0,
    content: e.content != null ? e.content : (e.text || ''),
    tags,
    id: e.id != null ? e.id : null
  };
}

/* Build the dashboard warning banner contents when the Vectorize index is
 * missing. Returns null when healthy or when health is unknown, so a transient
 * fetch failure never raises a false alarm. */
function vectorizeHealthBanner(health) {
  if (!health || !health.vectorize || health.vectorize.ok) return null;
  const name = health.vectorize.indexName || 'second-brain-vectors';
  return {
    title: t('upkeep.vectorizeBannerTitle', { name }),
    command: 'npx wrangler vectorize create ' + name + ' --dimensions=384 --metric=cosine',
    gui: t('upkeep.vectorizeBannerGui'),
  };
}

/* Build the inner HTML for the dashboard warning banner. Kept separate from the
 * DOM mutation so it can be unit-tested: it must escape every interpolated field. */
function vectorizeBannerHtml(banner) {
  return (
    '<strong>' + escHtml(banner.title) + '</strong> ' +
    '<details style="margin-top:6px"><summary style="cursor:pointer">' + escHtml(t('upkeep.vectorizeBannerHowToFix')) + '</summary>' +
    '<p style="margin:6px 0 2px">' + escHtml(t('upkeep.vectorizeBannerRunOnce')) + '</p>' +
    '<pre style="white-space:pre-wrap;background:rgba(0,0,0,0.25);padding:8px;border-radius:6px;margin:0">' + escHtml(banner.command) + '</pre>' +
    '<p style="margin:6px 0 0">' + escHtml(banner.gui) + '</p></details>'
  );
}

/* Mount, update, or remove the banner element against an injected document, and
 * push page content down by the banner height while it is shown. The `doc`
 * parameter lets this be unit-tested with a minimal fake document — no DOM
 * environment required. Returns the element, or null when removed. */
function syncVectorizeBanner(doc, banner) {
  let el = doc.getElementById('vectorize-banner');
  if (!banner) {
    if (el) el.remove();
    doc.body.style.paddingTop = '';
    return null;
  }
  if (!el) {
    el = doc.createElement('div');
    el.id = 'vectorize-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#7c2d12;color:#fff;padding:10px 16px;font-size:13px;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,0.25)';
    doc.body.appendChild(el);
  }
  el.innerHTML = vectorizeBannerHtml(banner);
  doc.body.style.paddingTop = (el.offsetHeight || 0) + 'px';
  return el;
}

/* Build the dashboard warning chip contents when this isolate has degraded to
 * unfiltered Vectorize queries (src/vectorize/scope.ts's per-isolate latch).
 * Returns null when filtering is supported or unknown (health absent, the
 * field absent, or `supported` is `true`/`null`), so a fresh isolate or a
 * transient fetch failure never raises a false alarm — and also returns null
 * when `health.team` is false, since the message names "layers", a concept a
 * solo (non-team) brain has no UI for at all.
 *
 * This is a RESULT-QUALITY signal, not a correctness one: every hydration is
 * already scoped at the SQL layer regardless of whether the Vectorize filter
 * itself is applied, so this must never be read as "data may be leaking
 * across workspaces" — it only means ranking quality is degraded because
 * foreign candidates can crowd out the caller's own before SQL filters them
 * back out. */
function workspaceFilterChip(health) {
  if (!health || !health.vectorize || !health.vectorize.workspaceFilter) return null;
  if (health.vectorize.workspaceFilter.supported !== false) return null;
  // Team vocabulary ("results are ranked across all layers") on a brain with
  // no layer UI at all would be a lie the solo owner cannot act on — every
  // other layer affordance in checkVectorize (nav.js) is gated on `team`, and
  // this one must be too, or a solo brain whose index rejects the filter gets
  // a permanent banner about a concept (layers) it does not have.
  if (!health.team) return null;
  return { title: t('nav.vectorizeFilterDegraded') };
}

/* Mount, update, or remove the workspace-filter chip against an injected
 * document. Styled the same way as the vectorize banner (syncVectorizeBanner)
 * and stacked directly under it — `offsetTop` is the height of whatever sits
 * above the chip (normally the banner's own offsetHeight, or 0 when there is
 * no banner) — so the two never overlap. Returns the element, or null when
 * removed. */
function syncWorkspaceFilterChip(doc, chip, offsetTop) {
  offsetTop = offsetTop || 0;
  let el = doc.getElementById('vectorize-filter-chip');
  if (!chip) {
    if (el) el.remove();
    doc.body.style.paddingTop = offsetTop ? offsetTop + 'px' : '';
    return null;
  }
  if (!el) {
    el = doc.createElement('div');
    el.id = 'vectorize-filter-chip';
    el.style.cssText = 'position:fixed;left:0;right:0;z-index:9998;background:#7c2d12;color:#fff;padding:8px 16px;font-size:12px;line-height:1.4;box-shadow:0 1px 4px rgba(0,0,0,0.25)';
    doc.body.appendChild(el);
  }
  el.style.top = offsetTop + 'px';
  el.textContent = chip.title;
  doc.body.style.paddingTop = (offsetTop + (el.offsetHeight || 0)) + 'px';
  return el;
}

/* ---- System tags ----------------------------------------------------------------------
 *
 * Which tags are the brain's own bookkeeping, and which are the person's words.
 *
 * This used to live in its own js/tags.js and serve display only, while the graph
 * clusterer below carried a second, shorter list of its own. The two drifted: the
 * clusterer's omitted `rolled-up` and had no machine-identifier rule, so tags hidden
 * from every chip in the app could still name a whole region of the graph.
 *
 * One copy, here, because utils.js is the file the unit tests require directly and the
 * file the dashboard loads first — so it is the one nothing else has to be loaded for.
 * js/tags.js is gone; its callers pick these up as globals exactly as before.
 */

/** Namespaces the Worker owns. Anything `prefix:value` shaped and reserved. */
const SYSTEM_TAG_PREFIXES = ['kind:', 'status:', 'volatility:', 'stale:']

/**
 * Bare markers the Worker writes: compression, pattern mining, dedupe, and the
 * contradiction pass (src/capture/entry.ts). Keep in step with PIPELINE_TAG_NAMES
 * in src/tags/system.ts.
 */
const SYSTEM_TAG_NAMES = new Set([
  'auto-pattern',
  'auto-insight',
  'synthesized',
  'rolled-up',
  'duplicate-candidate',
  'contradiction-resolved',
])

/**
 * Machine identifiers that a `#token` scan mistook for tags: `#5118` issue
 * references, `#fd540a` colour codes, `#0f3d3e` short commit SHAs.
 *
 * Deliberately narrow, because plenty of real tags look numeric at a glance:
 *   - a digit is required, so `facade`, `decade` and `added` stay tags;
 *   - six characters minimum, so `d1` and `v2` stay tags;
 *   - the whole string must be hex, so `12v-battery` and `14-day-plan` stay.
 */
function isMachineIdentifier(t) {
  if (/^\d+$/.test(t)) return true
  return /^[0-9a-f]{6,40}$/.test(t) && /\d/.test(t)
}

/**
 * Is this tag the brain talking to itself?
 *
 * v2.3 stops extracting machine identifiers at capture (src/text/hashtags.ts), but
 * rows written before that keep theirs, and no backfill is worth rewriting history
 * for. Hiding them cleans up the past without touching stored data.
 *
 * These stay visible in exactly one place — the memory detail view, labelled as what
 * they are. Everywhere else the answer to "what is this memory about?" should be the
 * user's own words, and no cluster in the graph should be named after one.
 */
function isSystemTag(tag) {
  if (typeof tag !== 'string') return true
  const t = tag.trim().toLowerCase()
  if (!t) return true
  if (SYSTEM_TAG_NAMES.has(t)) return true
  if (isMachineIdentifier(t)) return true
  return SYSTEM_TAG_PREFIXES.some((p) => t.startsWith(p))
}

/** The tags worth showing a person, in their original order. */
function humanTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter((t) => !isSystemTag(t))
}

/* ---- Graph view: topic clustering + static packed layout ------------------------------
 *
 * The dashboard graph groups memories into topic clusters derived from their tags, at two
 * levels: a broad outer category per node (n.cluster) and an optional shared sub-topic
 * within that category (n.sub). The layout is deterministic circle packing; nothing is
 * force-simulated or animated.
 */

/**
 * The "what kind of thing is this" tags every file in AI_Instructions/ tells an
 * assistant to write, alongside a topic tag. They answer a different question from a
 * topic tag but land in the same flat array, so without this the clusterer cannot
 * tell the two axes apart — and since one of them is on almost every memory, it wins
 * on frequency alone and names most of the graph.
 *
 * Second refusal rather than exclusion: a memory carrying nothing else really is
 * best described by one of these, and dropping them outright just promotes the
 * next-broadest topic tag and strands everything that had only an axis tag.
 *
 * Update this together with AI_Instructions/*.md.
 */
const GRAPH_AXIS_TAGS = new Set([
  'personal',
  'work',
  'task',
  'idea',
  'context',
  'claude-response',
  'codex-response',
])

/* Group graph nodes into topic clusters. Mutates each node, setting:
 *   n.cluster - the node's category: a tag, or the sentinel id '__loose__'
 *   n.sub     - a sub-topic tag shared with other members of the same category, or null
 *
 * `edges` is optional — [{ source, target, weight }] — and is used only by the
 * structural fallback below. Without it, nodes tags cannot place stay loose.
 *
 * Rules (all thresholds scale with the store, so this works for small and large stores):
 * - System tags never define a cluster or a sub-topic: see isSystemTag. Entries
 *   *tagged* auto-pattern or synthesized never arrive here at all — the Worker leaves
 *   them out of the node set (src/graph/traverse.ts).
 * - A tag must be shared by >= 2 nodes to define a cluster (no lone-tag singletons).
 * - Nodes join whichever of their tags is nearest sqrt(N) uses, measured in log space:
 *   a tag on nearly everything characterises nothing, a tag on one thing groups
 *   nothing, and the useful one is in between. Topic tags are considered first and
 *   the axis tags in GRAPH_AXIS_TAGS only if there is no topic tag to be had.
 * - Tiny categories (fewer than ~1% of nodes, floor 3) fold into the node's largest
 *   surviving alternative category, so the graph does not scatter into dozens of one-
 *   and two-node circles.
 * - Whatever the tags could not place then adopts the cluster its graph neighbours
 *   weigh most heavily toward, over three batched rounds. What is still unplaced is
 *   genuinely unconnected, and stays '__loose__'.
 * - Sub-topics: within a category, a non-category tag shared by >= 2 members that lives
 *   mostly inside the category (>= half its global uses) becomes a sub-group. A
 *   'microblog' tag concentrated in a 'bluesky' category qualifies; a cross-cutting
 *   'urgent' tag spread across many categories does not. Each member takes the
 *   dominant such tag. Note this fills in the opposite direction from the outer ring:
 *   the outer tag is a middling-frequency one and a *broader* tag becomes its
 *   sub-topic, where a naive reading would expect the narrower tag to nest.
 * - Ties break deterministically (nearer target, then higher share, then alphabetical).
 */
function assignGraphClusters(nodes, edges) {
  const SENTINELS = new Set(['__loose__']);
  const MIN_CLUSTER_SIZE = 2;
  const MIN_SUB = 2;
  const candidateTags = (n) => (n.tags || []).filter((t) => !isSystemTag(t) && !SENTINELS.has(t));
  const topicTags = (n) => candidateTags(n).filter((t) => !GRAPH_AXIS_TAGS.has(t));

  const df = new Map();
  for (const n of nodes) for (const t of new Set(candidateTags(n))) df.set(t, (df.get(t) || 0) + 1);

  // A tag on nearly every memory says nothing about any of them, and a tag on one
  // memory cannot group anything; the tag that characterises a memory sits between
  // those extremes. So pick the tag whose frequency is nearest an ideal cluster
  // size, measured in log space so being three times too big and three times too
  // small cost the same.
  //
  // sqrt(N) is the scale-free choice: it balances how many clusters there are
  // against how big each one is, and needs no constant fitted to a particular
  // brain — which matters, because this ships to brains of every size.
  //
  // The previous rule dropped any tag on at least half the store as too generic and
  // then took the *highest* frequency of whatever was left. Those two compose
  // badly: a brain's most informative tag is usually its most frequent, so it was
  // discarded for being popular, and the next most frequent is by construction the
  // vaguest thing remaining — which then labelled every memory carrying it.
  // Lowering the ceiling does not help; it only promotes the next vague tag down
  // the list. The ordering was the defect, not the threshold.
  const TARGET_CLUSTER_SIZE = Math.sqrt(nodes.length);
  const distanceFromTarget = (d) => Math.abs(Math.log(d / TARGET_CLUSTER_SIZE));

  // Outer category per node.
  for (const n of nodes) {
    const cands = [...new Set(candidateTags(n))];
    // Topic tags get first refusal; the axis tags are a fallback and never beat a
    // real topic. See GRAPH_AXIS_TAGS.
    let chosen = null;
    for (const tier of [[...new Set(topicTags(n))], cands]) {
      const eligible = tier.filter((t) => df.get(t) >= MIN_CLUSTER_SIZE);
      if (!eligible.length) continue;
      let best = eligible[0];
      let bestD = Infinity;
      for (const t of eligible) {
        const d = distanceFromTarget(df.get(t));
        if (d < bestD || (d === bestD && t < best)) {
          bestD = d;
          best = t;
        }
      }
      chosen = best;
      break;
    }
    n.cluster = chosen !== null ? chosen : '__loose__';
  }

  // Fold tiny categories into a larger alternative, or leave them loose.
  const MIN_OUTER = Math.max(3, Math.round(nodes.length / 100));
  const csz = new Map();
  for (const n of nodes) csz.set(n.cluster, (csz.get(n.cluster) || 0) + 1);
  for (const n of nodes) {
    if (SENTINELS.has(n.cluster) || csz.get(n.cluster) >= MIN_OUTER) continue;
    let alt = null;
    let altSz = MIN_OUTER - 1;
    for (const t of new Set(candidateTags(n))) {
      if (t === n.cluster) continue;
      const s = csz.get(t) || 0;
      if (s > altSz) {
        altSz = s;
        alt = t;
      }
    }
    n.cluster = alt || '__loose__';
  }

  // Let the graph place what the tags could not.
  //
  // Tags do not reach every memory. Measured across brain sizes, roughly a quarter
  // of nodes share no tag with anything else, and on a young brain — where almost
  // nothing has been tagged twice yet — it is most of them. Pooling those into a
  // category called "Other" labels a quarter of the canvas with a word that
  // describes nothing.
  //
  // The edges already know better: a memory linked mostly to cycling memories
  // belongs among them whatever its own tags say. So an unplaced node adopts the
  // cluster its neighbours weigh most heavily toward.
  //
  // Three rounds, so a chain of unplaced nodes resolves inward from whichever end
  // is anchored; beyond that the assignments have stopped moving on any real graph.
  // Each round reads the previous round's clusters and applies its own in a batch
  // at the end, so no node can see a decision made earlier in the same pass — which
  // is what keeps the result independent of the order nodes arrive in. Ties break
  // alphabetically for the same reason.
  const FALLBACK_ROUNDS = 3;
  const adjacency = new Map();
  for (const e of edges || []) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source).push([e.target, e.weight || 1]);
    adjacency.get(e.target).push([e.source, e.weight || 1]);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (let round = 0; round < FALLBACK_ROUNDS; round++) {
    const pending = [];
    for (const n of nodes) {
      if (n.cluster !== '__loose__') continue;
      const weightByCluster = new Map();
      for (const [otherId, w] of adjacency.get(n.id) || []) {
        const c = nodeById.get(otherId)?.cluster;
        if (!c || c === '__loose__') continue;
        weightByCluster.set(c, (weightByCluster.get(c) || 0) + w);
      }
      if (!weightByCluster.size) continue;
      let best = null;
      let bestW = -Infinity;
      for (const [c, w] of weightByCluster) {
        if (w > bestW || (w === bestW && c < best)) {
          bestW = w;
          best = c;
        }
      }
      pending.push([n, best]);
    }
    if (!pending.length) break;
    for (const [n, c] of pending) n.cluster = c;
  }

  // Sub-topic within each category.
  const groups = new Map();
  for (const n of nodes) {
    n.sub = null;
    if (SENTINELS.has(n.cluster)) continue;
    if (!groups.has(n.cluster)) groups.set(n.cluster, []);
    groups.get(n.cluster).push(n);
  }
  for (const [outer, members] of groups) {
    const wdf = new Map();
    for (const n of members) for (const t of new Set(candidateTags(n))) if (t !== outer) wdf.set(t, (wdf.get(t) || 0) + 1);
    for (const n of members) {
      let best = null;
      let bestW = -1;
      let bestDf = Infinity;
      for (const t of new Set(candidateTags(n))) {
        if (t === outer) continue;
        const w = wdf.get(t) || 0;
        if (w < MIN_SUB || w < 0.5 * df.get(t)) continue;
        const d = df.get(t);
        if (w > bestW || (w === bestW && d < bestDf) || (w === bestW && d === bestDf && t < best)) {
          bestW = w;
          bestDf = d;
          best = t;
        }
      }
      n.sub = best;
    }
  }
  return nodes;
}

/* Phyllotaxis (sunflower) offsets for k node centers inside a disc of radius R.
 * A single node sits at the exact center. Returns [{x, y}] relative to the disc center. */
function packGraphNodes(k, R) {
  const pts = [];
  for (let i = 0; i < k; i++) {
    const rr = k <= 1 ? 0 : R * Math.sqrt((i + 0.5) / k);
    const th = i * 2.399963229; // golden angle
    pts.push({ x: Math.cos(th) * rr, y: Math.sin(th) * rr });
  }
  return pts;
}

/* Pack circles of the given radii with no overlap (largest first, closest-to-center free
 * spot, at least `gap` between edges). Returns { centers, R }: each circle's center in
 * input order, and the bounding radius of the whole packing. Scale-invariant: the ring
 * step and angular resolution scale with each circle's size, so it packs tightly whether
 * the circles are tiny nodes or huge category discs. Deterministic. */
function packGraphCircles(radii, gap) {
  if (radii.length <= 1) return { centers: radii.length ? [{ x: 0, y: 0 }] : [], R: radii[0] || 0 };
  const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
  const placed = [];
  for (const it of order) {
    if (!placed.length) {
      placed.push({ x: 0, y: 0, r: it.r, i: it.i });
      continue;
    }
    // Scan concentric rings outward and take the first free spot, so each circle sits as
    // close to the center as it can without overlapping the ones already placed.
    let maxd = 0;
    for (const p of placed) maxd = Math.max(maxd, Math.hypot(p.x, p.y) + p.r);
    const reach = maxd + it.r + gap; // radius that provably clears every placed circle
    const step = Math.max(3, it.r * 0.5);
    let best = null;
    for (let rad = step; rad <= reach && !best; rad += step) {
      const samples = Math.max(8, Math.round((2 * Math.PI * rad) / Math.max(6, it.r)));
      for (let k = 0; k < samples && !best; k++) {
        const ang = (k / samples) * 2 * Math.PI + rad * 0.618; // rotate each ring to avoid seams
        const x = Math.cos(ang) * rad;
        const y = Math.sin(ang) * rad;
        let ok = true;
        for (const p of placed) {
          const need = it.r + p.r + gap;
          if ((x - p.x) ** 2 + (y - p.y) ** 2 < need * need) {
            ok = false;
            break;
          }
        }
        if (ok) best = { x, y };
      }
    }
    if (!best) {
      const ang = placed.length * 2.399963229;
      best = { x: Math.cos(ang) * reach, y: Math.sin(ang) * reach };
    }
    placed.push({ x: best.x, y: best.y, r: it.r, i: it.i });
  }
  const centers = [];
  let R = 0;
  for (const p of placed) {
    centers[p.i] = { x: p.x, y: p.y };
    R = Math.max(R, Math.hypot(p.x, p.y) + p.r);
  }
  return { centers, R };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escHtml, escAttr, toDateStr, parseRecallResult, normalizeEntry, vectorizeHealthBanner, vectorizeBannerHtml, syncVectorizeBanner, workspaceFilterChip, syncWorkspaceFilterChip, isSystemTag, humanTags, assignGraphClusters, packGraphNodes, packGraphCircles };
}
