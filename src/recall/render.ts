import type { RecallMatch } from "./types";

export function renderRecallText(matches: RecallMatch[], insight: string): string {
  const text = matches.map((m, i) => {
    const date = new Date(m.createdAt).toLocaleDateString();
    const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    const src = m.source ? ` · ${m.source}` : "";
    const score = (m.score * 100).toFixed(0);
    const updateLabel = m.isUpdate ? " [updated]" : "";
    const hopLabel = m.hop > 0 ? ` [related · ${m.hop} hop${m.hop > 1 ? "s" : ""}]` : "";
    return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}${hopLabel}\nID: ${m.id}\n${m.content}`;
  }).join("\n\n");
  return insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
}
