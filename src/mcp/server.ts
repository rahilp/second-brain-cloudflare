import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveConfig } from "../config";
import { z } from "zod";
import type { Env } from "../env";
import { VECTORIZE_FIX_HINT } from "../constants";
import { buildEntryFilterQuery, captureEntry } from "../capture/entry";
import { appendToEntry, updateEntryContent } from "../capture/store";
import { applyStatus, forgetEntry } from "../capture/lifecycle";
import { moveEntry, restampVectorWorkspace } from "../capture/share";
import { auditEvent } from "../lib/audit";
import { lookupActorLabels, resolveActorFilter, resolveActorLabel } from "../lib/actors";
import { createEdge, deleteEdge, edgeLabel, isValidEdgeType, kindMismatchMessage, kindOfRow, kindsAllowEdge, CROSS_WORKSPACE_LINK_MESSAGE } from "../graph/edges";
import { EDGE_TYPES } from "../graph/types";
import { getConnections } from "../graph/traverse";
import type { Identity } from "../lib/identity";
import { assertCanEditContent, assertCanMutateEntry, getReadableEntry } from "../lib/entry-access";
import { listTeamWorkspaces } from "../lib/team-admin";
import { layerOf, scopeWhereForRead, scopeWrite, effectiveWriteTarget, readTeamParam, primaryCompanyWorkspaceId, type WriteContext } from "../lib/scope";
import { isManagedMirror, mirrorEditError } from "../integrations/mirror";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { STATUS_VALUES, type MemoryStatus } from "../memory/status";
import { VOLATILITY_VALUES, withVolatility, type Volatility } from "../memory/volatility";
import { recallEntries } from "../recall/search";
import { renderRecallText, memoryHeader } from "../recall/render";
import { RECALL_OUTPUT_BUDGET, SNIPPET_MAX_CHARS, snippetOf, truncationNote } from "../recall/snippet";

// Asking the calling model for this is the whole point: it has already read the content
// in order to decide to store it, so the judgment is free, and it is a far better
// classifier than the regex fallback in staleness/heuristic.ts, which abstains on most
// real content. Sent once per session as part of the tool schema rather than repeated in
// recall output, and worded to make abstaining the safe move — a wrong verdict is worse
// than none, because `state` and `volatile` earn a "verify before asserting" qualifier
// on every future recall.
const VOLATILITY_DESCRIPTION =
  "How likely is this to stop being true? "
  + "durable = never changes (a birthday, where someone grew up, something that already happened). "
  + "state = true for now but can move (an employer, a city, a current plan or priority). "
  + "volatile = true only briefly (a meeting, a deadline, this week's focus). "
  + "Omit it when you are unsure — no verdict is better than a wrong one.";

const volatilityParam = z
  .enum([...VOLATILITY_VALUES] as [string, ...string[]])
  .optional()
  .describe(VOLATILITY_DESCRIPTION);

// The read/write tool descriptions below are the only place this behaviour is
// specified. The server does no reranking, query rewriting, or duplicate
// classification on the model's behalf — the calling client already has the
// reasoning to judge results, retry a weak search, and decide append-vs-new, so
// the contract's job is to tell it how. Deliberately free of any assumption
// about what a particular brain contains: every filter a client is told to
// reach for comes from the user's own conversation or from metadata on a
// returned memory, never from a vocabulary baked in here.
const RECALL_DESCRIPTION =
  "Recall: semantically search your second brain for relevant notes and context. "
  + "Call recall automatically at the start of every conversation and every 3-4 messages.\n\n"
  + "EVALUATE, DON'T ASSUME. Ask for enough candidates to compare — topK 5 (the default) unless the task "
  + "justifies otherwise — then read the returned content and decide which memory actually answers the "
  + "question. Rank order and the (NN% match) figure are retrieval signals, not calibrated confidence that a "
  + "memory answers you: rank 1 is a candidate, not a guarantee.\n\n"
  + "RECOVER ONCE. If the results come back empty, off-topic, ambiguous, dominated by loosely related "
  + "memories, or missing something you expected to be there, make one more targeted recall before concluding "
  + "the information is not stored. Sharpen it with any of: a more specific query, the subject named "
  + "explicitly instead of a pronoun or a vague reference, tag, kind, after, before, hops.\n\n"
  + "CHOOSE ON FIT. Prefer the memory that most directly answers the question — not automatically the newest, "
  + "the highest-scoring, the longest, or a particular kind. All else equal: semantic memories are better for "
  + "durable facts, settled decisions, preferences, and current authoritative state; episodic memories are "
  + "better for a specific event, sequence, investigation, or point-in-time question; and a specific memory "
  + "that answers the question beats a broad summary that merely discusses the same topic. Kind and lifecycle "
  + "status are separate dimensions: among otherwise comparable memories a canonical one outranks a draft for "
  + "settled or authoritative information, but not when the question is precisely about what is tentative or "
  + "still being decided.\n\n"
  + "GRAPH. Raise hops to 1-2 when the question is about why something happened, how a decision evolved, "
  + "chronology, causes, outcomes, related decisions, or what came before or after something. Leave it at 0 "
  + "when direct matches already answer the question.\n\n"
  + "TRUNCATION. Long memories come back shortened to keep the response small: any result ending in a "
  + "[truncated …] marker is PARTIAL, so call get(id) before relying on its details or quoting it. Results "
  + "without that marker are complete.";

