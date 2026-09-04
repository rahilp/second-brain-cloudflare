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

**Bug fixes**

- Admin lockout guards are atomic; email uniqueness and tombstone guards hardened.
- Integration purge no longer deletes a colleague's memories.
- Re-embed repairs no longer detach vectors from their workspace.
- One member's tags no longer reach another.
- Toast text is readable in light mode; team panel contrast, overlap, truncation, and tap targets fixed.
- Bulk selection no longer outlives the list it is over.

**Prompt Capsules (#329)**

- New: `GET|HEAD /prompt-capsules/core`, `GET|HEAD /prompt-capsules/projects/<id>`, and the `get_prompt_capsule` MCP tool return a deterministic, read-only prompt prefix built from canonical memories tagged `capsule:core` or `capsule:project:<id>` plus one `capsule-slot:<slot>` each, with a strong `ETag` and `304` support.
- Slots are emitted in a fixed order inside a 12,000-character budget; a slot that does not fit is omitted whole together with every later slot, and ambiguous or malformed definitions fail closed with `409`.
- Capsule bookkeeping tags are reserved: they never appear in `/stats` or `/brief` topic lists, never become digest members, and replacing an entry's tags with a new `capsule:` or `capsule-slot:` tag drops the old ones.
- Capsule bodies are served from a per-workspace KV cache (one-hour orphan TTL; normally 24 TTL refresh writes/day for an unchanged hot target after propagation) keyed by an authoritative opaque D1 revision. Entry triggers advance the revision atomically on every capsule-tagged insert, id/content/tag update, workspace move, or delete, while ordinary entry writes leave it alone. A missing revision is initialized randomly rather than mapped to a reusable sentinel, so D1 restore/import cannot address a future cache key. Candidate rows and their revision are read in one D1 batch transaction, closing concurrent update and Time Travel ABA races. Empty caller-selected project ids are not cached, bounding KV key/write amplification; empty core is cached because it is one fixed target per workspace. A cached request reads one indexed D1 row instead of every row in the workspace, and KV eventual consistency can cause a rebuild but cannot revive a body from before an edit or share change. A non-identical capture carrying `capsule:` or `capsule-slot:` tags is stored as its own row with the status the caller chose, never merged into a near-duplicate or demoted to draft; exact duplicates remain rejected.

**Upgrade**

- Existing v2 memories become the owner's personal workspace. Nothing is exposed to the team automatically.

### Internal plumbing (not user-facing in v3.0.0)

The codebase supports multiple company workspaces per member (many-to-many memberships, `team` query/body parameter, scoped recall). **v3.0.0 does not expose multi-team in the dashboard, admin UI, or provisioning flows**; each brain still has one shared team. Backlog: [GitHub issues labeled `multi-team`](https://github.com/rahilp/second-brain-cloudflare/issues?q=label%3Amulti-team).

AI clients: on v3.0.0 team brains, `list_teams` returns one entry; omit `team` unless more than one team is returned.

### Migration notes

- Re-run `./scripts/connect-ai-clients.sh` after upgrade to refresh `AI_Instructions/*.md` and the Cursor rule.
- OAuth replaces query-string tokens for MCP (v3).
- Vectorize index must exist for semantic recall; keyword recall continues without it.
