> ### Get Started. Deploying to Cloudflare takes only 2 Minutes - [Deploy to Cloudflare in One Click](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

# Second Brain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)

> ## #3 Product of the Day on Product Hunt
> 
> <a href="https://www.producthunt.com/products/second-brain-cloudflare?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-second-brain-for-ai" target="_blank" rel="noopener noreferrer"><img alt="Second Brain for AI - Persistent memory for Claude, ChatGPT & Cursor. Free. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1151393&theme=light&period=daily&t=1780357463637"></a>

You use Claude for some things, ChatGPT for others, Cursor for code. But your context — your projects, decisions, preferences — doesn’t move with you. You re-explain yourself constantly.

Second Brain fixes that. One shared memory, available in every AI tool you use.

And unlike the built-in memory inside any single app, this one is yours. It lives in your own account. No platform controls it, and no platform can take it away.

[![Second Brain Demo](https://img.youtube.com/vi/h0JqRM0UxHE/hqdefault.jpg)](https://youtu.be/h0JqRM0UxHE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

> [!TIP]
> Have a question, feature idea, or want to show how you’re using it? [Join the conversation in GitHub Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)! That’s where releases get announced and the roadmap gets shaped.

-----

## How it works

Connect Second Brain to whichever AI tools you use. Then tell it things once. It finds them later by meaning, so asking “what did I decide about the pricing model?” surfaces the right note even if you never used those exact words when you saved it.

|Tool         |What it does                                                |
|-------------|------------------------------------------------------------|
|`remember`   |Store anything: ideas, decisions, project context           |
|`append`     |Add updates to an existing entry without creating duplicates|
|`update`     |Replace an entry’s content entirely                         |
|`recall`     |Finds memories by meaning, not exact wording                |
|`list_recent`|Browse recent memories by date                              |
|`forget`     |Delete an entry                                             |

-----

## Save from anywhere

Memory is only useful if it actually gets filled. Second Brain connects to the tools and moments where context naturally lives.

- **CLI** — `brain remember`, `brain recall`, and more from your terminal — `npm install -g second-brain-cf-cli`
- **Obsidian** — notes sync automatically via the [community plugin](https://github.com/rahilp/second-brain-obsidian-plugin) · available in [Obsidian Community Plugins](https://community.obsidian.md/plugins/second-brain-sync)
- **iOS** — Brain Dump, Text Brain Dump, and Save to Brain shortcuts in [`integrations/ios-shortcuts/`](integrations/ios-shortcuts/)
- **Browser extension** — capture any page or highlighted text in one click via the [Chrome extension](https://github.com/rahilp/second-brain-browser-extension)
- **Bookmarklet** — lightweight option in [`integrations/bookmarklet.js`](integrations/bookmarklet.js)
- **Any AI client** — use `remember` mid-conversation, right when something matters

-----

## Setup

> **Before you deploy:** You’ll be asked to set an `AUTH_TOKEN`. This is the password your AI clients use to connect.
> 
> **Quick option:** Use a memorable phrase like `coffee-lover-2026`
> 
> **Secure option:** Run `openssl rand -base64 32` in your terminal and paste the result
> 
> **Save it.** You’ll need it in the next step.

1. **Click Deploy** — everything provisions automatically
1. **Set your token** — you’ll be prompted during deploy
1. **Connect your AI tools** — [instructions here](../../wiki/Connect-to-AI-Clients)

That’s it. Your memory is live and ready across every tool you connect.

```bash
# Verify it's working (replace YOUR-WORKER-URL and YOUR-TOKEN with your values)
curl -X POST https://YOUR-WORKER-URL/capture \
  -H "Authorization: Bearer YOUR-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "second brain is working", "source": "test"}'
# → {"ok":true,"id":"..."}
```

### OAuth for browser-based clients (claude.ai, ChatGPT)

The `/mcp` endpoint also supports **OAuth 2.0**, so MCP clients that open a browser
to authenticate, like claude.ai and ChatGPT, can connect without putting a token in
the URL. When you add `https://<your-worker-url>/mcp` as a connector, you’ll see a
hosted login page; **enter your `AUTH_TOKEN`** to authorize. Claude Desktop, Claude
Code, and `mcp-remote` keep using the `Authorization: Bearer <AUTH_TOKEN>` header as
before — no change needed.

OAuth needs a KV namespace (`OAUTH_KV`) to store tokens and client registrations.

The **Deploy to Cloudflare** button provisions it automatically.

**Deploying manually**, follow these steps. Wrangler validates the entire config before running any command, so the order matters:

1. Remove the placeholder `[[kv_namespaces]]` block from `wrangler.toml` (the one with
   the empty `id`).
1. Create the namespace:
   
   ```bash
   wrangler kv namespace create OAUTH_KV
   ```
1. Copy the `id` from the output and add it back to `wrangler.toml`:
   
   ```toml
   [[kv_namespaces]]
   binding = "OAUTH_KV"
   id = "<paste id here>"
   ```

> The key change is the warning to add the real `id` before running any other wrangler commands, since wrangler validates the entire config upfront and rejects an empty string.

-----

## Documentation

- [Setup Guide](../../wiki/Setup-Guide) — deploy, token setup, connecting AI clients
- [How It Works](../../wiki/How-It-Works) — semantic search, chunking, duplicate detection
- [Connect to AI Clients](../../wiki/Connect-to-AI-Clients) — Claude Desktop, Claude Code, claude.ai, iOS
- [Capture from Anywhere](../../wiki/Capture-from-Anywhere) — browser extension, bookmarklet, iOS Shortcuts, share sheet
- [Web UI](../../wiki/Web-UI) — dashboard and mobile interface
- [Obsidian Plugin](../../wiki/Obsidian-Plugin) — install, configure, sync modes
- [API Reference](../../wiki/API-Reference) — /capture, /append, /update, /list, /recall, /forget, /count, /tags, /stats, /chat, /digest, /mcp endpoints

-----

## Stack

Cloudflare Workers · D1 SQLite · Vectorize · Workers AI · KV · MCP TypeScript SDK · MIT License

All free tier at personal scale. Your data stays in your own Cloudflare account.

-----
## Star History

<a href="https://www.star-history.com/?repos=rahilp%2Fsecond-brain-cloudflare&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=rahilp/second-brain-cloudflare&type=date&legend=top-left" />
 </picture>
</a>

-----

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