const GET_DESCRIPTION =
  "Get one memory in full by ID. recall and list_recent return bounded previews, and a result ending in a "
  + "[truncated …] marker is partial. Call get(id) before you answer, quote, or act on such a result whenever "
  + "the omitted part could materially change the answer — a fact, a number, a decision, a sequence, exact "
  + "wording, a status change, or a later update appended to the entry. You do not have to fetch every "
  + "truncated result, only the ones you are about to rely on. Get the ID from recall or list_recent.";

const CONNECTIONS_DESCRIPTION =
  "List the memories directly linked to a given entry (its 1-hop neighbors in the relationship graph). Use it "
  + "for targeted relationship exploration once recall has already identified a relevant memory and you need "
  + "what surrounds it: causal history, decision lineage, preceding or following developments, related events, "
  + "explicit links between memories. It returns an entry's neighbors regardless of your question, so it is "
  + "not a substitute for a sharper recall query — skip it when direct recall already answers the question. "
  + "Get the entry ID from recall or list_recent first.";

const REMEMBER_DESCRIPTION =
  "Store a distinct, durable idea, fact, decision, task, preference, event, or reusable observation in your "
  + "second brain. Call this automatically, without asking permission, whenever the user shares something "
  + "durable enough to be worth retrieving in a later conversation — a goal, a decision, a preference, a "
  + "commitment, a lasting piece of project or personal context. Passing conversational detail that will not "
  + "matter later does not need storing.\n\n"
  + "One memory per thing worth retrieving on its own. Before adding another memory about a subject you have "
  + "already stored, consider whether this is really an update to that memory: when it continues the same "
  + "thread — progress, a follow-up, a refinement, a later outcome — call append on the existing entry instead "
  + "of creating a near-duplicate.\n\n"
  + "VISIBILITY: on a team brain every memory lands in one of two layers. Personal = visible only to its "
  + "author. Company = visible to the whole team. If the user says \"share this\", \"the team should know\", "
  + "or similar, pass workspace: \"company\". If they say \"keep this private\", pass workspace: \"personal\". "
  + "With no workspace argument the member's configured default decides (personal unless their admin said "
  + "otherwise), so when policy matters to the user, be explicit. On a multi-team brain, call list_teams "
  + "first when the user wants something shared but has not named a team — present the team names and ask "
  + "which one if there is more than one, then pass that team's id as team. recall marks each result 'shared' or "
  + "'personal', and the share tool moves an existing memory between layers at any time. "
  + "Do not create a new durable memory for a repeated no-op observation, an "
  + "unchanged status, or a restatement of something already stored.\n\n"
  + "Do store separately when the information is genuinely its own retrieval target: a distinct event, a new "
  + "decision, a reusable insight, a task, an artifact, or anything you would later want to find on its own.";

const APPEND_DESCRIPTION =
  "Append new information to an existing memory. The original content is preserved and your addition is "
  + "stamped with today's date, so the entry keeps its history. Get the entry ID from recall or list_recent "
  + "first.\n\n"
  + "Use append for the continuing thread of a subject already stored: evolving project or task state, a "
  + "follow-up event, a later outcome attached to the original subject, a decision being refined, an ongoing "
  + "investigation, or recurring monitoring where something meaningfully changed. Prefer append over remember "
  + "whenever a new memory would substantially duplicate an existing continuing one.\n\n"
  + "Do not append unrelated information merely to avoid creating a new entry — if it is its own retrieval "
  + "target, call remember. To replace content that is simply no longer correct, use update.";

const UPDATE_DESCRIPTION =
  "Replace the full content of an existing memory. Use it when the prior content is no longer the correct "
  + "representation — a preference reversed, a decision overturned, a fact superseded. It is not the mechanism "
  + "for incremental history: use append when the earlier content still stands and you are adding to it. Get "
  + "the entry ID from recall or list_recent first.";

