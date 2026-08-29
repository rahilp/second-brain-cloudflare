<p align="center">
  <a href="https://www.thesecondbrain.dev"><img src="https://www.thesecondbrain.dev/logos/sb-lockup.svg" alt="Second Brain" width="400"></a>
</p>

**One shared memory for Claude, ChatGPT, Cursor, Codex, and every other AI tool you use.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare\&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)
[![MCP Toplist](https://mcptoplist.com/badge/glama%2Frahilp%2Fsecond-brain-cloudflare.svg)](https://mcptoplist.com/server/glama%2Frahilp%2Fsecond-brain-cloudflare)

You use Claude for some things, ChatGPT for others, and Cursor for code. But your context, including your projects, decisions, and preferences, does not move with you. You end up explaining yourself again and again.

Second Brain gives every AI tool access to the same persistent memory.

Unlike memory built into a single app, this memory belongs to you. It runs in your own Cloudflare account, stays under your control, and cannot be locked inside one AI platform.

**The easiest way to get started is the desktop app.** It sets everything up for you in about two minutes — no terminal, no accounts to wire together, no technical steps.

### [⬇ Download for Mac or Windows](../../releases/latest)

Prefer to run it yourself? Use the one-click **[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)** button, or follow the manual steps. See the [Quick Start](#quick-start) for all three options.

> ## #3 Product of the Day on Product Hunt
>
> <a href="https://www.producthunt.com/products/second-brain-cloudflare?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-second-brain-for-ai" target="_blank" rel="noopener noreferrer"><img alt="Second Brain for AI: Persistent memory for Claude, ChatGPT, and Cursor" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1151393&theme=light&period=daily&t=1780357463637"></a>

## What's new in v3 — Team Edition

Second Brain has always been one person's memory. It can now be a team's, without stopping being yours.

* **Two layers, not one shared pile.** Every member gets a **personal** workspace nobody else can read, plus one **company** layer everyone on the brain can see. A memory is private by default and becomes shared only when someone deliberately shares it. Recall, the memory list, the graph, backups, and the tag filter all show you your own layer plus the shared one — never a colleague's private memories.

* **Sharing is a move, not a copy.** Share a memory and it moves to the company layer as one canonical row, so there is never a second copy drifting out of date. Its connections move with it. Only the person who wrote it — or an admin — can move it back. Every share and un-share is recorded.

* **Attribution on shared memories.** A memory from the company layer shows who wrote it, in the dashboard and in recall results your AI tools see. Your own memories stay unlabelled, because there is nothing to disambiguate.

* **Shared memories have an author lock.** Anyone on the team can read a shared memory. Editing, deleting, or un-sharing it stays with its author and admins, so a shared decision cannot be quietly rewritten by someone who did not make it.

* **A Team tab in the dashboard.** Admins add members, issue and reset sign-in tokens, suspend and restore access, and remove people. Each member's row shows how many private memories they hold — a count, never the contents. The tab only appears if you are an admin.

* **Capture visibility is a policy, not a habit.** Admins set where new captures land by default for the whole org — personal or company — and can override it per member. Anyone can still say explicitly where a given memory goes, and an explicit choice always wins.

* **Every client signs in as a person.** Members get their own token and use it everywhere the owner uses theirs: the dashboard, the CLI, the browser extension, the Obsidian plugin, and any MCP client through the normal OAuth flow. What each of them can see is decided by who signed in, not by which tool asked.

* **Upgrading keeps everything private.** A brain from v2 becomes a team brain of one. Every existing memory moves into the owner's personal workspace, visible to nobody else, and nothing changes on screen until you add a member. The choice to run a team brain is offered once, in the desktop app, and it is one-way.

## What's new in v2.3

* **A home screen instead of an empty search box.** Open the dashboard and it shows what your brain has been doing: what arrived in the last 48 hours and where it came from, a two-week activity strip, the topics you have been writing about, and one older memory worth re-reading. On a quiet day it says almost nothing rather than inventing news.

* **Insights.** Once a week your Second Brain reads two of your own memories written at least a month apart and tells you what changed between them, what they conflict on, or what connects them — one or two sentences, at most three a week, and often none at all. Confirm one and it becomes a memory you can search; dismiss it and it is gone. Nothing enters recall until you have ruled on it.

* **A graph you can read.** Memories cluster by what they are actually about, and a memory without tags is placed by the company it keeps rather than dumped in an "Other" ring. The brain's own housekeeping notes are no longer drawn as if they were your memories, and the legend and labels fit a phone screen.

* **Memories explain themselves.** Opening a memory shows what the brain makes of it in plain language — how important it is, how often it has been recalled, whether it is current or has been superseded, and whether search can see it at all. Answers cite their sources, with dates.

* **The dashboard keeps itself current.** Four destinations became two: Home, and Memories with a list/graph toggle that remembers your choice. A refresh control sits in the sidebar, and editing or deleting a memory no longer leaves stale numbers on screen.

* **More AI models to choose from**, including larger reasoning models. Insight writing has its own model setting, separate from everything else, under **Advanced Settings → AI**.

* **The dashboard now speaks Italian**, alongside the native Mac and Windows menus added in v2.2.

## What's new in v2.2

* **Advanced Settings.** Seven plain-language controls for how your Second Brain remembers and recalls — how much recent memories outrank old ones, how varied results are, how far to follow connections, how much detail comes back, how strictly duplicates are blocked, how aggressively old memories are compressed, and which AI model does the thinking. Open it with ⌘, in the desktop app. Changes apply to your next search, with no redeploy.

* **Change how your memories are read.** Pick a finer reading for more precise matching, and the app rebuilds your search data for you — resumable if your daily AI allowance runs out, and reversible until the final step. Your memories themselves are never touched.

* **Back up and restore.** Save everything as JSON from the dashboard menu, and restore it there too. A restore runs in the open — it shows what has gone back so far, never duplicates anything if you retry the same file, and finishes by making the restored memories searchable again, spending your daily AI allowance only when you say so.

* **Lost your password?** The unlock screen is no longer a dead end. Sign in to Cloudflare and set a new one. You can also change your password deliberately from Connections, and disconnect every AI tool in one step.

* **Find a brain you already have.** Setting up on a new computer? Sign in to Cloudflare and the app finds your Second Brain — identified from your account's own records, not by asking the Worker. Typing the address yourself still works exactly as before.

* **Now in Italian**, with native menus on Mac and Windows, and a download button in the dashboard sidebar.

## What's new in v2.1

* **Calendar sync.** Connect Google, Outlook, or iCloud calendars from **Settings → Integrations** by pasting your calendar's private iCal (`.ics`) link — no OAuth, no developer setup. Upcoming events sync into memory and stay current, so recall knows what's on your plate; past events are kept as a bounded history.

* **Email capture.** Connect Gmail or iCloud with an app password from **Settings → Integrations**, and Second Brain captures the meaningful mail from your inbox — automatically filtering out newsletters, marketing, receipts, and other automated noise — so real correspondence surfaces in recall.

* **Integrations, organized.** The Integrations screen now groups connections into **Knowledge**, **Calendars**, and **Email**, so it stays easy to navigate as more are added. Synced items are classified like anything else you save.

## What's new in v2

* **Memory graph.** Memories now connect to each other — automatically as you save, or explicitly with the new `link` and `connections` tools. Recall can follow those connections (the `hops` option) to surface related context that a plain search would miss, and the dashboard has a new **Graph** tab to explore your memory visually.

* **Notion sync.** Connect your Notion workspace from **Settings → Integrations** in the dashboard. Pages you share with the connection sync into memory, stay updated as they change in Notion, and surface in recall alongside everything else. Automatic hourly sync, or on demand with **Sync now**.

* **Graceful degradation.** If the Vectorize index is missing, the whole brain keeps working keyword-only: recall falls back to keyword search with a clear notice, and captures, appends and updates are still committed rather than rejected. A `/health` endpoint reports index status, and the dashboard shows a banner with the exact fix.

## See it in action

[![Second Brain Demo](https://img.youtube.com/vi/h0JqRM0UxHE/hqdefault.jpg)](https://youtu.be/h0JqRM0UxHE)

## How it works

Connect Second Brain to the AI tools you already use, then save information as it comes up.

Your Second Brain runs as a single Worker in your own Cloudflare account. Every install (the desktop app, CLI, browser extension, Obsidian, and each AI client) is a client pointed at that one Worker. There is nothing to sync between devices; they all read and write the same memory.

Second Brain retrieves memories by meaning rather than exact wording. Asking:

> What did I decide about the pricing model?

can surface the correct memory even when the original note used completely different words.

### Memory tools

| Tool          | What it does                                             |
| ------------- | -------------------------------------------------------- |
| `remember`    | Store ideas, decisions, preferences, and project context |
| `append`      | Add an update to an existing memory                      |
| `update`      | Replace an existing memory                               |
| `recall`      | Find memories by meaning rather than exact wording       |
| `list_recent` | Browse recently saved memories                           |
| `get`         | Read one memory by id                                    |
| `forget`      | Permanently delete a memory                              |
| `set_status`  | Mark a memory current, superseded, or retired            |
| `link`        | Connect two memories explicitly                          |
| `unlink`      | Remove a connection                                      |
| `connections` | List what a memory is connected to                       |
| `share`       | Move a memory between your private and the company layer |

On a team brain, `remember`, `recall`, and `list_recent` also take a `workspace`
argument (`personal` or `company`) when you want to be explicit about where a
memory goes or where to look. Leave it off and your team's configured default
decides where captures land, while searches cover both layers.

## Save from anywhere

Memory is most useful when capturing information is easy. Second Brain connects to the tools and moments where context already exists.

* **AI clients:** Use `remember` directly within Claude, ChatGPT, Cursor, Codex, and other MCP clients.

* **Command line:** Run `brain remember`, `brain recall`, and other commands from your terminal.

  ```bash
  npm install -g second-brain-cf-cli
  ```

* **Notion:** Connect your Notion workspace from **Settings → Integrations** in the web dashboard. Create an internal **connection** in the [Notion developer portal](https://app.notion.com/developers/connections) (a connection, not a personal access token — only connections appear in a page's Connections menu), share the pages you want remembered with it, and paste its secret — shared pages sync into memory automatically (hourly, or on demand with **Sync now**) and stay updated as they change in Notion.

* **Calendar:** Connect Google, Outlook, or iCloud from **Settings → Integrations** and paste your calendar's private **iCal (`.ics`) link** (Google: *your calendar → Integrate calendar → "Secret address in iCal format"*; Outlook: *Calendar → Shared calendars → Publish*; iCloud: *Share Calendar → Public Calendar*). Read-only — upcoming events sync into memory automatically (hourly, or on demand with **Sync now**), and past events are kept as a bounded history.

* **Email:** Connect Gmail or iCloud from **Settings → Integrations** with an **app password** (Google: *Account → Security → App passwords*; iCloud: *appleid.apple.com → App-Specific Passwords*). Read-only — meaningful messages are captured into memory, while newsletters, marketing, receipts, and other automated mail are filtered out.

* **Obsidian:** Automatically sync notes using the [Second Brain Sync plugin](https://github.com/rahilp/second-brain-obsidian-plugin), also available through [Obsidian Community Plugins](https://community.obsidian.md/plugins/second-brain-sync).

* **Browser extension:** Capture a page or highlighted text using the [Chrome extension](https://github.com/rahilp/second-brain-browser-extension).

* **iPhone and iPad:** Use the Brain Dump, Text Brain Dump, and Save to Brain shortcuts in [`integrations/ios-shortcuts/`](integrations/ios-shortcuts/).

* **Bookmarklet:** Use the lightweight bookmarklet in [`integrations/bookmarklet.js`](integrations/bookmarklet.js).

## Quick Start

Pick the option that fits you. They all deploy the same Second Brain into your own Cloudflare account — the difference is only how much setup you do by hand.

## Option 1 — Desktop app (recommended, no technical steps)

The lowest-friction way to get started. **[Download the Second Brain desktop app](../../releases/latest)** for Mac or Windows, open it, and it walks you through setup in about two minutes: you pick a password, sign in to (or create) a free Cloudflare account, and it builds your Second Brain in your own private space and connects your AI tools for you. After setup it becomes the app you open your dashboard with every day.

It also sets up the rest of the ecosystem from one place: one click to configure the [CLI](https://github.com/rahilp/second-brain-cli), and guided setup for the [browser extension](https://github.com/rahilp/second-brain-browser-extension), the [Obsidian plugin](https://community.obsidian.md/plugins/second-brain-sync), and Notion. The menu bar keeps every connection and integration a click away.

Nothing to install beyond the app itself — no terminal, no git, no configuration values to copy. Developers: see [`installer/`](installer/) for how it works and how to build it.

> The Mac build is signed and notarized by Apple. The Windows build is not yet code-signed, so Windows may show a SmartScreen "unrecognized app" notice on first launch — click **More info → Run anyway**. (Code signing for Windows is in progress.)

## Option 2 — One-click Cloudflare deploy

Prefer to deploy the Worker yourself without the app? Set it up in three steps.

### 1. Choose an authentication token

Your `AUTH_TOKEN` is the password used to access your Second Brain. It is the same value every client asks for. Whether a surface calls it your "auth token", "bearer token", or "password", they all mean this one token, sent in the `Authorization: Bearer` header.

Use either:

* A memorable phrase, such as `coffee-lover-2026`
* A randomly generated token:

  ```bash
  openssl rand -base64 32
  ```

Save this token somewhere secure. You will need it when authorizing clients and testing your deployment.

> **Removed in v3:** `?token=` query-parameter authentication. Use the
> `Authorization: Bearer <token>` header. Query-string credentials leak into
> browser history, proxy logs and `Referer` headers.

### 2. Deploy to Cloudflare

Click **[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)** and follow the prompts.

Enter the following values during setup:

| FIELD      | VALUE                           |
| ---------- | ------------------------------- |
| Dimensions | `384`                           |
| Metric     | `cosine`                        |
| AUTH_TOKEN | The token you created in step 1 |

Cloudflare will provision the required resources and deploy your Worker automatically.

When deployment finishes, copy your Worker URL. It will look similar to:

```text
https://your-worker-name.your-subdomain.workers.dev
```

### 3. Connect your AI clients

Choose the instructions for the clients you use.

#### Claude Code or Codex CLI

Run the command for your operating system, replacing `YOUR-WORKER-URL` with the Worker URL from step 2.

**macOS, Linux, WSL, or Git Bash**

```bash
curl -fsSL https://raw.githubusercontent.com/rahilp/second-brain-cloudflare/main/scripts/connect-ai-clients.sh | bash -s -- https://YOUR-WORKER-URL
```

**Windows PowerShell**

```powershell
iex "& { $(irm https://raw.githubusercontent.com/rahilp/second-brain-cloudflare/main/scripts/connect-ai-clients.ps1) } -WorkerUrl https://YOUR-WORKER-URL"
```

The setup script configures the MCP connection and global instructions using OAuth. Your authentication token is not passed to the script.

#### ChatGPT or Claude desktop and web apps

These clients require two manual setup steps:

1. Add the provided custom instructions to the app's personalization settings.
2. Add the following URL as a custom MCP connector:

   ```text
   https://YOUR-WORKER-URL/mcp
   ```

Follow the **[client-specific instructions in the wiki](../../wiki/Connect-to-AI-Clients)** for the exact menus and settings.

Your Second Brain is now ready to use across every connected client.

### Optional: Verify the deployment

Replace `YOUR-WORKER-URL` and `YOUR-TOKEN` with your own values:

```bash
curl -X POST https://YOUR-WORKER-URL/capture \
  -H "Authorization: Bearer YOUR-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"second brain is working","source":"test"}'
```

A successful response will look like:

```json
{"ok":true,"id":"..."}
```

**Bulk migration:** export with `GET /export`, restore with `POST /import` (same JSON shape, `version: 2`). Imports are paged: each call handles `?limit=` array positions (default 40, sized for the D1 free plan) starting at `?offset=` — resend the same file with the `next_offset` (and, once entries are done, `next_edge_offset`) from the previous response until both `remaining` counts are `0`, then backfill embeddings via `POST /vectorize-pending` until `remaining` is `0`.

<details>
<summary><strong>How OAuth authentication works</strong></summary>

The `/mcp` endpoint supports OAuth 2.0 discovery and dynamic client registration.

When you add the following URL as an MCP connector:

```text
https://YOUR-WORKER-URL/mcp
```

a compatible client will:

1. Detect the authentication requirement.
2. Register itself with your Worker.
3. Open the hosted login page in your browser.
4. Ask you to enter your `AUTH_TOKEN`.
5. Store the resulting OAuth authorization.

This means your authentication token does not need to be placed in the client configuration or included in the connector URL.

The following clients support this flow:

* ChatGPT
* Claude.ai
* Claude Code
* Codex CLI
* Cursor

You can also configure supported command-line clients manually:

```bash
claude mcp add --transport http second-brain https://YOUR-WORKER-URL/mcp
```

```bash
codex mcp add second-brain --url https://YOUR-WORKER-URL/mcp
```

Clients that cannot open a browser, such as `mcp-remote` in a headless environment, can use static token authentication:

```http
Authorization: Bearer YOUR-AUTH-TOKEN
```

OAuth requires the `OAUTH_KV` namespace for client registrations and tokens. The Deploy to Cloudflare button provisions it automatically.

</details>

<details>
<summary><strong>MCP OAuth troubleshooting</strong></summary>

### Opera shows “Did you mean gmail.com?” during Authenticate

Some browsers flag a **false phishing warning** when your Cloudflare account subdomain contains `gmail-com`. Cloudflare auto-generates that label for accounts linked to a Gmail address, so your Worker URL can look like:

```text
https://second-brain.your-name-gmail-com-s-account.workers.dev
```

Opera may treat `gmail-com` in the hostname as a fake Gmail site and block the OAuth login page before it loads.

**Quick workarounds**

* Click **Ignore** on Opera’s warning page, then enter your `AUTH_TOKEN` on the Second Brain sign-in page.
* Use another browser (Chrome, Edge, Firefox) as your system default, or open the auth link there.
* In Cursor: remove the MCP server, add it again, then click **Connect**.

**Permanent fix — change your `workers.dev` subdomain**

1. Open [Workers subdomain settings](https://dash.cloudflare.com/?to=/:account/workers/subdomain) in the Cloudflare dashboard.
2. Click **Change** next to your current subdomain.
3. Pick a name **without** `gmail` (for example `vincenzofabiano` instead of `vincenzofabiano92-gmail-com-s-account`).
4. Update every client config to the new URL:

   ```text
   https://second-brain.YOUR-NEW-SUBDOMAIN.workers.dev/mcp
   ```

5. Remove and re-add the MCP connector in Cursor (or other clients), then authenticate again.

**Alternative — custom domain**

Attach a domain you control under **Worker → Settings → Domains & Routes**. Browsers will not confuse a custom hostname with Gmail.

### Stale OAuth registration in Cursor

If the browser opens a plain error instead of the sign-in form (“invalid authorization request” or similar), Cursor may be using an old OAuth `client_id`. Remove the Second Brain MCP entry, add it again with the correct Worker URL, then authenticate once more.

### Claude Code says Second Brain is “not available”

Some MCP clients (notably **Claude Code**) load tool schemas **lazily**. `/mcp` can show **connected** while `remember` / `recall` do not appear in the session’s visible tool list at first. That does **not** mean the server is down.

**Verify with a real tool call** — ask the agent to run `recall` with a natural-language query. If it returns results (or “no memories found”), MCP is working.

Only treat Second Brain as unavailable when a tool call returns an **error** (auth failure, network error, 5xx). Re-run `scripts/connect-ai-clients.sh` or `.ps1` if your global instructions still tell the agent to report unavailable without calling a tool.

</details>

## Option 3 — Manual deployment

For developers who want full control from the command line. Requires Node.js and a Cloudflare account.

```bash
npm install
npm run vectors:create
npm run deploy
```

`npm run vectors:create` creates the Vectorize index (384 dimensions, cosine). Wrangler then provisions the remaining Cloudflare resources automatically and fills in the required values in `wrangler.jsonc`. Then connect your AI clients using the same steps as Option 2, step 3.

## Running it with your team

A Second Brain is a team brain from the moment it has a second member. There is
nothing to buy and nothing separate to deploy — the same Worker in the same
Cloudflare account serves everyone.

### The two layers

Every member has a **personal** workspace and shares one **company** layer with
everyone else.

| | Who can read it | Who can edit or delete it |
| --- | --- | --- |
| **Personal** | Only you | Only you |
| **Company** | Everyone on the brain | The author, or an admin |

Nothing crosses between members except through the company layer, and nothing
reaches the company layer except by someone putting it there. An admin
administers the team — they do not get a window into anyone's personal
workspace.

### Adding someone

1. Open the dashboard and go to the **Team** tab. (It only appears if you are an
   admin.)
2. **Add member** — a name, and an email if you want one for your own reference.
3. Copy the **one-time sign-in token** it shows you and send it to them. It is
   shown once and never again; if it goes missing, use **Reset token**.

That token is theirs everywhere yours is yours: the dashboard, the CLI, the
browser extension, the Obsidian plugin, and any MCP client through the normal
connect flow. Each of them sees their own memories plus the shared layer.

### Sharing a memory

* **In the dashboard** — the share control on any memory card.
* **From an AI client** — the `share` tool, or `workspace: "company"` when you
  first save it.
* **Un-sharing** moves it back to personal, and is limited to the memory's author
  or an admin.

Sharing **moves** a memory rather than copying it, so a shared decision is one
row everyone reads, not several that drift apart. Connections move with it.

### Where new captures land

Private by default. Three things decide it, in order:

1. What the request said (`workspace: "personal" | "company"`), which always wins.
2. That member's own setting, if an admin set one for them (**Team → Captures**).
3. The org default, set by an admin under **New captures default to**.

### Managing people

* **Suspend** cuts off access immediately and keeps everything; **Restore**
  returns it.
* **Reset token** issues a new one and stops the old one working.
* **Remove** deletes that person's private memories for good. Anything they
  shared with the team stays, because it belongs to the team now. You cannot
  remove yourself, or the last remaining admin.

### Integrations on a team brain

Notion, calendar, and email connections are one connection per provider for the
whole brain, so connecting, syncing and disconnecting are admin actions. Members
can see what is connected and when it last synced. What a connection mirrors goes
to the owner's personal workspace by default; an admin can send it to the company
layer instead when connecting it.

### Coming from v2

Your existing brain becomes a team brain of one. Every memory you already have
moves into your personal workspace, where nobody else can read it, and nothing
looks different until you add someone. The desktop app asks once whether anyone
else will use this brain; that choice is one-way, and it never touches your
memories either way.

## Documentation

* [Setup Guide](../../wiki/Setup-Guide): Deploy the Worker, configure authentication, and connect AI clients
* [How It Works](../../wiki/How-It-Works): Semantic search, chunking, memory classification, and duplicate detection
* [Connect to AI Clients](../../wiki/Connect-to-AI-Clients): ChatGPT, Claude, Claude Code, Codex, and other MCP clients
* [Capture from Anywhere](../../wiki/Capture-from-Anywhere): Browser extension, bookmarklet, iOS Shortcuts, and share sheet
* [Web UI](../../wiki/Web-UI): Dashboard and mobile interface
* [Obsidian Plugin](../../wiki/Obsidian-Plugin): Installation, configuration, and sync modes
* [API Reference](../../wiki/API-Reference): REST and MCP endpoints
* [Running it with your team](#running-it-with-your-team): Layers, members, sharing, and capture visibility

## Technology

Second Brain is built with:

* Cloudflare Workers
* D1 SQLite
* Cloudflare Vectorize
* Workers AI
* Cloudflare KV
* Model Context Protocol
* TypeScript

It runs within Cloudflare's free tier at personal scale.

Your data stays in your own Cloudflare account.

## Code signing policy

Windows builds of the [Second Brain desktop app](installer/) are code-signed.

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

**Team and roles:**

| Role | Members |
| --- | --- |
| Authors | [Rahil P (@rahilp)](https://github.com/rahilp) |
| Reviewers | [Rahil P (@rahilp)](https://github.com/rahilp) |
| Approvers | [Rahil P (@rahilp)](https://github.com/rahilp) |

All release binaries are built from this repository's source by GitHub Actions ([installer-release.yml](.github/workflows/installer-release.yml)). Every signing request is reviewed and manually approved by an approver before a signed release is published.

**Privacy statement:** This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Second Brain is self-hosted by design: during setup the desktop app talks to Cloudflare only to create resources inside *your own* Cloudflare account, and afterwards it communicates exclusively with your own private Second Brain. Your memories and credentials are never sent to the project maintainers or any other third party.

## Star History

<a href="https://www.star-history.com/?repos=rahilp%2Fsecond-brain-cloudflare&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&theme=dark&legend=top-left&sealed_token=lbb40K-lIek3qXBEOcIcJcbSuOyrPzQgS3geQiY0-QqRpeogir2_DuXSOMrkj3dDJbgbSkUHxjfVoyn4nt_a_JMQQbdsH76GgOtnjPDQJqhUk7SXjILgQsWEqGkvEtYAJT7SGU9I7Atv41s1M-IwZVHr5U4NbINMmlVGlk25_CP-1STiobzyt7B3aw7N" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left&sealed_token=lbb40K-lIek3qXBEOcIcJcbSuOyrPzQgS3geQiY0-QqRpeogir2_DuXSOMrkj3dDJbgbSkUHxjfVoyn4nt_a_JMQQbdsH76GgOtnjPDQJqhUk7SXjILgQsWEqGkvEtYAJT7SGU9I7Atv41s1M-IwZVHr5U4NbINMmlVGlk25_CP-1STiobzyt7B3aw7N" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left&sealed_token=lbb40K-lIek3qXBEOcIcJcbSuOyrPzQgS3geQiY0-QqRpeogir2_DuXSOMrkj3dDJbgbSkUHxjfVoyn4nt_a_JMQQbdsH76GgOtnjPDQJqhUk7SXjILgQsWEqGkvEtYAJT7SGU9I7Atv41s1M-IwZVHr5U4NbINMmlVGlk25_CP-1STiobzyt7B3aw7N" />
 </picture>
</a>

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
