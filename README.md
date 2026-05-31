# Second Brain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)

> ## We're Live on Product Hunt Today!
> <a href="https://www.producthunt.com/products/second-brain-cloudflare?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-second-brain-for-ai" target="_blank" rel="noopener noreferrer"><img alt="Second Brain for AI - Persistent memory for Claude, ChatGPT &amp; Cursor. Free. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1151393&amp;theme=light&amp;t=1780212176757"></a>

You use Claude for some things, ChatGPT for others, Cursor for code. But your context — your projects, decisions, preferences — doesn’t move with you. You re-explain yourself constantly.

Second Brain fixes that. One shared memory, available in every AI tool you use.

And unlike the built-in memory inside any single app, this one is yours. It lives in your own account. No platform controls it, and no platform can take it away.

[![Second Brain Demo](https://img.youtube.com/vi/h0JqRM0UxHE/hqdefault.jpg)](https://youtu.be/h0JqRM0UxHE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

-----

## How it works

Connect Second Brain to whichever AI tools you use. Then tell it things once. It finds them later by meaning, so asking “what did I decide about the pricing model?” surfaces the right note even if you never used those exact words when you saved it.

|Tool         |What it does                                                |
|-------------|------------------------------------------------------------|
|`remember`   |Store anything: ideas, decisions, project context           |
|`append`     |Add updates to an existing entry without creating duplicates|
|`update`     |Replace an entry's content entirely                         |
|`recall`     |Finds memories by meaning, not exact wording                |
|`list_recent`|Browse recent memories by date                              |
|`forget`     |Delete an entry                                             |

-----

## Save from anywhere

Memory is only useful if it actually gets filled. Second Brain connects to the tools and moments where context naturally lives.

- **CLI** -- `brain remember`, `brain recall`, and more from your terminal — `npm install -g second-brain-cf-cli`
- **Obsidian** -- notes sync automatically via the [community plugin](https://github.com/rahilp/second-brain-obsidian-plugin)
- **iOS** -- Brain Dump, Text Brain Dump, and Save to Brain shortcuts in one tap
- **Browser extension** -- capture any page or highlighted text in one click via the [Chrome extension](https://github.com/rahilp/second-brain-browser-extension)
- **Any AI client** -- use `remember` mid-conversation, right when something matters

---

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
# Verify it's working (replace with your worker URL and token)
curl -X POST https://<your-worker-url>/capture \
  -H "Authorization: Bearer coffee-lover-2026" \
  -H "Content-Type: application/json" \
  -d '{"content": "second brain is working", "source": "test"}'
# → {"ok":true,"id":"..."}
```

-----

## Documentation

- [Setup Guide](../../wiki/Setup-Guide) — deploy, token setup, connecting AI clients
- [How It Works](../../wiki/How-It-Works) — semantic search, chunking, duplicate detection
- [Connect to AI Clients](../../wiki/Connect-to-AI-Clients) — Claude Desktop, Claude Code, claude.ai, iOS
- [Capture from Anywhere](../../wiki/Capture-from-Anywhere) — browser extension, bookmarklet, iOS Shortcuts, share sheet
- [Web UI](../../wiki/Web-UI) — dashboard and mobile interface
- [Obsidian Plugin](../../wiki/Obsidian-Plugin) — install, configure, sync modes
- [API Reference](../../wiki/API-Reference) — /capture, /append, /update, /list, /count, /tags, /stats, /chat, /mcp endpoints

-----

## Integrations

- **CLI** — `npm install -g second-brain-cf-cli`
- **Obsidian** — [second-brain-obsidian-plugin](https://github.com/rahilp/second-brain-obsidian-plugin) · available in [Obsidian Community Plugins](https://community.obsidian.md/plugins/second-brain-sync)
- **iOS** — Brain Dump, Text Brain Dump, and Save to Brain shortcuts in [`integrations/ios-shortcuts/`](integrations/ios-shortcuts/)
- **Browser extension** — [second-brain-browser-extension](https://github.com/rahilp/second-brain-browser-extension) · capture pages and highlighted text from any tab
- **Bookmarklet** — lightweight option in [`integrations/bookmarklet.js`](integrations/bookmarklet.js)

-----

## Stack

Cloudflare Workers · D1 SQLite · Vectorize · Workers AI · MCP TypeScript SDK · MIT License

All free tier at personal scale. Your data stays in your own Cloudflare account.

-----

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