const LIST_RECENT_DESCRIPTION =
  "list_recent: List the most recent entries by date from your second brain. Use it to browse recent activity "
  + "or to locate an entry by time. It returns entries by recency, not by semantic relevance — when you want "
  + "memories that match a meaning, use recall. Long entries are shortened: a result ending in a [truncated …] "
  + "marker is PARTIAL, so call get(id) for its full text. "
  + "Pass actor to list only what one person wrote — their name as shown in the header, their user id, or \"me\". "
  + "Pass team (id from list_teams) with workspace:\"company\" to browse one team's shared layer.";

const LIST_TEAMS_DESCRIPTION =
  "List the shared teams you belong to, with display names and workspace ids. Call this before remember or "
  + "share with workspace:\"company\" when the user has not named a team — especially when more than one team "
  + "is returned. Present the names to the user and ask which team they mean when it matters. Use the id "
  + "(not the display name) as the team parameter on remember, share, recall, and list_recent.";

const SHARE_DESCRIPTION =
  "Move a memory between your private workspace and a shared team workspace. MOVE semantics: one canonical row; "
  + "edges follow it; audited. Only the entry's author or an admin can un-share. Call list_teams first when "
  + "sharing to company and the user has not named a team. Get the entry ID from recall or list_recent first.";

function formatTeamsList(
  teams: { id: string; name: string; memberCount: number }[],
  primaryId: string,
): string {
  if (!teams.length) {
    return "You are not on any shared team workspace. Use workspace:\"personal\" for private memories.";
  }
  const lines = teams.map((t, i) => {
    const primary = t.id === primaryId ? " [primary — used when team is omitted]" : "";
    const label = t.name || "Unnamed team";
    const members = t.memberCount === 1 ? "1 member" : `${t.memberCount} members`;
    return `${i + 1}. ${label} (id: ${t.id}, ${members})${primary}`;
  });
  return `Teams you can read and write:\n\n${lines.join("\n")}\n\nUse the id as the team argument when capturing, sharing, or searching one team.`;
}

/** Which layer a raw entries row is in, from the caller's point of view. */
const layerOfRow = (identity: Identity | undefined, row: Record<string, any>) =>
  layerOf(identity, row.workspace_id);

/**
 * Resolve author names for a page of rows, in one query, and only when a company
 * row is actually present.
 *
 * The name is information only on the shared layer — a personal row is the
 * reader's own by definition — so a listing with nothing shared on it must not
 * spend a subrequest to learn that. These tools run inside the same 50-subrequest
 * invocation budget as everything else.
 */
async function labelsForRows(
  env: Env,
  identity: Identity | undefined,
  rows: Record<string, any>[],
): Promise<(row: Record<string, any>) => string | null> {
  const company = rows.filter((r) => layerOfRow(identity, r) === "company");
  if (!company.length) return () => null;
  const map = await lookupActorLabels(env, company.map((r) => String(r.actor_id ?? "")));
  return (row) =>
    layerOfRow(identity, row) === "company"
      ? resolveActorLabel(String(row.actor_id ?? ""), map, {
          viewerId: identity?.userId,
          source: String(row.source ?? ""),
        })
      : null;
}

