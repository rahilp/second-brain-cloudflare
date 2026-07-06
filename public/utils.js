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
    title: 'Semantic search is disabled. The Vectorize index "' + name + '" was not found.',
    command: 'npx wrangler vectorize create ' + name + ' --dimensions=384 --metric=cosine',
    gui: 'Or grant the Workers Builds API token the account-level Vectorize Edit permission in the Cloudflare dashboard (My Profile, API Tokens), then redeploy so the build creates the index automatically.'
  };
}

/* Build the inner HTML for the dashboard warning banner. Kept separate from the
 * DOM mutation so it can be unit-tested: it must escape every interpolated field. */
function vectorizeBannerHtml(banner) {
  return (
    '<strong>' + escHtml(banner.title) + '</strong> ' +
    '<details style="margin-top:6px"><summary style="cursor:pointer">How to fix</summary>' +
    '<p style="margin:6px 0 2px">Run this once in your terminal:</p>' +
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

/* ---- Graph view: topic clustering + static packed layout ------------------------------
 *
 * The dashboard graph groups memories into topic clusters derived from their tags, at two
 * levels: a broad outer category per node (n.cluster) and an optional shared sub-topic
 * within that category (n.sub). The layout is deterministic circle packing; nothing is
 * force-simulated or animated.
 */

/* Group graph nodes into topic clusters by tag. Mutates each node, setting:
 *   n.cluster - the node's broad category: a tag, or one of the reserved sentinel ids
 *               '__other__' | '__untagged__' | '__autopattern__'
 *   n.sub     - a sub-topic tag shared with other members of the same category, or null
 *
 * Rules (all thresholds scale with the store, so this works for small and large stores):
 * - Reserved (kind:/status:) and system tags never define clusters; entries tagged
 *   'auto-pattern' get their own bucket instead of polluting Untagged.
 * - A tag must be shared by >= 2 nodes to define a cluster (no lone-tag singletons).
 * - Nodes join the broadest of their tags that still distinguishes them: a near-universal
 *   tag (on >= half the store) does not distinguish anything, so it is skipped in favor of
 *   more focused tags. This keeps one dominant tag from swallowing the whole graph. Only
 *   when every eligible tag is near-universal does the node fall back to the least
 *   universal one.
 * - Tiny categories (fewer than ~1% of nodes, floor 3) fold into the node's largest
 *   surviving alternative category, or Other, so the graph does not scatter into dozens
 *   of one- and two-node circles.
 * - Sub-topics: within a category, a non-category tag shared by >= 2 members that lives
 *   mostly inside the category (>= half its global uses) becomes a sub-group. A 'japan'
 *   tag concentrated in a 'travel' category qualifies; a cross-cutting 'urgent' tag
 *   spread across many categories does not. Each member takes the dominant such tag.
 * - Ties break deterministically (higher share, then more specific, then alphabetical).
 */
function assignGraphClusters(nodes) {
  const RESERVED_TAG = /^(kind|status):/;
  const SYSTEM_TAGS = new Set(['duplicate-candidate', 'synthesized', 'auto-pattern']);
  const SENTINELS = new Set(['__other__', '__untagged__', '__autopattern__']);
  const MIN_CLUSTER_SIZE = 2;
  const MIN_SUB = 2;
  const candidateTags = (n) => (n.tags || []).filter((t) => !RESERVED_TAG.test(t) && !SYSTEM_TAGS.has(t) && !SENTINELS.has(t));

  const df = new Map();
  for (const n of nodes) for (const t of new Set(candidateTags(n))) df.set(t, (df.get(t) || 0) + 1);
  const GENERIC_CEIL = Math.max(MIN_CLUSTER_SIZE + 1, Math.round(nodes.length * 0.5));

  // Outer category per node.
  for (const n of nodes) {
    if ((n.tags || []).includes('auto-pattern')) {
      n.cluster = '__autopattern__';
      continue;
    }
    const cands = [...new Set(candidateTags(n))];
    const eligible = cands.filter((t) => df.get(t) >= MIN_CLUSTER_SIZE);
    if (!eligible.length) {
      n.cluster = cands.length ? '__other__' : '__untagged__';
      continue;
    }
    const focused = eligible.filter((t) => df.get(t) < GENERIC_CEIL);
    if (focused.length) {
      let best = focused[0];
      let bestDf = -1;
      for (const t of focused) {
        const d = df.get(t);
        if (d > bestDf || (d === bestDf && t < best)) {
          bestDf = d;
          best = t;
        }
      }
      n.cluster = best;
    } else {
      let best = eligible[0];
      let bestDf = Infinity;
      for (const t of eligible) {
        const d = df.get(t);
        if (d < bestDf || (d === bestDf && t < best)) {
          bestDf = d;
          best = t;
        }
      }
      n.cluster = best;
    }
  }

  // Fold tiny categories into a larger alternative, or Other.
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
    n.cluster = alt || '__other__';
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
  module.exports = { escHtml, escAttr, toDateStr, parseRecallResult, normalizeEntry, vectorizeHealthBanner, vectorizeBannerHtml, syncVectorizeBanner, assignGraphClusters, packGraphNodes, packGraphCircles };
}
