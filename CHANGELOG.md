# Changelog

All notable changes to Second Brain are documented here. Version numbers match `SB_VERSION` in `src/env.ts` and the desktop app release.

## [3.0.0] — Team Edition

### Shipped in v3.0.0

**Team Edition (single shared team per brain)**

Second Brain can now be a team's memory without stopping being yours. Every person gets a **Personal** workspace that nobody else can read, plus a **Shared** layer visible to the team, on one Worker with no separate team deployment.

- Personal and Shared (`company`) memory layers; personal memories are private by default and only enter the Shared layer when someone deliberately shares them.
- Member management with invite tokens, last-seen timestamps, and per-member capture visibility set as an admin policy with per-member override.
- An owner can declare a brain a team before anyone is invited; real membership overrules any stored team mode.
- Sharing moves one canonical memory rather than making a copy. Its author remains visible, and only the author or an admin can edit, delete, or un-share it.
- Author lock prevents a team member from editing or deleting another member's memories.
- Team directory: a member sees the team, its people, and their own capture default.
- A member can set their own capture default; the composer's layer control is explained to a new team member with a dismissible onboarding coach mark.
- Capture-default controls are pinned to their own keys and shared through one select helper.
- Dashboard team panel: members, roster, activity, rename team, share and un-share from the UI. The roster no longer holds the memories list hostage.
- Dashboard: memories multi-select with bulk share and a shared-badge/payer layer chip; admin activity section with CSV export.
- Team-scoped insights with an optional company weekly insight pass (off by default) and a per-team toggle; the insight novelty floor is keyed to the workspace.
- Integration lines and provenance are gated on team mode, and a member is told who connected an integration and where it lands.
- MCP and REST tools accept optional `workspace` (`personal` | `company`) on reads and writes.
- MCP `list_teams` and `GET /team/workspaces` list the teams a caller belongs to (v3.0.0 returns one team per brain).

**Security and tenancy**

- Identity is resolved at the API edge, and every read and write is scoped to the caller's workspace and membership.
- Personal memories are invisible to the team; shared memories are visible to all members; scoped recall searches only what the caller can see.
- Graph walks cannot traverse a memory the reader cannot open.
- Admin reads are scoped so an admin sees only the team data they are authorized to manage.
- Vectorize vectors are stamped with `workspace_id` and queries filter by the readable set; vectors are re-stamped on share and un-share so they stay in the correct layer.
- The app asks the brain who is holding the token instead of guessing from a Cloudflare login.
- OAuth replaces query-string tokens for MCP (v3); query-string authentication is refused.
- Imported entries and edges carry the importer's workspace.
- Explicit links stay within one layer and are filed where their author can see them.
- Multi-team write ambiguity is resolved with an optional `team` workspace id on capture, share, recall, list, graph, and digest.

**Admin and compliance**

- `GET /team/activity`: a single paged feed merging the `admin_events` and `entry_events` audit trails.
- Every team administration action (add/remove member, share/unshare, rename, capture defaults) is recorded in `admin_events` with timestamp and actor.
- Integration connects and disconnects are recorded in `admin_events`.
- Team configuration select helpers reload on change; team-insights toggle is routed through the shared config select.
- Admin activity body guard and bulk bar team gate enforced.
- Health endpoint surfaces Vectorize degradation status.
- Member last-seen timestamps visible to admins.

**Scope and isolation hardening**

- Scope checker rebuilt with an allowlist of safe clause shapes; evasive patterns (negation, wrapped SQL, dotted table names) are now rejected.
- Outer-join detection prevents scope clauses that reduce to a nulled column.
- Graph subrequest bound re-pinned to match current scope-checker output.
- Tag summaries scoped at the row level, not the title.
- Activity feed memory arm scoped to the row.
- Negation and wrapped SQL are no longer treated as safe by the scope checker.