export function buildMcpServer(env: Env, ctx: ExecutionContext, identity?: Identity): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.0.0" });

  // Absent an Identity (direct construction in tests, or a caller that has not
  // been taught tenancy yet) every write below lands in the legacy owner space
  // and every read stays corpus-wide — byte-identical to pre-v3 behaviour.
  const writeCtx: WriteContext = identity
    ? { workspaceId: scopeWrite(identity), actorId: identity.userId }
    : { workspaceId: "", actorId: "" };

  // ── list_teams ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_teams",
    {
      description: LIST_TEAMS_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      if (!identity) {
        return { content: [{ type: "text", text: "Team listing requires an authenticated identity." }] };
      }
      if (!identity.companyWorkspaceIds.length) {
        return { content: [{ type: "text", text: formatTeamsList([], "") }] };
      }
      const teams = await listTeamWorkspaces(env, identity.companyWorkspaceIds);
      return {
        content: [{ type: "text", text: formatTeamsList(teams, primaryCompanyWorkspaceId(identity)) }],
      };
    },
  );

  // ── remember ────────────────────────────────────────────────────────────
  server.registerTool(
    "remember",
    {
      description: REMEMBER_DESCRIPTION,
      inputSchema: {
        content: z.string().describe("The idea, task, or note to store — one distinct item, written so it still makes sense on its own months from now"),
        tags: z.array(z.string()).optional().describe("Optional tags for filtering and later retrieval"),
        source: z.string().optional().describe("Origin: phone, browser, voice, claude"),
        volatility: volatilityParam,
        workspace: z.enum(["personal", "company"]).optional().describe("Where to store it: your private workspace (default) or the shared company layer"),
        team: z.string().optional().describe("When workspace is company, which team workspace — id from list_teams. Omit for your primary team."),
      },
    },
    async ({ content, tags, source, volatility, workspace, team }) => {
      // Folded into the tag list rather than threaded through captureEntry: tags are
      // already the carrier for every other reserved namespace (kind:, status:).
      // withVolatility clears the namespace case-insensitively before appending, so a
      // caller passing its own "volatility:"-prefixed tag alongside a conflicting enum
      // value cannot leave two verdicts on one entry. That filter has to stay
      // case-insensitive: captureEntry lowercases tags *after* this runs, so a
      // case-sensitive one let "Volatility:durable" through to become a second verdict,
      // and the injected one won.
      const baseTags = tags ?? [];
      const withVerdict = volatility ? withVolatility(baseTags, volatility as Volatility) : baseTags;
      const orgDefault = (await resolveConfig(env)).TEAM_DEFAULT_WORKSPACE;
      let targetCtx = writeCtx;
      if (identity) {
        const resolvedTarget = effectiveWriteTarget(identity, workspace, orgDefault);
        const teamRead = readTeamParam(team, identity, resolvedTarget);
        if (teamRead.error) {
          return { content: [{ type: "text", text: teamRead.error }] };
        }
        targetCtx = {
          workspaceId: scopeWrite(identity, resolvedTarget, teamRead.teamId),
          actorId: identity.userId,
        };
      }
      const result = await captureEntry(content, withVerdict, source ?? "claude", env, ctx, undefined, targetCtx);
      if (identity && result.status !== "blocked") {
        auditEvent(env, ctx, {
          entryId: result.id,
          actorId: identity.userId,
          event: result.status === "stored" || result.status === "flagged" ? "created" : "updated",
          payload: { captureStatus: result.status },
        });
      }
      if (result.status === "blocked") {
        return { content: [{ type: "text", text: `Duplicate detected (${(result.score * 100).toFixed(0)}% match) — not stored. Existing entry ID: ${result.matchId}` }] };
      }
      if (result.status === "contradiction") {
        return { content: [{ type: "text", text: `Stored. ID: ${result.id} — resolved contradiction with entry ${result.resolvedConflict}${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "contradiction_protected") {
        return { content: [{ type: "text", text: `Stored as draft (ID: ${result.id}) — conflicts with a canonical memory (${result.canonicalId}), which was kept${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "replaced") {
        return { content: [{ type: "text", text: `Memory updated — new content replaced outdated entry (ID: ${result.id}).` }] };
      }
      if (result.status === "merged") {
        return { content: [{ type: "text", text: `Memories merged — combined into existing entry (ID: ${result.id}).` }] };
      }
      if (result.status === "flagged") {
        return { content: [{ type: "text", text: `Stored with ID: ${result.id} — note: similar entry exists (${(result.score * 100).toFixed(0)}% match, ID: ${result.matchId}). Tagged as duplicate-candidate.` }] };
      }
      return { content: [{ type: "text", text: `Stored. ID: ${result.id}` }] };
    }
  );

  // ── append ───────────────────────────────────────────────────────────────
  server.registerTool(
    "append",
    {
      description: APPEND_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("Entry ID to append to — from recall or list_recent"),
        addition: z.string().describe("The new information to add to the existing entry — what actually changed, not a restatement of what is already there"),
        volatility: volatilityParam,
      },
    },
    async ({ id, addition, volatility }) => {
      const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, content, tags, source");

      if (!row) {
        return {
          content: [{ type: "text", text: `No entry found with ID: ${id}` }],
        };
      }

      const denied = assertCanEditContent(identity, row);
      if (denied) {
        return { content: [{ type: "text", text: denied.message }] };
      }

      const existingContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const source = row.source as string;
      const a = addition.trim();

      if (!a) {
        return {
          content: [{ type: "text", text: "Addition cannot be empty." }],
        };
      }

      if (await isManagedMirror(source, env)) {
        return { content: [{ type: "text", text: mirrorEditError(source) }] };
      }

      let indexed: boolean;
      try {
        indexed = await appendToEntry(env, id, existingContent, a, tags, source, await resolveConfig(env), volatility as Volatility | undefined, writeCtx);
      } catch (e) {
        console.error("Append failed:", e);
        return {
          content: [{ type: "text", text: `Append failed: ${(e as Error).message}` }],
        };
      }

      if (identity) {
        auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "appended" });
      }

      return {
        content: [{
          type: "text",
          text: `Appended to entry ${id}. The original content is preserved and your update has been added with today's date.`
            + (indexed ? "" : ` Note: it was not indexed for semantic search because the Vectorize index is missing, so it is findable by keyword only. Fix: ${VECTORIZE_FIX_HINT}.`),
        }],
      };
    }
  );

  // ── update ───────────────────────────────────────────────────────────────
  server.registerTool(
    "update",
    {
      description: UPDATE_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("Entry ID to update — from recall or list_recent"),
        content: z.string().describe("The new content to replace the existing entry with"),
        volatility: volatilityParam,
      },
    },
    async ({ id, content, volatility }) => {
      const newContent = content.trim();
      if (!newContent) {
        return { content: [{ type: "text", text: "Content cannot be empty." }] };
      }

      // Refuse before anything is written — same guard, same read, as POST /update.
      const row = await getReadableEntry(env, identity, id, "id, workspace_id, actor_id, source");

      if (!row) {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      const denied = assertCanEditContent(identity, row);
      if (denied) {
        return { content: [{ type: "text", text: denied.message }] };
      }

      if (await isManagedMirror(row.source as string, env)) {
        return { content: [{ type: "text", text: mirrorEditError(row.source as string) }] };
      }

      const result = await updateEntryContent(env, id, newContent, await resolveConfig(env), volatility as Volatility | undefined, undefined, writeCtx);

      // Only reachable if the entry was deleted between the guard read and the write.
      if (result.status === "not_found") {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      // Fails closed (#212): nothing was written, so the reply must not claim otherwise.
      // This tool used to report success here while leaving the index pointing at the old
      // text, and no repair path could see it — /vectorize-pending and /stats both look for
      // an empty vector_ids, which a mis-indexed entry does not have (#289).
      if (result.status === "reembed_failed") {
        return { content: [{ type: "text", text: `Couldn't update entry ${id}: search re-index failed. Your memory is unchanged — please try again.` }] };
      }

      if (identity && result.status === "updated") {
        auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "updated" });
      }

      if (!result.vectorIds) {
        return {
          content: [{
            type: "text",
            text: `Updated entry ${id}. Note: it was not re-indexed for semantic search because the Vectorize index is missing — the previous index is kept and it is still findable by keyword. Fix: ${VECTORIZE_FIX_HINT}.`,
          }],
        };
      }

      return {
        content: [{ type: "text", text: `Updated entry ${id}. Re-embedded as ${result.vectorIds.length} vector(s).` }],
      };
    }
  );

  // ── set_status ─────────────────────────────────────────────────────────────
  server.registerTool(
    "set_status",
    {
      description: "Set a memory's lifecycle status. 'canonical' = confirmed/authoritative (protected from auto-overwrite), 'draft' = tentative, 'deprecated' = no longer accurate (removed from recall, kept for audit). Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID — from recall or list_recent"),
        status: z.enum([...STATUS_VALUES] as [string, ...string[]]).describe("canonical | draft | deprecated"),
      },
    },
    async ({ id, status }) => {
      const row = await getReadableEntry(env, identity, id);
      if (!row) return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      const denied = assertCanMutateEntry(identity, row);
      if (denied) return { content: [{ type: "text", text: denied.message }] };

      const ok = await applyStatus(id, status as MemoryStatus, env);
      if (!ok) return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      if (identity) {
        auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "status_changed", payload: { status } });
      }
      return { content: [{ type: "text", text: status === "deprecated" ? `Entry ${id} deprecated — removed from recall, kept for audit.` : `Entry ${id} marked ${status}.` }] };
    }
  );

  // ── share ────────────────────────────────────────────────────────────────
  server.registerTool(
    "share",
    {
      description: SHARE_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("Entry ID — from recall or list_recent"),
        workspace: z.enum(["personal", "company"]).optional().describe("Target layer, company by default"),
        team: z.string().optional().describe("When workspace is company, which team workspace — id from list_teams. Omit for your primary team."),
      },
    },
    async ({ id, workspace, team }) => {
      if (!identity) return { content: [{ type: "text", text: "Sharing requires an authenticated team identity." }] };
      const target = workspace ?? "company";
      const teamRead = readTeamParam(team, identity, target);
      if (teamRead.error) return { content: [{ type: "text", text: teamRead.error }] };
      const result = await moveEntry(id, target, env, identity, teamRead.teamId);
      if (result.status === "not_found") return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      if (result.status === "forbidden") return { content: [{ type: "text", text: `Only the entry's author or an admin can un-share ${id}.` }] };
      if (result.status === "no_change") return { content: [{ type: "text", text: `Entry ${id} is already in the ${workspace ?? "company"} workspace.` }] };
      auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: result.status, payload: { workspaceId: result.workspaceId } });
      // After the audit event, before the response — see moveEntry's own
      // comment: the D1 move is already committed, so a Vectorize outage
      // here costs only this cosmetic ranking follow-up.
      ctx.waitUntil(restampVectorWorkspace(env, result.vectorIds, result.workspaceId));
      return { content: [{ type: "text", text: `Entry ${id} ${result.status} — now in the ${workspace ?? "company"} workspace.` }] };
    }
  );

  // ── recall ───────────────────────────────────────────────────────────────
  server.registerTool(
    "recall",
    {
      description: RECALL_DESCRIPTION,
      inputSchema: {
        query: z.string().describe("Natural language search query. Say what the topic is and what you are trying to do with it, and name the subject explicitly — resolve references like \"it\", \"that project\", or \"the last one\" from the conversation before querying"),
        topK: z.number().int().min(1).max(20).default(5).describe("Number of results. 5 (the default) gives enough candidates to compare before choosing; raise it to survey a topic, lower it only when a single exact hit is all you need"),
        tag: z.string().optional().describe("Filter by a specific tag. Use a tag the user named or one you saw on a returned memory — a guessed tag that does not exist in this brain returns nothing"),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp. Useful for narrowing a recovery search to a period the conversation identified"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp. Useful for narrowing a recovery search to a period the conversation identified"),
        kind: z.enum([...KIND_VALUES] as [string, ...string[]]).optional().describe("Filter to episodic (events) or semantic (facts/knowledge). Useful as a recovery filter when a mixed result set buried the kind you needed"),
        hops: z.number().int().min(0).max(3).default(0).describe("Graph expansion depth: 0 = direct matches only (default); 1–2 also surfaces related memories linked in the graph. Raise it for why/how, chronology, causes, outcomes, or what came before or after; leave it at 0 when direct matches already answer the question"),
        workspace: z.enum(["personal", "company"]).optional().describe("Restrict the search to one layer: personal or the shared company layer. Omit to search both — the default, and right for most questions"),
        team: z.string().optional().describe("When workspace is company, restrict to one team — id from list_teams"),
      },
    },
    async ({ query, topK, tag, after, before, kind, hops, workspace, team }) => {
      const teamRead = identity ? readTeamParam(team, identity, workspace) : {};
      if (teamRead.error) return { content: [{ type: "text", text: teamRead.error }] };
      const cfg = await resolveConfig(env);
      const { matches, insight, semanticUnavailable, queryTokens, compoundStale } = await recallEntries({ query, topK, tag, after, before, kind: kind as MemoryKind | undefined, hops, synthesize: false }, env, ctx, cfg, { identity, workspaceFilter: workspace, teamId: teamRead.teamId });

      const notice = semanticUnavailable
        ? `Note: semantic search is unavailable because the Vectorize index is missing, so these are keyword matches only. Fix: ${VECTORIZE_FIX_HINT}.\n\n`
        : "";

      if (!matches.length) {
        return { content: [{ type: "text", text: notice + "Nothing found matching that query." }] };
      }

      return { content: [{ type: "text", text: notice + renderRecallText(matches, insight, { queryTokens, config: cfg, compoundStale }) }] };
    }
  );

  // ── list_recent ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_recent",
    {
      description: LIST_RECENT_DESCRIPTION,
      inputSchema: {
        n: z.number().int().min(1).max(50).default(10),
        tag: z.string().optional(),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
        workspace: z.enum(["personal", "company"]).optional().describe("Restrict the listing to one layer: personal or the shared company layer. Omit to list both"),
        team: z.string().optional().describe("When workspace is company, restrict to one team — id from list_teams"),
        actor: z.string().optional().describe('Only entries written by one person: their display name as it appears in the header, their user id, or "me" for your own'),
      },
    },
    async ({ n, tag, after, before, workspace, team, actor }) => {
      const teamRead = identity ? readTeamParam(team, identity, workspace) : {};
      if (teamRead.error) return { content: [{ type: "text", text: teamRead.error }] };
      // The same author filter GET /list takes, through the same resolver, so a
      // name means the same thing on both surfaces. An identity-less caller has
      // no roster to resolve a name against and no actor_id worth trusting, so
      // `actor` is ignored outright for it — the byte-identical pre-tenancy
      // behaviour the scoping below keeps too. A name nobody on the team answers
      // to is a text answer rather than a thrown error: this tool's contract is
      // a text answer, and "no one matches that" is one.
      // Trimmed here so the two surfaces agree on blank input: GET /list reads
      // `?actor=` through the same `trim()` and treats what is left of a
      // whitespace-only value as no filter at all. Without this, the same blank
      // meant "everything" over HTTP and "no one matches that" over MCP.
      const actorQuery = actor?.trim();
      let actorId: string | undefined;
      if (actorQuery && identity) {
        const resolved = await resolveActorFilter(env, identity, actorQuery);
        if (!resolved.ok) return { content: [{ type: "text", text: `${resolved.error}.` }] };
        actorId = resolved.actorId;
      }
      // Same inline scoping as GET /list (src/routes/recall.ts): the filter
      // builder has no hook of its own, and its SQL always ends in ORDER BY.
      // workspace_id and actor_id come back so the header can say which layer a
      // row is in and who wrote it — the same two facts recall reports.
      let { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before, actor: actorId });
      if (identity) {
        const scope = scopeWhereForRead(identity, { layer: workspace, teamId: teamRead.teamId });
        sql = sql.includes("WHERE")
          ? sql.replace(" ORDER BY", ` AND ${scope.clause} ORDER BY`)
          : sql.replace(" ORDER BY", ` WHERE ${scope.clause} ORDER BY`);
        bindings = [...bindings.slice(0, -1), ...scope.bindings, ...bindings.slice(-1)];
      }
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();

      if (!results.length) {
        return { content: [{ type: "text", text: "No entries found." }] };
      }

      // Same size discipline as recall: browsing should not dump every entry in
      // full. Oversized rows are cut and marked so the caller can fetch them.
      const budgetCfg = await resolveConfig(env);
      const blocks: string[] = [];
      let used = 0;
      let omitted = 0;
      const rows = results as Record<string, any>[];
      // One lookup for the page, and only when a company row is actually on it —
      // a personal-only listing must not spend a subrequest naming nobody.
      const labels = await labelsForRows(env, identity, rows);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        const s = snippetOf(row.content as string, (await resolveConfig(env)).SNIPPET_MAX_CHARS);
        const body = s.truncated ? `${s.text}${truncationNote(row.id as string, s)}` : s.text;
        const block = `${i + 1}. [${memoryHeader({
          createdAt: row.created_at as number,
          source: row.source as string,
          tags,
          workspace: layerOfRow(identity, row),
          actorName: labels(row),
        })}]\nID: ${row.id as string}\n${body}`;
        if (blocks.length && used + block.length > budgetCfg.RECALL_OUTPUT_BUDGET) {
          omitted = rows.length - i;
          break;
        }
        used += block.length;
        blocks.push(block);
      }
      let text = blocks.join("\n\n");
      if (omitted > 0) text += `\n\n${omitted} more entr${omitted > 1 ? "ies" : "y"} omitted to bound the response size. Lower n, or call get("<id>").`;

      return { content: [{ type: "text", text }] };
    }
  );

  // ── get ──────────────────────────────────────────────────────────────────
  // The fetch half of snippet-first recall: recall/list_recent return bounded
  // previews, and this returns one memory in full on demand.
  server.registerTool(
    "get",
    {
      description: GET_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
      },
    },
    async ({ id }) => {
      const scope = identity ? scopeWhereForRead(identity) : null;
      const row = await env.DB.prepare(
        // scope-exempt: identity-less branch: production MCP always resolves an identity (src/mcp/handler.ts); this arm is unit fixtures only
        `SELECT id, content, tags, source, created_at, workspace_id, actor_id FROM entries WHERE id = ?${scope ? ` AND ${scope.clause}` : ""}`
      ).bind(...(scope ? [id, ...scope.bindings] : [id])).first() as Record<string, any> | null;
      if (!row) {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      // get is the tool an agent calls before acting on a memory, so it is the
      // one that can least afford to omit "this is shared, and someone else
      // wrote it".
      const labels = await labelsForRows(env, identity, [row]);
      return {
        content: [{ type: "text", text: `[${memoryHeader({
          createdAt: row.created_at as number,
          source: row.source as string,
          tags,
          workspace: layerOfRow(identity, row),
          actorName: labels(row),
        })}]\nID: ${row.id}\n${row.content}` }],
      };
    }
  );

  // ── forget ───────────────────────────────────────────────────────────────
  server.registerTool(
    "forget",
    {
      description: "Permanently delete an entry from your second brain by ID. Only call when the user explicitly asks to delete something. Confirm the entry ID using recall or list_recent first. This action cannot be undone.",
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
      },
    },
    async ({ id }) => {
      const row = await getReadableEntry(env, identity, id);
      if (!row) return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      const denied = assertCanMutateEntry(identity, row);
      if (denied) return { content: [{ type: "text", text: denied.message }] };

      const result = await forgetEntry(id, env);
      if (result.status === "not_found") {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }
      if (identity) {
        auditEvent(env, ctx, { entryId: id, actorId: identity.userId, event: "deleted", payload: { deletedVectors: result.vectorCount } });
      }
      return { content: [{ type: "text", text: `Deleted entry ${id} and ${result.vectorCount} vector(s)` }] };
    }
  );

  // ── link ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "link",
    {
      description: "Create an explicit relationship link between two memories by ID (e.g. connect a decision to its outcome). Get the IDs from recall or list_recent first.",
      inputSchema: {
        source_id: z.string().describe("Source entry ID"),
        target_id: z.string().describe("Target entry ID"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).default("relates_to").describe(
          "How the memories relate, read as: SOURCE <type> TARGET. Direction is not cosmetic — source_id is the end the arrow points FROM. "
          + "relates_to: they belong together, no direction implied (the default; use it when unsure). "
          + "caused_by: the source happened BECAUSE of the target. "
          + "decided: the source is a decision the target carries out or reflects; both memories must be episodic. "
          + "follows: the source came AFTER the target in the same line of thought; both memories must be episodic. "
          + "supersedes: the source replaces the target, and the target is treated as deprecated — use only when the older memory is genuinely wrong now. "
          + "drawn_from: the source was derived from the target, as an insight is from its sources.",
        ),
      },
    },
    async ({ source_id, target_id, type }) => {
      // tags ride along on the reads this tool already makes, for the kind gate below.
      const source = await getReadableEntry(env, identity, source_id, "id, workspace_id, actor_id, tags");
      if (!source) return { content: [{ type: "text", text: `No entry found with ID: ${source_id}` }] };
      const target = await getReadableEntry(env, identity, target_id, "id, workspace_id, actor_id, tags");
      if (!target) return { content: [{ type: "text", text: `No entry found with ID: ${target_id}` }] };
      // Same rule and same sentence as POST /link — see CROSS_WORKSPACE_LINK_MESSAGE.
      if (source.workspace_id !== target.workspace_id) {
        return { content: [{ type: "text", text: CROSS_WORKSPACE_LINK_MESSAGE }] };
      }
      // Same gate as POST /link, same sentence — see kindMismatchMessage.
      if (isValidEdgeType(type) && !kindsAllowEdge(type, kindOfRow(source), kindOfRow(target))) {
        return { content: [{ type: "text", text: kindMismatchMessage(type) }] };
      }

      const edge = await createEdge(source_id, target_id, type, { provenance: "explicit", weight: 1.0, workspaceId: source.workspace_id }, env);
      if (!edge) return { content: [{ type: "text", text: "Cannot link an entry to itself." }] };
      return { content: [{ type: "text", text: `Linked ${edge.source_id} → ${edge.target_id} (${edgeLabel(edge.type)}).` }] };
    }
  );

  // ── unlink ───────────────────────────────────────────────────────────────
  server.registerTool(
    "unlink",
    {
      description: "Remove a relationship link between two memories by ID. Use when a link is incorrect or no longer relevant. Get the IDs from recall or connections first.",
      inputSchema: {
        source_id: z.string().describe("Source entry ID"),
        target_id: z.string().describe("Target entry ID"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).optional().describe("Only remove this relationship type; omit to remove all links between the pair"),
      },
    },
    async ({ source_id, target_id, type }) => {
      const source = await getReadableEntry(env, identity, source_id);
      if (!source) return { content: [{ type: "text", text: `No entry found with ID: ${source_id}` }] };
      const target = await getReadableEntry(env, identity, target_id);
      if (!target) return { content: [{ type: "text", text: `No entry found with ID: ${target_id}` }] };

      const deleted = await deleteEdge(source_id, target_id, type, env);
      if (!deleted) return { content: [{ type: "text", text: "No link found between those entries." }] };
      return { content: [{ type: "text", text: `Removed ${deleted} link(s) between ${source_id} and ${target_id}.` }] };
    }
  );

  // ── connections ──────────────────────────────────────────────────────────
  server.registerTool(
    "connections",
    {
      description: CONNECTIONS_DESCRIPTION,
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
        type: z.enum(Object.keys(EDGE_TYPES) as [string, ...string[]]).optional().describe("Filter to a single relationship type"),
      },
    },
    async ({ id, type }) => {
      const connections = await getConnections(id, type, env, await resolveConfig(env), identity);
      if (!connections.length) {
        return { content: [{ type: "text", text: `No connections found for ${id}.` }] };
      }
      const text = connections
        .map(c => {
          const who = c.provenance === "explicit" ? "you linked" : c.provenance === "system" ? "system-linked" : "auto-linked";
          const when = c.linkedAt ? ` · ${new Date(c.linkedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : "";
          return `- (${c.label} · ${who}${when}) ${c.id}: ${c.content.slice(0, 120)}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}
