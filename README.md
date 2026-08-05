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

## What's new in v2.2

* **Advanced Settings.** Seven plain-language controls for how your Second Brain remembers and recalls — how much recent memories outrank old ones, how varied results are, how far to follow connections, how much detail comes back, how strictly duplicates are blocked, how aggressively old memories are compressed, and which AI model does the thinking. Open it with ⌘, in the desktop app. Changes apply to your next search, with no redeploy.

* **Change how your memories are read.** Pick a finer reading for more precise matching, and the app rebuilds your search data for you — resumable if your daily AI allowance runs out, and reversible until the final step. Your memories themselves are never touched.

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
| `forget`      | Permanently delete a memory                              |

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

## Documentation

* [Setup Guide](../../wiki/Setup-Guide): Deploy the Worker, configure authentication, and connect AI clients
* [How It Works](../../wiki/How-It-Works): Semantic search, chunking, memory classification, and duplicate detection
* [Connect to AI Clients](../../wiki/Connect-to-AI-Clients): ChatGPT, Claude, Claude Code, Codex, and other MCP clients
* [Capture from Anywhere](../../wiki/Capture-from-Anywhere): Browser extension, bookmarklet, iOS Shortcuts, and share sheet
* [Web UI](../../wiki/Web-UI): Dashboard and mobile interface
* [Obsidian Plugin](../../wiki/Obsidian-Plugin): Installation, configuration, and sync modes
* [API Reference](../../wiki/API-Reference): REST and MCP endpoints

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
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left" />
  </picture>
</a>

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
