import type { RecallMatch } from "./types";

export function renderRecallText(matches: RecallMatch[], insight: string): string {
  const contentById = new Map(matches.map(m => [m.id, m.content]));
  const text = matches.map((m, i) => {
    const date = new Date(m.createdAt).toLocaleDateString();
    const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    const src = m.source ? ` · ${m.source}` : "";
    const score = (m.score * 100).toFixed(0);
    const updateLabel = m.isUpdate ? " [updated]" : "";
    const hopLabel = m.hop > 0 ? ` [related · ${hopProvenance(m, contentById)}]` : "";
    return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}${hopLabel}\nID: ${m.id}\n${m.content}`;
  }).join("\n\n");
  return insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
}

// For a graph-expanded match, describe why it surfaced: who formed the edge
// (you vs. auto vs. system), when, and which memory it was reached from.
function hopProvenance(m: RecallMatch, contentById: Map<string, string>): string {
  const who =
    m.viaProvenance === "explicit" ? "you linked" :
    m.viaProvenance === "system" ? "system-linked" :
    "auto-linked";
  const when = m.viaLinkedAt ? ` · ${new Date(m.viaLinkedAt).toLocaleDateString()}` : "";
  const fromContent = m.viaFrom ? contentById.get(m.viaFrom) : undefined;
  const from = fromContent ? ` · from "${snippet(fromContent)}"` : "";
  return `${who}${when}${from}`;
}

function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
