import type { RecallMatch } from "./types";
import { DEFAULTS, type Config } from "../config";
import { allowanceFor, RECALL_OUTPUT_BUDGET, snippetOf, truncationNote, type Snippet } from "./snippet";

export function renderRecallText(
  matches: RecallMatch[],
  insight: string,
  opts: { full?: boolean; queryTokens?: string[]; config?: Readonly<Config> } = {},
): string {
  const contentById = new Map(matches.map(m => [m.id, m.content]));
  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const date = new Date(m.createdAt).toLocaleDateString();
    const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    const src = m.source ? ` · ${m.source}` : "";
    const score = (m.score * 100).toFixed(0);
    const updateLabel = m.isUpdate ? " [updated]" : "";
    const hopLabel = m.hop > 0 ? ` [related · ${hopProvenance(m, contentById)}]` : "";

    const s: Snippet = opts.full
      ? { text: (m.content ?? "").trim(), truncated: false, fullLength: (m.content ?? "").length }
      : snippetOf(m.content, allowanceFor(i, m.score, opts.config), { queryTokens: opts.queryTokens });
    const body = s.truncated ? `${s.text}${truncationNote(m.id, s)}` : s.text;
    const block = `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}${hopLabel}\nID: ${m.id}\n${body}`;

    // Stop once the budget is spent, but always return at least one match.
    if (!opts.full && blocks.length && used + block.length > (opts.config ?? DEFAULTS).RECALL_OUTPUT_BUDGET) {
      omitted = matches.length - i;
      break;
    }
    used += block.length;
    blocks.push(block);
  }

  let text = blocks.join("\n\n");
  if (omitted > 0) {
    text += `\n\n${omitted} more match${omitted > 1 ? "es" : ""} omitted to bound the response size. Narrow the query, or call get("<id>") for a specific memory.`;
  }
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
