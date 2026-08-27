import type { RecallMatch } from "./types";
import { formatAsOfQualifier } from "../memory/stale";
import { DEFAULTS, type Config } from "../config";
import { allowanceFor, snippetOf, truncationNote, type Snippet } from "./snippet";
import { computeCompoundStale } from "./compound-stale";
import type { CompoundStaleSignal } from "./types";

export function renderRecallText(
  matches: RecallMatch[],
  insight: string,
  opts: { full?: boolean; queryTokens?: string[]; config?: Readonly<Config>; compoundStale?: CompoundStaleSignal } = {},
): string {
  const contentById = new Map(matches.map(m => [m.id, m.content]));
  const blocks: string[] = [];
  const renderedMatches: RecallMatch[] = [];
  let used = 0;
  let omitted = 0;
  const cfg = opts.config ?? DEFAULTS;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    // Spelled month: this text is read by assistants, and a numeric date is
    // ambiguous between US and international order.
    const date = new Date(m.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
    const src = m.source ? ` · ${m.source}` : "";
    // Layer badge: only when it carries information. Single-user brains (no
    // team) and system-space rows stay unbadged rather than decorating every line.
    const layerLabel = m.workspace === "company"
      ? ` · shared${m.actorName ? ` · ${m.actorName}` : ""}`
      : m.workspace === "personal" ? " · personal" : "";
    const score = (m.score * 100).toFixed(0);
    const updateLabel = m.isUpdate ? " [updated]" : "";
    const hopLabel = m.hop > 0 ? ` [related · ${hopProvenance(m, contentById)}]` : "";
    const staleLabel = m.staleAsOf ? ` · ${formatAsOfQualifier(m.updatedAt)}` : "";

    const s: Snippet = opts.full
      ? { text: (m.content ?? "").trim(), truncated: false, fullLength: (m.content ?? "").length }
      : snippetOf(m.content, allowanceFor(i, m.score, cfg), { queryTokens: opts.queryTokens });
    const body = s.truncated ? `${s.text}${truncationNote(m.id, s)}` : s.text;
    const block = `${i + 1}. [${date}${src}${layerLabel}${tagList}] (${score}% match)${updateLabel}${hopLabel}${staleLabel}\nID: ${m.id}\n${body}`;

    // Stop once the budget is spent, but always return at least one match.
    if (!opts.full && blocks.length && used + block.length > cfg.RECALL_OUTPUT_BUDGET) {
      omitted = matches.length - i;
      break;
    }
    used += block.length;
    renderedMatches.push(m);
    blocks.push(block);
  }

  const compoundStale = opts.compoundStale ?? computeCompoundStale(renderedMatches);
  let prefix = "";
  if (compoundStale) {
    const oldest = new Date(compoundStale.oldestUpdatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    prefix = `**Staleness warning:** ${compoundStale.count} sources are marked stale as-of (oldest touch: ${oldest}). Verify before combining them into a single claim.\n\n---\n\n`;
  }

  let text = blocks.join("\n\n");
  if (omitted > 0) {
    text += `\n\n${omitted} more match${omitted > 1 ? "es" : ""} omitted to bound the response size. Narrow the query, or call get("<id>") for a specific memory.`;
  }
  const body = insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
  return prefix ? prefix + body : body;
}

// For a graph-expanded match, describe why it surfaced: who formed the edge
// (you vs. auto vs. system), when, and which memory it was reached from.
function hopProvenance(m: RecallMatch, contentById: Map<string, string>): string {
  const who =
    m.viaProvenance === "explicit" ? "you linked" :
    m.viaProvenance === "system" ? "system-linked" :
    "auto-linked";
  const when = m.viaLinkedAt ? ` · ${new Date(m.viaLinkedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : "";
  const fromContent = m.viaFrom ? contentById.get(m.viaFrom) : undefined;
  const from = fromContent ? ` · from "${snippet(fromContent)}"` : "";
  return `${who}${when}${from}`;
}

function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, " ");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
