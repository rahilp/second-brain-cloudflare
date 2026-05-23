# Second Brain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)

You use Claude for some things, ChatGPT for others, Cursor for code. But your context — your projects, decisions, preferences — doesn’t move with you. You re-explain yourself constantly.

Second Brain fixes that. One shared memory, available in every AI tool you use.

And unlike the built-in memory inside any single app, this one is yours. It lives in your own account. No platform controls it, and no platform can take it away.

[![Second Brain Demo](https://img.youtube.com/vi/oMoQomwwvE8/hqdefault.jpg)](https://youtu.be/oMoQomwwvE8)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

-----

## How it works

Connect Second Brain to whichever AI tools you use. Then tell it things once. It finds them later by meaning, so asking “what did I decide about the pricing model?” surfaces the right note even if you never used those exact words when you saved it.

|Tool         |What it does                                                |
|-------------|------------------------------------------------------------|
|`remember`   |Store anything: ideas, decisions, project context           |
|`append`     |Add updates to an existing entry without creating duplicates|
|`recall`     |Finds memories by meaning, not exact wording                |
|`list_recent`|Browse recent memories by date                              |
|`forget`     |Delete an entry                                             |

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
- [Capture from Anywhere](../../wiki/Capture-from-Anywhere) — browser bookmarklet, iOS Shortcuts, share sheet
- [Web UI](../../wiki/Web-UI) — dashboard and mobile interface
- [Obsidian Plugin](../../wiki/Obsidian-Plugin) — install, configure, sync modes
- [API Reference](../../wiki/API-Reference) — /capture, /list, /mcp endpoints

-----

## Integrations

- **Obsidian** — [second-brain-obsidian-plugin](https://github.com/rahilp/second-brain-obsidian-plugin) · available in [Obsidian Community Plugins](https://community.obsidian.md/plugins/second-brain-sync)
- **iOS** — Brain Dump, Text Brain Dump, and Save to Brain shortcuts in [`integrations/ios-shortcuts/`](integrations/ios-shortcuts/)
- **Browser** — bookmarklet in [`integrations/bookmarklet.js`](integrations/bookmarklet.js)

-----

## Stack

Cloudflare Workers · D1 SQLite · Vectorize · Workers AI · MCP TypeScript SDK · MIT License

All free tier at personal scale. Your data stays in your own Cloudflare account.

-----

[MIT License](LICENSE) · [Discussions](https://github.com/rahilp/second-brain-cloudflare/discussions)
