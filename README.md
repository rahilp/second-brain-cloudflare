<p align="center">
  <a href="https://www.thesecondbrain.dev"><img src="https://www.thesecondbrain.dev/logos/sb-lockup.svg" alt="Second Brain" width="400"></a>
</p>

**Private memory for you. Shared memory for your team. Available to every MCP-compatible AI tool you use.**

Now with **Team Edition** — private personal layers plus a shared team layer, in one Worker.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)
[![MCP Toplist](https://mcptoplist.com/badge/glama%2Frahilp%2Fsecond-brain-cloudflare.svg)](https://mcptoplist.com/server/glama%2Frahilp%2Fsecond-brain-cloudflare)

Claude, ChatGPT, Cursor, Codex, and the other AI tools you use do not naturally share context. You end up repeating the same projects, decisions, and preferences in every app.

Second Brain gives those tools one persistent memory system. It runs in your own Cloudflare account, stays under your control, and retrieves the right context by meaning rather than exact wording.

---

The desktop app is the easiest way to start. It builds your Second Brain and connects your AI tools in about two minutes—no terminal or Cloudflare setup required.

### [Download for Mac or Windows](releases/latest)

---

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare) · [Read the documentation](wiki)


## What it does

- **Recalls by meaning.** Ask a natural-language question and find the right memory even when you used different words when saving it.
- **Works across tools and devices.** Every client talks to the same Worker, so there is nothing to copy or synchronize between apps.
- **Keeps you in control.** Browse, edit, append, connect, share, export, or permanently remove any memory from the dashboard.
- **Builds useful context.** Automatic classification, duplicate detection, relationships, time-aware ranking, and optional weekly insights help the brain stay useful as it grows.
- **Captures from where you already work.** Use MCP clients, the CLI, browser extension, Obsidian, Notion, calendars, email, iOS Shortcuts, or the web dashboard.
- **Acts on what matters next.** Add dates to memories, review overdue and upcoming commitments, and let the installed PWA proactively push a reminder when something becomes due. See the [Reminders and Push guide](https://github.com/rahilp/second-brain-cloudflare/wiki/Reminders-and-Push).
- **Stays in your account.** Memories, vectors, credentials, and application resources live in your own Cloudflare account.

### See it in action

[![Second Brain demo](https://img.youtube.com/vi/h0JqRM0UxHE/hqdefault.jpg)](https://youtu.be/h0JqRM0UxHE)

## Team Edition

Second Brain can now be a team's memory without stopping being yours.

- Every person gets a **Personal** workspace that nobody else can read, plus a **Shared** layer visible to the team.
- Memories are private by default and only enter the Shared layer when someone deliberately shares them.
- Sharing moves one canonical memory rather than making a copy. Its author remains visible, and only the author or an admin can edit, delete, or un-share it.
- Admins can manage members, access, capture defaults, and integrations without gaining access to anyone's personal workspace.
- Existing v2 memories become the owner's private memories during upgrade. Nothing is exposed to a team automatically.

| Layer | Who can read it | Who can edit or delete it |
| --- | --- | --- |
| Personal | Only you | Only you |
| Shared | Everyone on the team | The author or an admin |

The same Worker supports personal and team use; there is no separate team deployment. In the API, CLI, and MCP tools, the Shared layer is represented by the stable workspace value `company`. See the [Team Setup guide](https://github.com/rahilp/second-brain-cloudflare/wiki/Team-Setup) for member management, capture policies, sharing, and upgrades.

**v3.0.0 scope:** each brain has **one** shared team. The API and MCP layer include optional `team` parameters and a `list_teams` tool so multi-team support can ship later without breaking changes; the dashboard and admin flows do not create or switch between multiple teams yet. See [CHANGELOG.md](CHANGELOG.md).

## How it works

Second Brain runs as a Cloudflare Worker backed by D1, Vectorize, Workers AI, and KV. Every app and AI client connects to that Worker through REST or the Model Context Protocol (MCP).

1. **Capture:** Save a decision, preference, project update, note, or source from any connected client.
2. **Organize:** Second Brain classifies it, checks for duplicates and contradictions, creates relationships, and indexes it for semantic search.
3. **Recall:** Ask in natural language. Second Brain retrieves relevant memories, follows useful connections, and returns source-backed context to the tool you are using.

If Vectorize is unavailable, captures and keyword recall continue working. Your memories remain usable while semantic indexing is restored. The shipped embedding models read English best; the desktop app's Settings can switch a brain to a multilingual reading.

Search now finds the hard things: exact names, ticket numbers, versions, and phrases in any language, even when they sit in old memories, and finding them is dramatically faster and cheaper, staying that way as the brain grows, which keeps the free plan comfortable. It does this with a full-text index that ranks matches by relevance instead of scanning every memory. The upgrade is automatic: new installs use the index immediately, existing brains build it over nightly runs, and no client needs updating.

### Memory tools

| Tool | What it does |
| --- | --- |
| `remember` | Store ideas, decisions, preferences, and project context; optionally when a fact became or stopped being true |
| `append` | Add a timestamped update to an existing memory |
| `update` | Replace an existing memory; optionally set when it stopped being true |
| `recall` | Find memories by meaning rather than exact wording; optionally what was true as of a past date |
| `brief` | Show due items, open commitments, stale memories, and pending insights |
| `resolve` | Settle one tracked task, date, insight, or stale fact |
| `digest` | Read the latest existing automatic summary for a project or tag |
| `history` | Read a memory's recorded changes, with the text before each one |
| `list_recent` | Browse recently saved memories |
| `list_teams` | List shared teams you belong to (names and ids). In v3.0.0 this is one team; used by MCP clients for future multi-team support |
| `list_projects` | List projects in scope, with display names, descriptions, and memory counts |
| `get_prompt_capsule` | Read a deterministic core or project context projection for a gateway-controlled prompt prefix |
| `get` | Read one memory by ID |
| `forget` | Move a memory to the trash (undo brings it back) |
| `undo` | Reverse the most recent change to a memory, or restore one from the trash |
| `set_status` | Mark a memory `canonical`, `draft`, or `deprecated` |
| `link` | Add an explicit relationship between two memories |
| `unlink` | Remove a relationship between two memories |
| `connections` | List the memories connected to a memory |
| `share` | Move a memory between the Personal and Shared layers |

A memory keeps the dates it was true for: recall with `as_of` answers what was actually true on a past date, and a fact that a newer one replaces is kept as history instead of being marked wrong.

On a team brain, memory tools accept a `workspace` of `personal` or `company` when you want to choose a layer explicitly. `company` is the wire value for the Shared team layer. Without `workspace`, captures use the member and team defaults, while recall searches everything that person is allowed to see.

Optional `team` (workspace id) and MCP `list_teams` / `GET /team/workspaces` are wired for a future multi-team release. **In v3.0.0 you can omit them** — each brain has one shared team and the primary team is used automatically.

### Projects

Memories live on four axes: **workspace** = who can see it (personal / company / team) — tenancy, unchanged. **project** = what it's about — a named, managed container. **tags** = free-form facets, unchanged. **source** = where it came from, unchanged. Call `list_projects` to discover projects in scope and pass `project` on remember to group related memories. A memory can belong to one or more projects; use projects to organize by topic, initiative, or context rather than bare topic tags.

CLI example:

```bash
brain remember --workspace company "We ship on Thursdays"
brain recall --workspace company "when do we ship?"
brain recall --project website "what did we decide about hosting?"
```

### Prompt Capsules

Prompt Capsules are deterministic, read-only projections for gateways and
custom agents that can place stable context before a changing user request.
They complement query-specific `recall`; they do not inject every memory into
every prompt.

A Capsule entry is an ordinary canonical memory with one target tag and one
slot tag. Core entries use `capsule:core`; project entries use
`capsule:project:<project-slug>`. Slots are emitted in this fixed order:

- Core: `identity`, `preferences`, `constraints`, `principles`
- Project: `current-state`, `decisions`, `open-questions`

Tag the slot as `capsule-slot:<slot>` and keep at most one canonical entry per
slot. Draft and deprecated entries are ignored. Ambiguous slots are omitted
without choosing a winner; malformed rows are skipped. The response reports
`duplicate_slots` and `invalid_entries`, and `complete` is false. Other valid
slots remain available, including on the shared layer.

An entry must carry `status:canonical` to be part of a Capsule. The easiest way
is to include `status:canonical` in the tags at remember or capture time (it is
stored after whitespace trimming, and the classifier then leaves it alone);
otherwise the definition starts as draft and requires `set_status canonical`.
Classification, including `/classify-pending`, never publishes a capsule. A
write that contradicts a protected memory is demoted to draft even when the
caller requested canonical. To take an entry out of a Capsule, set its
status to draft or deprecated. MCP `update` accepts an optional `tags` array:
pass the complete replacement definition, for example
`["capsule:core", "capsule-slot:preferences"]`, along with the entry id and
content. Naming either capsule namespace replaces both namespaces; a lone
slot tag is not a complete definition. Omit `tags` to preserve existing tags.
MCP and REST capture/update accept at most 64 tags of 128 characters each.

**Shared-layer recovery:** members can publish their own shared definitions,
but cannot edit a teammate's entry. Check the reported ids, ask the author or
an admin to re-slot or unpublish them with `update` or `set_status`, and do not
interpret an incomplete response as the full team policy. The dashboard hides
bookkeeping tags; use MCP for this recovery. No teammate content-edit permission
is added.

Authenticated clients can use `GET|HEAD /prompt-capsules/core`,
`GET|HEAD /prompt-capsules/projects/<project-slug>`, or the
`get_prompt_capsule` MCP tool. Responses include a strong `ETag`, a SHA-256 of
the exact prompt-ready `text`, and whole-slot omission metadata for the
12,000-character budget. Validation happens before serialization: shared invalid,
duplicate, or individually oversized definitions are excluded and reported, so
later healthy slots may still appear. The result is an ordered subset of the
defined slots, not necessarily their prefix. Among the remaining valid slots,
once the cumulative budget is exceeded, that slot and every later slot are omitted. A single
entry longer than the whole serialized budget (including JSON escaping) returns
`409 invalid_prompt_capsule` with reason `content-too-large` in a personal
capsule, even if earlier slots would fit; no partial text is returned. In a shared capsule it is skipped
and reported, so it cannot hide unrelated slots. Empty responses have
`populated: false` and `complete: false`. The 200-candidate resource limit still
returns `409 too_many_candidates`; an author or admin must reduce definitions. Timestamps, entry ids, and ETags are excluded from
`text`, so unrelated changes do not alter the reusable prefix. Provider cache
keys, breakpoints, token budgets, and cache-hit measurement remain the
gateway's responsibility.

Capsule bodies are cached in KV per workspace and immutable D1 revision for up
to one hour. Entry triggers advance that revision in the same D1 transaction
as every capsule-tagged insert, id/content/tag update, workspace move, or delete.
If a restore or import has no derived revision row, the first read seeds a new
opaque revision instead of using a reusable sentinel.
Each cached read therefore pays one indexed D1 row instead of scanning the whole
workspace; KV eventual consistency can cause an extra rebuild, but cannot revive
a pre-edit or pre-share body. Old keys become unreachable immediately and expire
within the hour; after propagation settles, the longer TTL normally limits an
unchanged, continuously read target to 24 refresh writes per day. Cold-fill races
and revision changes can add attempts. Writes to ordinary entries do not advance
the revision. Gateways should revalidate with `If-None-Match` once per session
rather than on every request.

An empty project Capsule is returned normally but not stored in KV. Project
ids now correspond to registered project slugs and are enumerable through the
projects registry, but capsule reads remain backward compatible and serve
unregistered ids normally; nonexistent or mistyped ids cannot consume KV writes
or keys. A partial `(workspace_id, id)` index over capsule-tagged rows,
explicitly selected by the candidate query, also bounds these reads to capsule
definitions instead of every ordinary memory in the workspace. Its cost grows
with capsule-tagged rows, not with the ordinary corpus. Empty core Capsules
remain cached because core is one fixed target per workspace.

After a D1 Time Travel restore, redeploy the Worker before resuming traffic so
schema initialization recreates `prompt_capsule_revisions` and the four
`prompt_capsule_*` triggers if the restore point predates part of this migration.
Initialization compares the installed capsule index definition and trigger bodies.
Changed index definitions and changed or missing triggers are repaired atomically
with a revision rotation, so cached results cannot survive a repaired invalidator. NUL-containing ids, content, or tag documents
are rejected (personal) or skipped and reported (shared), never published as a
truncated SQLite string. REST capture/update/append and MCP remember/update/append
reject new NUL-containing content; incoming tags must also be NUL-free. Imported
or legacy rows still receive the read-time checks described above.

**Upgrade warning:** `capsule:*` and `capsule-slot:*` are now reserved. Existing
canonical rows using those names can become prompt definitions or appear in
validation reports. Review these tags before enabling a gateway, especially on
a shared workspace.

## Get started

All three setup methods deploy the same Second Brain into your Cloudflare account.

### 1. Desktop app—recommended

[Download the latest release](releases/latest), open it, choose a password, and sign in to Cloudflare. The app provisions the Worker and its resources, then helps connect your AI clients, CLI, browser extension, Obsidian, and Notion.

The macOS build is signed and notarized by Apple. Windows release builds are code-signed; see the [code signing policy](#code-signing-policy).

### 2. Deploy to Cloudflare

Use [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare) to provision the Worker yourself without cloning the repository.

Your `AUTH_TOKEN` is the password for your Second Brain—the same value every client asks for. Use either:

- A memorable phrase, such as `coffee-lover-2026`
- A randomly generated token:

  ```bash
  openssl rand -base64 32
  ```

When Cloudflare shows the configuration form, enter:

| FIELD | VALUE |
| --- | --- |
| AUTH_TOKEN | The token you created |
| DIMENSION | `384` |
| METRIC | `cosine` |

After deployment, connect compatible clients to:

```text
https://YOUR-WORKER-URL/mcp
```

Use OAuth where the client supports it, or an `Authorization: Bearer <token>` header for static clients. Query-string token authentication was removed in v3 because URLs can leak through browser history and logs.

Add `?client=<name>` to the MCP URL so the dashboard can name the tool that made each change.

Having connection issues? See [Connect to AI Clients → Troubleshooting](https://github.com/rahilp/second-brain-cloudflare/wiki/Connect-to-AI-Clients#troubleshooting) (Opera warnings, Cursor OAuth, Claude Code tool visibility).

### 3. Manual deployment

For developers who want full command-line control:

```bash
npm install
npm run vectors:create
npm run deploy
```

`vectors:create` also creates the `workspace_id` metadata index, which lets search by meaning look only at the workspaces you can read. Without it, Vectorize matches nothing on that filter, so the brain searches the whole index instead and `/health` reports `"workspaceFilter": { "supported": false }`. On a solo brain that gives the same results. Results are always limited to your own memories, but on a team brain other people's memories can push yours out of the closest matches.

A brain created before this step doesn't need the index. If a team brain's recall seems weaker, you can add it with `npm run vectors:metadata-index` and then re-embed so existing vectors enter it: call `POST /migration/reset` once, then `POST /migration/reembed` until it returns `"done": true` (both take your `Authorization: Bearer` token). Re-embedding uses Workers AI allowance for every memory. Don't add the index without re-embedding, or older memories drop out of search by meaning.

Follow the [Setup Guide](https://github.com/rahilp/second-brain-cloudflare/wiki/Setup-Guide) for prerequisites, resource creation, deployment verification, and troubleshooting. Then use [Connect to AI Clients](https://github.com/rahilp/second-brain-cloudflare/wiki/Connect-to-AI-Clients) for client-specific instructions.

**Develop locally:**

```bash
npm run dev      # start the Worker locally
npm test         # run the test suite (fast: the golden-set eval replays are opt-in)
npm run test:eval:full   # the full eval (golden-set replays, workerd lock); run by hand before merging a ranking change
```

See [Local Development](https://github.com/rahilp/second-brain-cloudflare/wiki/Local-Development) for mixed local/remote Wrangler configuration and sharing a local brain through a tunnel.

**Verify the deployment** (replace `YOUR-WORKER-URL` and `YOUR-TOKEN`):

```bash
curl -X POST https://YOUR-WORKER-URL/capture \
  -H "Authorization: Bearer YOUR-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"second brain is working","source":"test"}'
```

A successful response looks like `{"ok":true,"id":"..."}`.

## Capture from anywhere

- **AI clients:** Claude, ChatGPT, Cursor, Codex, and other MCP-compatible clients
- **CLI:** [`second-brain-cf-cli`](https://github.com/rahilp/second-brain-cli)
- **Browser:** [Chrome extension](https://github.com/rahilp/second-brain-browser-extension) or [`integrations/bookmarklet.js`](integrations/bookmarklet.js)
- **Notes:** [Second Brain Sync for Obsidian](https://community.obsidian.md/plugins/second-brain-sync) and Notion
- **Calendar and email:** Google, Outlook, iCloud, and Gmail integrations
- **iPhone and iPad:** Voice, text, and share-sheet shortcuts in [`integrations/ios-shortcuts/`](integrations/ios-shortcuts/)
- **Claude Code:** session hooks that recall project context on start and save the conversation on exit — [`integrations/claude-code-hooks/`](integrations/claude-code-hooks/)
- **Codex CLI:** session-start recall plus session-end capture ([`integrations/codex-cli-hooks/`](integrations/codex-cli-hooks/))
- **Cursor:** session-start recall plus session-end capture; pair it with the MCP `recall` tool for reliable recall ([`integrations/cursor-hooks/`](integrations/cursor-hooks/))
- **VS Code Copilot (Local harness):** session-start recall ([`integrations/vscode-copilot-hooks/`](integrations/vscode-copilot-hooks/))
- **Gemini CLI:** session-start recall ([`integrations/gemini-cli-hooks/`](integrations/gemini-cli-hooks/))
- **Dashboard:** Capture, recall, browse, graph, share, back up, and restore from the built-in web interface

Not yet supported, revisit later: **Windsurf** (no documented session-start context injection event, only a post-response hook); **OpenCode** and **Oh My Pi** (plugin/event-callback APIs, not stdin/stdout scripts, so they need their own integration model rather than an adapter like the ones above).

See [Capture from Anywhere](https://github.com/rahilp/second-brain-cloudflare/wiki/Capture-from-Anywhere) for setup and usage instructions.

## What's new in v3

v3.4 adds Projects: named, workspace-bound containers for what a memory is about. Group memories by codebase, client, or goal; adopt years of existing tags retroactively through aliases with no migration; manage everything from a new dashboard tab; and let agents discover and use projects through `list_projects` and the `project` parameter. Nightly digests, prompt capsules, exports, and Claude Code hooks are all project-aware.

Team Edition adds Personal and Shared memory layers, per-person authentication, sharing and attribution, author locks, team administration, capture policies, team-aware recall and graphs, and a private-by-default upgrade from v2.

It also hardens tenant isolation across REST, MCP, integrations, imports, insights, graph traversal, and vector search, backed by expanded unit, integration, and UI coverage.

See [GitHub Releases](releases) for release notes and previous versions.

## Documentation

- [Wiki home](wiki): Documentation index and quick links
- [Setup Guide](https://github.com/rahilp/second-brain-cloudflare/wiki/Setup-Guide): Desktop, one-click, and manual deployment
- [Team Setup](https://github.com/rahilp/second-brain-cloudflare/wiki/Team-Setup): Team mode, member access, sharing rules, capture defaults, and offboarding
- [Connect to AI Clients](https://github.com/rahilp/second-brain-cloudflare/wiki/Connect-to-AI-Clients): ChatGPT, Claude, Claude Code, Codex, Cursor, and other MCP clients
- [Cursor Instructions](https://github.com/rahilp/second-brain-cloudflare/wiki/Cursor-Instructions): MCP setup and Cursor Rules for automatic recall and remember
- [Capture from Anywhere](https://github.com/rahilp/second-brain-cloudflare/wiki/Capture-from-Anywhere): CLI, browser extension, bookmarklet, iOS Shortcuts, and Notion
- [Notion Integration](https://github.com/rahilp/second-brain-cloudflare/wiki/Notion-Integration): Connect, synchronize, and troubleshoot Notion
- [Web UI](https://github.com/rahilp/second-brain-cloudflare/wiki/Web-UI): Dashboard and mobile interface
- [How It Works](https://github.com/rahilp/second-brain-cloudflare/wiki/How-It-Works): Retrieval, ranking, classification, duplicates, and architecture
- [API Reference](https://github.com/rahilp/second-brain-cloudflare/wiki/API-Reference): REST endpoints and MCP tools
- [How to Upgrade](https://github.com/rahilp/second-brain-cloudflare/wiki/How-to-Upgrade): Upgrade an existing deployment
- [Frequently Asked Questions](https://github.com/rahilp/second-brain-cloudflare/wiki/Frequently-Asked-Questions): Design, privacy, costs, and common questions
- [Obsidian Plugin](https://github.com/rahilp/second-brain-cloudflare/wiki/Obsidian-Plugin): Installation, configuration, and sync modes
- [Local Development](https://github.com/rahilp/second-brain-cloudflare/wiki/Local-Development): Run the Worker locally and share it for testing

## Local UX QA harness

Runs the real Worker and dashboard offline, for a UI change or a full walkthrough of the app, with no Cloudflare account of any kind, ever. `wrangler dev` cannot do this on its own: a real Workers AI binding needs a Cloudflare login even in local dev. This harness never asks for one.

```bash
npm run dev:local                 # boots the Worker + dashboard at http://localhost:8788
npm run ux:seed -- solo           # seeds a 3.7.0-shaped brain and boots the real 4.0 upgrade against it
npm run ux:seed -- team           # the same, plus a teammate, for the shared-history rows
UX_BRAIN=3.7-solo npm run dev:local   # run against a seeded brain instead of an empty one
npm run ux:shot -- --name=home --caption="Dashboard home"   # one screenshot, on demand (see below)
npm run ux:walkthroughs           # the scripted dashboard journeys (map section 6.2), with screenshots
npm run ux:chat                   # scripted MCP calls per AI_Instructions file (map section 6.4)
```

What it uses instead of a Cloudflare account: real local D1 and KV (via wrangler's `getPlatformProxy`), real deterministic local embeddings (the same BGE weights Workers AI serves, run in-process through `@huggingface/transformers`, the eval harness's own local-model runtime), a real cosine-similarity Vectorize double, and fixed canned replies for the handful of LLM-style calls (classify, merge decisions, digest synthesis) a real local model cannot practically stand in for. Everything else, the dashboard, the REST routes, the MCP tools, is the genuine Worker code.

`npm run ux:shot` takes one screenshot of a named screen or state on demand (any lane can use it for a before/after pair), for example:

```bash
npm run ux:shot -- --name=trash-view --caption="New Trash view" --path=/#trash --viewport=mobile --locale=it
```

Screenshots never land in this repository: they are written to `docs/superpowers/screenshots/v4/harness/<run-id>/` outside `public/`, which the project's `docs/*` gitignore rule already excludes, alongside an `index.md` captioning each one.

A journey in `npm run ux:walkthroughs` that reaches a feature not yet built on the current branch (the dashboard timeline, trash view, or settings panel, for example) reports PENDING with the exact missing UX item, not a failure; the same script turns green the moment that feature ships. None of this runs as part of `npm test` or CI's default job: it needs a local Chrome or Chromium (already present on GitHub's `ubuntu-latest` runners and most Linux desktops) and takes real wall-clock time to boot a browser and a local D1, so it stays behind its own npm scripts.

## Technology and privacy

Second Brain uses Cloudflare Workers, D1 SQLite, Vectorize, Workers AI, KV, the Model Context Protocol, and TypeScript. It runs within Cloudflare's free tier at personal scale.

Your application resources and data stay in your Cloudflare account. The project maintainers cannot see your memories or credentials. Integrations contact only the services you choose to connect.

## Code signing policy

Windows release builds of the [Second Brain desktop app](installer/) are code-signed.

Free code signing is provided by [SignPath.io](https://signpath.io), with a certificate from [SignPath Foundation](https://signpath.org).

| Role | Members |
| --- | --- |
| Authors | [Rahil P (@rahilp)](https://github.com/rahilp) |
| Reviewers | [Rahil P (@rahilp)](https://github.com/rahilp) |
| Approvers | [Rahil P (@rahilp)](https://github.com/rahilp) |

Release binaries are built from this repository by [GitHub Actions](.github/workflows/installer-release.yml). Every signing request is reviewed and manually approved before a signed release is published.

**Privacy statement:** This program will not transfer information to other networked systems unless the user or the person installing or operating it specifically requests that action. During setup, the desktop app communicates with Cloudflare to create resources in the user's account. Afterwards, it communicates with that deployment and with integrations the user explicitly connects. Memories and credentials are never sent to the project maintainers.

## Star History

<a href="https://www.star-history.com/?repos=rahilp%2Fsecond-brain-cloudflare&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&theme=dark&legend=top-left&sealed_token=lbb40K-lIek3qXBEOcIcJcbSuOyrPzQgS3geQiY0-QqRpeogir2_DuXSOMrkj3dDJbgbSkUHxjfVoyn4nt_a_JMQQbdsH76GgOtnjPDQJqhUk7SXjILgQsWEqGkvEtYAJT7SGU9I7Atv41s1M-IwZVHr5U4NbINMmlVGlk25_CP-1STiobzyt7B3aw7N" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left&sealed_token=lbb40K-lIek3qXBEOcIcJcbSuOyrPzQgS3geQiY0-QqRpeogir2_DuXSOMrkj3dDJbgbSkUHxjfVoyn4nt_a_JMQQbdsH76GgOtnjPDQJqhUk7SXjILgQsWEqGkvEtYAJT7SGU9I7Atv41s1M-IwZVHr5U4NbINMmlVGlk25_CP-1STiobzyt7B3aw7N" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left&sealed_token=lbb40K-lIek3qXBEOcIcJcbSuOyrPzQgS3geQiY0-QqRpeogir2_DuXSOMrkj3dDJbgbSkUHxjfVoyn4nt_a_JMQQbdsH76GgOtnjPDQJqhUk7SXjILgQsWEqGkvEtYAJT7SGU9I7Atv41s1M-IwZVHr5U4NbINMmlVGlk25_CP-1STiobzyt7B3aw7N" />
 </picture>
</a>

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