**Recall in any language (#326)**

- Hybrid recall's keyword arm now understands Japanese, Chinese, and other scripts written without spaces, plus full-width and half-width compatibility forms. Such queries previously fell back to semantic search alone without saying so.
- Mixed queries such as `Cloudflare 認証方式` keep both halves for ranking and for the embedding.
- Recall snippets find a query term written in full-width form and cut on CJK sentence ends.
- Team-scoped recall (`workspace=` / `team=`) narrows the keyword arm too, so a scoped recall no longer spends its candidate window on rows the scope then discards.
- Desktop app: a routine "update your brain" keeps a migrated brain on its migrated search index.
- Desktop app: a **Multilingual** reading (`@cf/baai/bge-m3`) in the embedding picker, on its own search index. The storage warning now costs a move between same-size models correctly.

**Claude Code hooks (#327)**

- SessionStart recall sent `?q=`; the route reads `query`. The hook printed nothing on every session start since it shipped.
- SessionEnd parsed stdin as the transcript; Claude Code sends a `transcript_path`. Sessions were never captured. The hook now reads the JSONL transcript, keeps only human-readable turns, and captures behind a content gate.
- Hooks now exit 1 with one stderr line on any failure; Claude Code hides stderr from exit-0 hooks.
- `install.sh` reconciles instead of appending, refuses a malformed settings.json, sets the SessionEnd `timeout` the 1.5 s hook budget requires, and keeps credentials in `~/.config/second-brain/config.json` rather than the hook command line.
- New: `install.sh --check` and `--uninstall`.
- Session capture redacts credentials from the body before sending it. Your own token, `Bearer` values, `sk-`/`ghp_`/`github_pat_`/`xoxb-`/`AKIA`/`AIza` key shapes, PEM private keys and `TOKEN=`-style assignments are removed, while UUIDs, commit SHAs, paths and ordinary prose are left intact.
- SessionStart caches the block it printed and re-emits it on compaction, so compaction costs no recall at all; it falls back to a live recall when there is no cache or it is over 24 h old.
- New: `install.ps1`, a PowerShell installer for Windows machines where Claude Code runs hooks under PowerShell rather than Git Bash.
- Worker: a Claude Code transcript is never merged into, never replaces, and never deprecates a memory written by any other source; it is stored as a duplicate-candidate or a draft instead. Transcripts are excluded from insight synthesis.
- Worker: capturing a near-duplicate of a protected memory (importance ≥ 4 or canonical) now stores the newcomer as a duplicate-candidate. It used to report success with an id that did not exist.

**Knowledge graph quality**

- Capture-time inference now draws typed edges (`follows`, `caused_by`, `decided`) in addition to generic `relates_to`, improving traversal and recall relevance.
- Junk-link suppression prevents near-duplicate confusion from creating misleading graph connections.
- Update and merge paths now re-infer edges so the graph stays current when content changes.
- The nightly backfill can emit `follows` when the entry's kind is already classified.
- `GET /stats/graph` endpoint for graph health observability (admin only).
- MCP `link` tool description now explains each edge type and direction.
- The dangling sweep runs weekly instead of nightly (~7× cheaper amortized).

**Desktop and installer**

- Installer offers team-mode onboarding: existing-brain users choose team mode once during connect; the choice is a true one-time decision.
- Installer provisions the company insight schedule from the manifest.
- `install.ps1` (PowerShell) mirrors `install.sh` for Windows environments.
- Desktop typecheck and Rust tests now run on every PR.
- Routine "update your brain" keeps a migrated brain on its migrated search index instead of re-creating it.
- Cost-picker notices are no longer contradictory for migration-level changes.

**Installer onboarding redesign**

- Every setup screen now opens with a real community quote (Product Hunt, Reddit) set at headline size in the installer's serif, attributed to its author and source, with a trust strip at the foot (two minute setup, free and open source, your data, your account). The quote rotates per screen and stays stable while you work.
- A step rail on the left of the window shows numbered progress (Start, Password, Connect, Build, Tools, Details) and lets you jump back to completed steps. Under 900px of width it collapses to a compact strip above the content.
- Ridge, the installer mascot, now uses the official animated art and reacts to what you do: speech anchored to the button you just pressed, live reactions on every screen, dismissible bubbles, and a warm register in English and Italian.
- A full visual pass across every installer screen: consistent design tokens, Lucide icons throughout, no emojis, and copy rewritten to ninety characters per line or fewer.
- The layout is responsive from a 760 by 560 window up and keeps the primary button reachable without scrolling; verified in English and Italian with measured DOM probes.

**Bug fixes**

- Admin lockout guards are atomic; email uniqueness and tombstone guards hardened.
- Integration purge no longer deletes a colleague's memories.
- Re-embed repairs no longer detach vectors from their workspace.
- One member's tags no longer reach another.
- Toast text is readable in light mode; team panel contrast, overlap, truncation, and tap targets fixed.
- Bulk selection no longer outlives the list it is over.

**Upgrade**

- Existing v2 memories become the owner's personal workspace. Nothing is exposed to the team automatically.

### Internal plumbing (not user-facing in v3.0.0)

The codebase supports multiple company workspaces per member (many-to-many memberships, `team` query/body parameter, scoped recall). **v3.0.0 does not expose multi-team in the dashboard, admin UI, or provisioning flows**; each brain still has one shared team. Backlog: [GitHub issues labeled `multi-team`](https://github.com/rahilp/second-brain-cloudflare/issues?q=label%3Amulti-team).

AI clients: on v3.0.0 team brains, `list_teams` returns one entry; omit `team` unless more than one team is returned.

### Migration notes

- Re-run `./scripts/connect-ai-clients.sh` after upgrade to refresh `AI_Instructions/*.md` and the Cursor rule.
- OAuth replaces query-string tokens for MCP (v3).
- Vectorize index must exist for semantic recall; keyword recall continues without it.
