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

### [Download for Mac or Windows](releases/latest) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare) · [Read the documentation](wiki)

The desktop app is the easiest way to start. It builds your Second Brain and connects your AI tools in about two minutes—no terminal or Cloudflare setup required.

> **#3 Product of the Day on Product Hunt**
>
> <a href="https://www.producthunt.com/products/second-brain-cloudflare?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-second-brain-for-ai" target="_blank" rel="noopener noreferrer"><img alt="Second Brain for AI: Persistent memory for Claude, ChatGPT, and Cursor" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1151393&theme=light&period=daily&t=1780357463637"></a>

## What it does

- **Recalls by meaning.** Ask a natural-language question and find the right memory even when you used different words when saving it.
- **Works across tools and devices.** Every client talks to the same Worker, so there is nothing to copy or synchronize between apps.
- **Keeps you in control.** Browse, edit, append, connect, share, export, or permanently remove any memory from the dashboard.
- **Builds useful context.** Automatic classification, duplicate detection, relationships, time-aware ranking, and optional weekly insights help the brain stay useful as it grows.
- **Captures from where you already work.** Use MCP clients, the CLI, browser extension, Obsidian, Notion, calendars, email, iOS Shortcuts, or the web dashboard.
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

The same Worker supports personal and team use; there is no separate team deployment. In the API, CLI, and MCP tools, the Shared layer is represented by the stable workspace value `company`. See the [Team Setup guide](wiki/Team-Setup) for member management, capture policies, sharing, and upgrades.

**v3.0.0 scope:** each brain has **one** shared team. The API and MCP layer include optional `team` parameters and a `list_teams` tool so multi-team support can ship later without breaking changes; the dashboard and admin flows do not create or switch between multiple teams yet. See [CHANGELOG.md](CHANGELOG.md).

## How it works

Second Brain runs as a Cloudflare Worker backed by D1, Vectorize, Workers AI, and KV. Every app and AI client connects to that Worker through REST or the Model Context Protocol (MCP).

1. **Capture:** Save a decision, preference, project update, note, or source from any connected client.
2. **Organize:** Second Brain classifies it, checks for duplicates and contradictions, creates relationships, and indexes it for semantic search.
3. **Recall:** Ask in natural language. Second Brain retrieves relevant memories, follows useful connections, and returns source-backed context to the tool you are using.

If Vectorize is unavailable, captures and keyword recall continue working. Your memories remain usable while semantic indexing is restored. Keyword recall works for Japanese, Chinese, and other scripts written without spaces, and for full-width text. The shipped embedding models read English best; the desktop app's Settings can switch a brain to a multilingual reading.

### Memory tools

| Tool | What it does |
| --- | --- |
| `remember` | Store ideas, decisions, preferences, and project context |
| `append` | Add a timestamped update to an existing memory |
| `update` | Replace an existing memory |
| `recall` | Find memories by meaning rather than exact wording |
| `list_recent` | Browse recently saved memories |
| `list_teams` | List shared teams you belong to (names and ids). In v3.0.0 this is one team; used by MCP clients for future multi-team support |
| `get` | Read one memory by ID |
| `forget` | Permanently delete a memory |
| `set_status` | Mark a memory `canonical`, `draft`, or `deprecated` |
| `link` | Add an explicit relationship between two memories |
| `unlink` | Remove a relationship between two memories |
| `connections` | List the memories connected to a memory |
| `share` | Move a memory between the Personal and Shared layers |

On a team brain, memory tools accept a `workspace` of `personal` or `company` when you want to choose a layer explicitly. `company` is the wire value for the Shared team layer. Without `workspace`, captures use the member and team defaults, while recall searches everything that person is allowed to see.

Optional `team` (workspace id) and MCP `list_teams` / `GET /team/workspaces` are wired for a future multi-team release. **In v3.0.0 you can omit them** — each brain has one shared team and the primary team is used automatically.

CLI example:

```bash
brain remember --workspace company "We ship on Thursdays"
brain recall --workspace company "when do we ship?"
```

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

Having connection issues? See [Connect to AI Clients → Troubleshooting](wiki/Connect-to-AI-Clients#troubleshooting) (Opera warnings, Cursor OAuth, Claude Code tool visibility).

### 3. Manual deployment

For developers who want full command-line control:

```bash
npm install
npm run vectors:create
npm run deploy
```

Follow the [Setup Guide](wiki/Setup-Guide) for prerequisites, resource creation, deployment verification, and troubleshooting. Then use [Connect to AI Clients](wiki/Connect-to-AI-Clients) for client-specific instructions.

**Develop locally:**

```bash
npm run dev      # start the Worker locally
npm test         # run the test suite
```

See [Local Development](wiki/Local-Development) for mixed local/remote Wrangler configuration and sharing a local brain through a tunnel.

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
- **Dashboard:** Capture, recall, browse, graph, share, back up, and restore from the built-in web interface

See [Capture from Anywhere](wiki/Capture-from-Anywhere) for setup and usage instructions.

## What's new in v3

Team Edition adds Personal and Shared memory layers, per-person authentication, sharing and attribution, author locks, team administration, capture policies, team-aware recall and graphs, and a private-by-default upgrade from v2.

It also hardens tenant isolation across REST, MCP, integrations, imports, insights, graph traversal, and vector search, backed by expanded unit, integration, and UI coverage.

See [GitHub Releases](releases) for release notes and previous versions.

## Documentation

- [Wiki home](wiki): Documentation index and quick links
- [Setup Guide](wiki/Setup-Guide): Desktop, one-click, and manual deployment
- [Team Setup](wiki/Team-Setup): Team mode, member access, sharing rules, capture defaults, and offboarding
- [Connect to AI Clients](wiki/Connect-to-AI-Clients): ChatGPT, Claude, Claude Code, Codex, Cursor, and other MCP clients
- [Cursor Instructions](wiki/Cursor-Instructions): MCP setup and Cursor Rules for automatic recall and remember
- [Capture from Anywhere](wiki/Capture-from-Anywhere): CLI, browser extension, bookmarklet, iOS Shortcuts, and Notion
- [Notion Integration](wiki/Notion-Integration): Connect, synchronize, and troubleshoot Notion
- [Web UI](wiki/Web-UI): Dashboard and mobile interface
- [How It Works](wiki/How-It-Works): Retrieval, ranking, classification, duplicates, and architecture
- [API Reference](wiki/API-Reference): REST endpoints and MCP tools
- [How to Upgrade](wiki/How-to-Upgrade): Upgrade an existing deployment
- [Frequently Asked Questions](wiki/Frequently-Asked-Questions): Design, privacy, costs, and common questions
- [Obsidian Plugin](wiki/Obsidian-Plugin): Installation, configuration, and sync modes
- [Local Development](wiki/Local-Development): Run the Worker locally and share it for testing

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
