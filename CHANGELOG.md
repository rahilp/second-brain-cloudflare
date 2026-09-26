# Changelog

All notable changes to Second Brain are documented here. Version numbers match `SB_VERSION` in `src/env.ts` and the desktop app release.

## [Unreleased]

## [3.7.0] — Search that puts the right answer first

**Search**

- Search puts the best match nearer the top more often. After the usual keyword-and-meaning search picks its candidates, a second ranking step (the `bge-reranker-base` cross-encoder on Workers AI) re-reads the closest ones against your question and reorders them. It runs only when the top results are close, and never for a search containing an identifier (a version, file name, ticket number, date or `snake_case` name), which keyword search already answers. On our test set of 1,683 questions the rank of the right answer improved clearly (MRR@10 up 0.058, 95% interval 0.049 to 0.067), most of all for searches built around a rare word (MRR@10 0.58 to 0.86) or a few common words (0.61 to 0.84). Questions worded completely differently from the memory are only slightly better. No kind of search we test got worse on average.
- The ranking step is on by default and costs about 0.4 extra Workers AI calls and about 0.2 neurons per search on average (in our tests it ran on about two searches in five), so 1,000 searches a day use about 200 of the free plan's 10,000 daily neurons. How long it takes on Workers AI has not been measured yet; a search waits at most 1.5 seconds for it. It switches itself off when it fails or is slow: it turns on only after a self-check passes (repeated about weekly, and failed if the model answers too slowly), and three failures or timeouts in a row turn it off for six hours. Whenever it is off, fails or times out, search returns exactly the order it would have returned without it. `RERANK_MODE` (`off`, `on`, `auto`, default `auto`) is an admin setting in the config API; `off` restores the previous ranking exactly.
- Searching for identifiers with underscores, such as `DATABASE_URL` and `ERR_TLS_90412`, now finds the matching memories.
- Questions phrased the way people and AI agents actually ask now find their subject. In "Tell me all about Dana" or "User wants to prepare for a meeting with Dana — what should I know about her?", words that only frame the request (user, wants, tell, should, know, and similar) no longer count as search terms, and a rare name in the question always reaches the ranking even when the rest of the question is made of very common words. A single rare word on its own ("gatewright") now ranks the memory that contains it first.
- An identifier written next to Chinese, Japanese or Korean text without a space, such as `SB-024の決定`, is now searched as the whole identifier (`sb-024`), the same as when a space is typed. Thanks to @oudouusa (#377).
- Older memories are found on large brains. A search containing a short word ("io", "id", "k8") or several very common words used to be answered from only the newest 500 matches, so an old memory matching on those words never appeared once a brain passed a few thousand memories. Those searches now rank through the index like any other, and the short word still counts toward the ranking.
- Those searches also read far fewer rows: on a 20,000-memory brain a search with a short word reads about half as many rows, and the average search about 11% fewer, so the free plan's daily limit goes further on large brains.
- Searches read far fewer database rows when loading candidate memories, so growing brains stay within the D1 free tier much longer. Workspace visibility remains enforced.
- Searching a brain with many long notes (session logs, transcripts) costs far less compute. A search used to read every candidate note in full just to see where the words sit; the database now reports that and sends back no note text. On a test brain where one note in five is 20-100 KB, a search fell from about 90 ms of Worker CPU on 3.6.0 to about 11 ms, measured locally (not yet on Cloudflare); brains of ordinary short notes are unchanged. The same change stops a search from asking for the same candidate rows twice when it plans two passes.
- Searches no longer spend AI calls guessing topic tags. They return faster and use far less of the Workers AI allowance.
- A thin, generic memory that happens to share two words with your question can no longer take the last result slot from a strong answer. Recall keeps one slot for a memory linked to (or sitting just behind) the ones it found; a memory that reached that slot on keyword matching alone now has to cover most of what you asked for, not a word or two of boilerplate. Memories the semantic search itself ranked, and memories reached through a link, are judged as before.
- The search that follows links between memories now starts from the memories the semantic search actually ranked. It used to share one fixed number of starting points between semantic and keyword matches, and keyword matches won nearly all of them, so a memory the semantic search had found could be left out of the link search entirely. Each side now gets its own starting points. Only questions that follow links do any extra work, and they read about half a percent more rows to do it.
- Asking for more results no longer reshuffles the top ones. Search used to size its candidate pool, its diversity pass, and the result slots it reserves for linked memories by how many results you asked for, so the first five of a 10-result search could differ from a 5-result search. A 5-result search returns exactly what it did before, and a larger request now continues that list: up to 20 results, the top ones are the same whatever number you ask for, including when some memories are hidden from you (another workspace, a filter, or a tag that keeps a memory out of results). Linked memories take fixed places in the list (the fifth, and the tenth), so a request for fewer than 5 results usually includes none and one for 6 to 9 usually includes one; when some memories are hidden, a linked memory can move up into a shorter request. A request larger than the list it can rank now draws the rest from a deeper semantic search instead of returning fewer than you asked for.

**Saving and backups**

- Very long memories (a thousand or more pieces) now save and delete in Vectorize-sized batches, and searching for near neighbors when you save a note no longer lets one long memory fill every slot.
- Backups (`/export`) now list memories oldest first, and restoring (`/import`) accepts a backup in either order, so a restored brain keeps the same search behavior as one built by saving memories one at a time.

**For contributors**

- A recall evaluation, `npm run eval:recall`, runs the real search pipeline against a fixed, fully synthetic set of 1,751 questions in more than 1,400 independent groups. It reports quality for each kind of search (exact identifiers, CJK, rare, common and short words, paraphrase, linked memories, long notes) and cost (D1 statements and rows read, AI calls, neurons), and ends in a PASS, FAIL or INCONCLUSIVE verdict with confidence intervals. It needs no Cloudflare account: embeddings and reranker scores come from pinned open-weights models run locally and are replayed from a committed cache, so it runs offline. Continuous integration runs a fast synthetic smoke check on every pull request; the full evaluation, including a lock test that fails whenever a change alters default search ranking without a deliberate re-lock, runs by hand with `npm run test:eval:full` (or the manual `eval-full` workflow) before merging a ranking change. `src/ARCHITECTURE.md` describes it.

## [3.6.0] — Search that finds the exact thing

**Search**

- Search now finds the hard things: exact names, ticket numbers, versions, and phrases in any language, even when they sit in old memories. A rare match buried under years of newer memories used to be cut from the candidate window before ranking ever saw it; matches now rank by relevance.
- Finding those exact matches is dramatically faster and cheaper, and stays that way as the brain grows, so the free plan's daily limits stay comfortable. Saving a memory costs one extra small row; the savings come on every search.
- Upgrading is automatic and needs no action. New installs use the index immediately; existing brains build it over nightly runs and keep the previous search until theirs is complete and verified. No API or MCP tool changed, so no client needs updating.
- Semantic (vector) search is unchanged.

## [3.5.0] — Brief, reminders, and push notifications

**Brief and open loops**

- The resurface card is honest about what it picks now: it excludes memories that were only true in the moment (episodic) and commitments already marked done, prefers whatever shares one of today's top topics, and never repeats the same pick within 30 days. A Dismiss control retires a pick for good instead of only hiding it for the session.
- A new open-loops queue tracks commitments (entries tagged "task") that have no completion signal yet, with Done and Not a task actions on each one. The home board shows up to three with a "See all" sheet for the rest, and the attention count already on the brief folds loops in alongside unindexed and stale memories.

**Reminders and due dates**

- Memories can now carry a time anchor. `remember`, `append`, and capture accept an optional `when` (a date or datetime); a free regex pass also catches unambiguous absolute dates written in the content itself ("Sep 30", "9/30/2026") at capture time, no explicit `when` required.
- A nightly pass asks the model to judge open commitments and volatile memories that neither of the above anchored — phrases like "next Friday" or "end of month" — and only keeps a confident, near-term answer. A dry-run endpoint previews its verdicts without writing anything.
- A new due feed lists what is overdue and what is coming up in the next two days, with Snooze (tomorrow or next week) and Not a commitment actions on each item.
- Date-only reminders now anchor to midnight in the brain's own configured timezone rather than UTC, so "due Sep 30" lands on the calendar day it was meant to, DST included.

**Push notifications**

- Second Brain can now send a push notification when something becomes due. Turning it on takes two taps in the Notifications section of the menu — no server setup, no keys to paste — and a content-free option keeps the memory's text out of the notification itself, sending only that something is due.
- Reminders are checked and sent hourly, encrypted end to end, and capped at three notifications per device per run so a backlog cannot flood a phone.
- Tapping a reminder opens straight to that item in the due sheet, reliably, whether the app was closed or was already open in the background — a background-only tap used to just focus the app and do nothing.
- A mobile browser that cannot receive push notifications at all until Second Brain is added to the Home Screen now says so and shows exactly how, instead of a dead-end "not supported" message. Chrome and Edge on Android offer a one-tap native install; everyone else gets the right two or three steps for their browser.

## [3.4.0] — Projects

**Projects**

- Memories can now belong to named projects. A project is a workspace-bound registry entry (slug, display name, description, archived flag); membership is a reserved `project:<slug>` tag on ordinary memories, so every existing filter, recall, digest, and graph path understands it with no re-indexing and no data migration.
- Aliases adopt existing memories retroactively: a project can claim plain tags you already use, and every project filter matches them alongside the explicit tag. Years of old memories join a project with zero row rewrites.
- New REST surface: `GET/POST/PATCH/DELETE /projects`, plus a `project=` parameter on `POST /capture`, `GET /list`, `GET /recall`, `GET /digest`, and `GET /graph`. Unknown slugs on reads return `404` with up to ten `known_projects`; capture auto-creates silently.
- New MCP tool `list_projects`, and a `project` parameter on `remember`, `recall`, and `list_recent`. `remember` silently registers a project the first time it is named; `recall` reports an unknown slug loudly instead of returning an empty result. Tool descriptions teach the four-axis model: workspace is who can see it, project is what it is about, tags are free-form facets, source is where it came from.
- The dashboard gains a Projects tab: create with a live slug preview, browse each project's memories, edit aliases with tag suggestions and counts, generate a project digest on demand, see prompt-capsule slot status, archive with undo, and delete with the guarantee that memories are kept — only the grouping is removed. The composer gets a project picker and the Memories and recall views a project filter; the graph clusters by project first.
- Nightly compression now writes per-project digests, one workspace at a time using only that workspace's own registry row, at the same eligibility threshold as topic digests.
- Prompt capsule project ids are now registered project slugs, enumerable and validated, while unregistered ids keep serving exactly as before.
- Backups carry projects: `GET /export` is a version 3 payload with a `projects` array and `POST /import` restores names, descriptions, aliases, and archived status. Version 2 and unversioned files still import.
- Claude Code hooks derive a Worker-legal project slug (dotted repo names like `next.js` no longer fail capture), keep the raw name as a tag, pass `project` on capture and recall, and fall back gracefully when the project is not registered yet.

**Fixes**

- The `/digest` error message now states the real eligibility threshold (10 entries); it previously claimed 20.
- `GET /tags` accepts `counts=1` to return per-tag memory counts, with an `X-Counts-Approximate` header when the scan is capped; CORS now exposes `ETag` and `X-Counts-Approximate` for cross-origin dashboards.
- The 64-tag capture cap governs caller-supplied tags only; worker-added `project:` and `volatility:` tags no longer make a previously valid capture fail.
- `/projects` answers unsupported methods with `405` and an `Allow` header.

## [3.3.1] — Fixes from the integration review wave

**Integrations**

- The connected row no longer states where a connection's memories land as though it were true of everything already synced. It now describes the setting itself — "New memories from this source go to the shared team layer" — which is what the layer actually governs, since changing it affects future syncs only. Members see the same sentence an admin does, without needing the admin-only caveat beside the control to make sense of it (#350).
- A sync running while memories are being moved between layers no longer reverts the move. When a mirrored page changes upstream, its vectors are re-embedded into the workspace the memory currently lives in rather than the one the sync was configured for, so a memory moved into the shared layer stays findable there by everyone who should see it (#351).
- Concurrent writes to an integration's stored record no longer overwrite each other. Every partial update now applies to a freshly read record instead of to a copy loaded when the sync started, so a layer change made during a long sync survives it. KV offers no compare-and-swap, so this narrows the window from the length of a whole sync to the gap between one read and one write rather than closing it entirely (#348).
- Moving an integration's memories now reports what the server already knew. A drain that stalls says how many memories had moved instead of claiming none had; a layer change detected mid-move says how many landed in the previously confirmed layer before it stopped; and a memory whose vectors are absent from the index is counted as needing repair rather than reported as searchable in its new layer (#355).
- The activity feed's `integration_memories_moved` event records errored and unsearchable counts alongside the successes, so the audit trail cannot report "moved 10" for a run where three could not be re-indexed (#355).
- Sync planning reads an integration's item map by own property, so an external item whose id happens to match a built-in JavaScript property name is treated as new work rather than as something already mirrored (#368).

**Recall and chat**

- An answer containing the literal text `[DONE]` is no longer swallowed. Both the Worker and the dashboard treated that text anywhere in a streamed line as the end-of-stream marker and dropped the whole line; the marker is now compared against the complete data payload instead. Streamed lines without a space after `data:` are parsed correctly now too (#353).
- Recall no longer diagnoses a missing Vectorize index whenever a search fails. A failed query does not establish why it failed, so both the REST and MCP messages now say that semantic search was unavailable or incomplete and offer the missing index as one possible cause rather than as the answer (#352).

The desktop app is released at this version alongside the Worker; it has no changes of its own in this release.

## [3.3.0] — Moving an integration between layers

**Integrations**

- An admin can now move a connected integration between the personal and shared team layers without disconnecting and reconnecting it. The connected row's provenance line gains a select next to it, admin-only, preselected to the integration's current layer; changing it takes effect immediately and only affects where future syncs land — it does not move memories already synced, which is what the next entry is for (#346).
- The brain's owner can now move memories a connection already synced into its current layer, in place — ids, content, authorship and edges are preserved, and vectors are re-stamped so scoped recall finds them in the new layer immediately. It runs as a bounded, resumable drain (own memories only, one batch at a time), reports moved/already-there/missing/refused counts separately, and is owner-only: mirrored memories live in the owner's own workspace, so anyone else is refused with a reason rather than told "moved 0" as if it had worked (#347).

**Worker endpoints**

- New: `POST /integrations/:provider/layer` sets where a connected integration's future syncs land, without a reconnect. Admin only.
- New: `POST /integrations/:provider/move` moves the memories a connection has already synced into its current layer, one bounded batch per call, resumable from a cursor the response returns. Owner only.
- `GET /integrations` now reports whether the caller is the brain's owner, so the dashboard can show the move only to someone who can actually use it.
- Two new admin events in the activity feed: `integration_layer_changed` and `integration_memories_moved`.

## [3.2.1] — Scoped keyword recall fix

**Fixes**

- Keyword recall no longer lets memories you cannot read consume your candidate limit. Multiple search terms were combined with `OR` without grouping, and because SQL binds `AND` more tightly than `OR`, a filter that followed applied only to the last term: on a team brain the workspace scope was enforced against one term instead of all of them, and the same held for the time window on a dated query. Rows from other people's workspaces were discarded after the fact, but they had already filled the candidate window, so real matches were pushed out of it before scoring. The alternatives are now parenthesised whenever a filter follows. Recall with a single term, or with no filter at all, produces byte-identical SQL to before (#342).

This is a Worker-only patch. It ships with the next desktop app release rather than one of its own.

## [3.2.0] — Dashboard and installer redesign

**Dashboard redesign**

- The dashboard has a new look, in a lighter, warmer visual system that carries through both light and dark. Sora and DM Sans are now self-hosted with the app instead of loaded from Google Fonts.
- Recall and Remember are no longer separate tabs. One command bar reads what you type and guesses whether you are asking a question or saving a memory, always shows that guess before acting on it, and is one tap away from being overridden.
- The home screen is a board of panels built from your own data: things that need a decision (pending insights and aging claims on one thread, oldest first), how your memories connect (a graph preview clustered by topic), what you keep coming back to (your most-recalled memories), last night's maintenance run, upkeep chores, your connected sources and when each last synced, your prompt capsule, memories worth re-reading, your most-used topics, and a breakdown of the kinds of links between memories.
- Four tiles across the top of the board show your memory count, connections, recalls, and contradictions settled at a glance.
- The "Memories over time" chart now breaks activity down by source, with 30-day, 90-day, and 1-year ranges and a table view of the same numbers.
- The chart, the most-recalled panel, and last night's panel are backed by three new Worker endpoints, listed below; an older Worker still runs the dashboard, it just does not show those three panels yet.

**Installer restyle**

- The desktop installer now uses the same design system as the dashboard, with self-hosted fonts, dark mode, and clearer copy.

**Worker endpoints**

- New: `GET /stats/activity?days=N` returns per-source capture counts by day, for the dashboard's activity chart.
- New: `GET /stats/recalled?limit=N` returns your most-recalled memories, a running total of recalls, and a running total of contradictions settled in your favor, for the dashboard's "what you keep coming back to" panel.
- New: `GET /stats/night` reports what last night's maintenance run did (links inferred, digests written, claims flagged as aging), read from a per-workspace summary the nightly cron now writes.
- `GET /brief`'s resurfaced memory now includes its `source` and `tags`.

**OAuth pages**

- The OAuth sign-in and sign-in-error pages (`/oauth/authorize`) now use the dashboard's design system: Sora/DM Sans loaded from same-origin `/fonts/`, the brand lockup image in place of the circular brain glyph, and light/dark tokens matched to `prefers-color-scheme`.

## [3.1.0] — Prompt Capsules

Contributed by @oudouusa.

**Prompt Capsules (#329)**

- New: `GET|HEAD /prompt-capsules/core`, `GET|HEAD /prompt-capsules/projects/<id>`, and the `get_prompt_capsule` MCP tool return a deterministic, read-only prompt prefix built from canonical memories tagged `capsule:core` or `capsule:project:<id>` plus one `capsule-slot:<slot>` each, with a strong `ETag` and `304` support.
- Slots are emitted in a fixed order inside a 12,000-character budget; a slot that does not fit is omitted whole together with every later slot, and ambiguous or malformed definitions are skipped and reported without discarding unrelated slots. Empty or partially invalid responses have `complete: false`; `populated` distinguishes empty results.
- Capsule bookkeeping tags are reserved: they never appear in `/stats` or `/brief` topic lists, never become digest members, and replacing an entry's tags with a new `capsule:` or `capsule-slot:` tag drops the old ones.
- Capsule bodies are served from a per-workspace KV cache (one-hour orphan TTL; normally 24 TTL refresh writes/day for an unchanged hot target after propagation) keyed by an authoritative opaque D1 revision. Entry triggers advance the revision atomically on every capsule-tagged insert, id/content/tag update, workspace move, or delete, while ordinary entry writes leave it alone. A missing revision is initialized randomly rather than mapped to a reusable sentinel, so D1 restore/import cannot address a future cache key. Candidate rows and their revision are read in one D1 batch transaction, closing concurrent update and Time Travel ABA races. Empty caller-selected project ids are not cached, bounding KV key/write amplification; empty core is cached because it is one fixed target per workspace. A cached request reads one indexed D1 row instead of every row in the workspace, and KV eventual consistency can cause a rebuild but cannot revive a body from before an edit or share change. A capture carrying capsule tags is stored as its own row even at the duplicate-block threshold. Missing status starts as draft and classification cannot auto-publish it; protected contradictions are demoted to draft. MCP `update.tags` supports re-slotting. REST/MCP capture and update bound tags to 64 strings of 128 characters. A partial capsule-only index prevents missing-project reads from scanning ordinary memories. Installed trigger bodies are checked and repaired transactionally, with revision invalidation also when a trigger was missing. The candidate query explicitly selects the capsule index; NUL-containing rows cannot publish a truncated prefix.
- Upgrade warning: `capsule:*` and `capsule-slot:*` reserve previously user-defined namespaces. Review existing canonical rows before gateway use. Shared malformed, duplicate, and oversized definitions are skipped and reported; authors/admins can repair via MCP `update` or unpublish with `set_status`. Other members gain no editing authority. Personal oversized content still returns 409, and the 200-candidate resource limit remains explicit.

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
