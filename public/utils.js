function parseRecallResult(text) {
  const entries = [];
  text.split(/\n\n(?=\d+\.)/).filter(b => b.trim()).forEach(block => {
    const h = block.match(/^\d+\.\s+\[(.+?)\]\s+\((\d+)%[^)]*\)(?:\s+\([^)]*\))?(?:\s+\[[^\]]*\])?/);
    if (h) {
      const meta = h[1], score = parseInt(h[2]);
      let content = block.replace(/^\d+\.\s+\[.+?\]\s+\([^)]+\)(?:\s+\([^)]*\))?(?:\s+\[[^\]]*\])?\n?/, '').trim();
      let id = '';
      const idMatch = content.match(/^ID:\s+([^\n]+)\n?/);
      if (idMatch) {
        id = idMatch[1].trim();
        content = content.substring(idMatch[0].length).trim();
      }
      const parts = meta.split(' · ');
      const tagsStr = parts.slice(2).join(' · ');
      const tags = tagsStr ? tagsStr.replace(/^\[|\]$/g, '').split(', ').filter(Boolean) : [];
      entries.push({ score, id, content, date: parts[0] || '', source: parts[1] || '', tags });
    }
  });
  return entries;
}

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escAttr(s) { return String(s).replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 100); }
function toDateStr(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }

// Node/Vitest (CJS) — browser ignores this since `module` is undefined there
try { module.exports = { parseRecallResult, escHtml, escAttr, toDateStr }; } catch (_) {}
