# Second Brain

**One shared memory for Claude, ChatGPT, Cursor, Codex, and every other AI tool you use.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare\&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)

You use Claude for some things, ChatGPT for others, and Cursor for code. But your context, including your projects, decisions, and preferences, does not move with you. You end up explaining yourself again and again.

Second Brain gives every AI tool access to the same persistent memory.

Unlike memory built into a single app, this memory belongs to you. It runs in your own Cloudflare account, stays under your control, and cannot be locked inside one AI platform.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

Deploying takes about two minutes. See the [Quick Start](#quick-start) for the required configuration values.

> ## #3 Product of the Day on Product Hunt
>
> <a href="https://www.producthunt.com/products/second-brain-cloudflare?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-second-brain-for-ai" target="_blank" rel="noopener noreferrer"><img alt="Second Brain for AI: Persistent memory for Claude, ChatGPT, and Cursor" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1151393&theme=light&period=daily&t=1780357463637"></a>

## See it in action

[![Second Brain Demo](https://img.youtube.com/vi/h0JqRM0UxHE/hqdefault.jpg)](https://youtu.be/h0JqRM0UxHE)

## How it works

Connect Second Brain to the AI tools you already use, then save information as it comes up.

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

* **Obsidian:** Automatically sync notes using the [Second Brain Sync plugin](https://github.com/rahilp/second-brain-obsidian-plugin), also available through [Obsidian Community Plugins](https://community.obsidian.md/plugins/second-brain-sync).

* **Browser extension:** Capture a page or highlighted text using the [Chrome extension](https://github.com/rahilp/second-brain-browser-extension).

* **iPhone and iPad:** Use the Brain Dump, Text Brain Dump, and Save to Brain shortcuts in [`integrations/ios-shortcuts/`](integrations/ios-shortcuts/).

* **Bookmarklet:** Use the lightweight bookmarklet in [`integrations/bookmarklet.js`](integrations/bookmarklet.js).

## Quick Start

Set up your Second Brain in three steps.

### 1. Choose an authentication token

Your `AUTH_TOKEN` is the password used to access your Second Brain.

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
| AUTH_TOKEN | The token you created in step 1 |
| DIMENSION  | `384`                           |
| METRIC     | `cosine`                        |

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
<summary><strong>Manual deployment</strong></summary>

To deploy without the one-click button:

```bash
npm install
npm run vectors:create
npm run deploy
```

`npm run vectors:create` creates the Vectorize index (384 dimensions, cosine). Wrangler then provisions the remaining Cloudflare resources automatically and fills in the required values in `wrangler.jsonc`.

</details>

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

## Star History

<a href="https://www.star-history.com/?repos=rahilp%2Fsecond-brain-cloudflare&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left" />
  </picture>
</a>

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
