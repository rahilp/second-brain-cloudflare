<img src="repo_banner.png" alt="Second Brain — MCP Server on Cloudflare Workers" width="100%" />

# Second Brain — MCP Server on Cloudflare Workers

**A personal memory layer that works across every AI tool you use.**  
Store, search, and recall anything with semantic understanding — deployed on Cloudflare's free tier in minutes.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Cloudflare Workers](https://img.shields.io/badge/Built%20with-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6)](https://modelcontextprotocol.io/)

---

## Table of Contents

- [What is this?](#what-is-this)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Manual Setup](#manual-setup)
- [Usage Examples](#usage-examples)
- [Connect to AI Clients](#connect-to-ai-clients)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code](#claude-code)
  - [claude.ai & iOS](#claudeai--ios)
- [Capture from Anywhere](#capture-from-anywhere)
  - [Browser Bookmarklet](#browser-bookmarklet)
  - [iOS Shortcuts](#ios-shortcuts)
  - [Share Sheet](#share-sheet)
- [API Reference](#api-reference)
- [MCP Tools](#mcp-tools)
- [How Semantic Search Works](#how-semantic-search-works)
- [Stack](#stack)
- [Local Development](#local-development)

---

## What is this?

Most AI tools forget everything between conversations. **Second Brain** fixes that.

It's a lightweight Cloudflare Worker that gives any MCP-compatible AI client (Claude Desktop, Claude Code, claude.ai, etc.) a persistent memory store — with **semantic search** powered by vector embeddings. You can capture notes from your browser, phone, or scripts, then have your AI automatically recall relevant context at the start of every session.

**Four MCP tools. One second brain. Unlimited context.**

| Tool | What it does |
|---|---|
| `remember` | Save anything important — ideas, tasks, decisions, project context |
| `recall` | Find what matters using meaning, not just keywords |
| `list_recent` | Browse your latest memories chronologically |
| `forget` | Remove what you no longer need |

---

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cloudflare Worker                        │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  POST /capture│    │   GET /list  │    │     /mcp         │  │
│  │  (bookmarklet,│    │  (debug /    │    │  (MCP server for │  │
│  │  iOS, scripts)│    │   review)    │    │  Claude & others)│  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────────┘  │
│         │                   │                   │              │
│         └───────────────────┴───────────────────┘              │
│                             │                                   │
│              ┌──────────────┼──────────────┐                   │
│              ▼              ▼              ▼                   │
│         ┌─────────┐   ┌──────────┐  ┌──────────┐              │
│         │   D1    │   │Vectorize │  │Workers AI│              │
│         │ SQLite  │   │  Index   │  │Embeddings│              │
│         │  Store  │   │(cosine)  │  │(bge-small│              │
│         └─────────┘   └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │                                    │
  ┌──────┴──────┐                    ┌────────┴────────┐
  │  Any HTTP   │                    │   MCP Clients   │
  │   client    │                    │ Claude Desktop  │
  │ (browser,   │                    │   Claude Code   │
  │  iOS, curl) │                    │   claude.ai     │
  └─────────────┘                    └─────────────────┘
```

Every note is embedded as a 384-dimensional vector using `bge-small-en-v1.5` on Workers AI. Semantic search queries the Vectorize index using cosine similarity — so "users drop off at the payment step" matches "onboarding problems" even though no keywords overlap.

---

## Quickstart

The fastest path to a running second brain is the one-click deploy:

1. **Click Deploy** → Cloudflare forks the repo, provisions D1 + Vectorize, and deploys the Worker automatically.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

2. **Run the schema** in Cloudflare Dashboard → D1 → `second-brain-db` → Console:

   ```sql
   CREATE TABLE IF NOT EXISTS entries (
     id          TEXT PRIMARY KEY,
     content     TEXT NOT NULL,
     tags        TEXT NOT NULL DEFAULT '[]',
     source      TEXT NOT NULL DEFAULT 'api',
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
   ```

3. **Set your auth token**:

   ```bash
   openssl rand -base64 32   # generate a secure token
   wrangler secret put AUTH_TOKEN
   ```

4. **Test it**:

   ```bash
   curl -X POST https://<your-worker-url>/capture \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"content": "second brain is working", "source": "test"}'
   # → {"ok":true,"id":"..."}
   ```

5. **Connect to Claude** → see [Connect to AI Clients](#connect-to-ai-clients).

> Your Worker URL is in Cloudflare Dashboard → Workers & Pages → `second-brain`.  
> It looks like: `https://second-brain.<your-subdomain>.workers.dev`

---

## Manual Setup

If you prefer to deploy manually from a clone:

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- `wrangler` CLI (installed automatically via `npm install`)

### Steps

```bash
# 1. Clone and install
git clone https://github.com/rahilp/second-brain-cloudflare.git
cd second-brain-cloudflare
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Create the D1 database
npm run db:create
# Copy the database_id output and paste it into wrangler.toml → [[d1_databases]] → database_id

# 4. Create the Vectorize index
npm run vectors:create

# 5. Run the schema migration
npm run db:migrate:remote

# 6. Set your auth token
openssl rand -base64 32
npx wrangler secret put AUTH_TOKEN

# 7. Deploy
npm run deploy
```

---

## Usage Examples

### Store a note (curl)

```bash
curl -X POST https://<your-worker-url>/capture \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Decided to use Cloudflare Workers for the API instead of Vercel — better cold start times and the free D1 DB is perfect for this scale.",
    "tags": ["architecture", "decision"],
    "source": "notes"
  }'
```

```json
{ "ok": true, "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }
```

### List recent entries

```bash
curl "https://<your-worker-url>/list?n=5" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

```json
[
  {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "content": "Decided to use Cloudflare Workers for the API...",
    "tags": "[\"architecture\",\"decision\"]",
    "source": "notes",
    "created_at": 1715299200000
  }
]
```

### Semantic recall via Claude (MCP)

Once connected, ask Claude naturally:

> **You:** "What do I know about infrastructure decisions?"  
> **Claude (calling `recall`):** *"1. [May 10 · notes] (94%) Decided to use Cloudflare Workers for the API instead of Vercel — better cold start times..."*

---

## Connect to AI Clients

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-worker-url>/mcp"]
    }
  }
}
```

Restart Claude Desktop, then add this to **Settings → Custom Instructions**:

```
You have access to a personal second brain via MCP tools: remember, recall, list_recent, forget.

At the start of every conversation, call recall with the main topic before responding.
Store anything important the user mentions automatically — goals, decisions, project context,
ideas, tasks. Never use Claude's built-in memory. Always use the remember tool instead.
Auto-detect the current project or topic and include it as a tag alongside generic ones
like personal, work, idea, task. Set source to "claude-desktop" when storing.
If the second brain MCP tools are unavailable, say so immediately.
```

### Claude Code

```bash
claude mcp add second-brain "npx" "mcp-remote" "https://<your-worker-url>/mcp"
```

Create `~/.claude/CLAUDE.md`:

```markdown
# Second Brain — mandatory rules

You have access to a personal second brain via MCP tools: remember, recall, list_recent, forget.

1. At the start of EVERY conversation, call recall with the main topic before responding.
2. Store EVERYTHING important automatically — goals, decisions, project context, ideas, tasks, commitments, opinions.
3. Never ask permission to store — store silently and keep going.
4. NEVER use Claude's built-in memory. Always use the remember tool instead.
5. Auto-detect the current project or topic and include it as a tag. Always combine specific tags
   with generic ones (personal, work, idea, task, context).

Set source to "claude-code" when storing. If MCP tools are unavailable, say so immediately.
```

### claude.ai & iOS

In **claude.ai → Settings → Integrations → Add custom connector**:

| Field | Value |
|---|---|
| Name | `second-brain` |
| Remote MCP server URL | `https://<your-worker-url>/mcp` |

This makes your second brain available in both the web app and the Claude iOS app automatically.

---

## Capture from Anywhere

### Browser Bookmarklet

Create a new browser bookmark and paste the following as the URL — replacing `YOUR_WORKER_URL` and `YOUR_TOKEN`:

```javascript
javascript:(function(){
  const WORKER='https://YOUR_WORKER_URL/capture';
  const TOKEN='YOUR_TOKEN';
  const text=window.getSelection().toString().trim();
  const content=text?`${text}\n\n${document.title}\n${location.href}`:`${document.title}\n${location.href}`;
  fetch(WORKER,{method:'POST',headers:{'Authorization':`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({content,source:'browser',tags:['reading']})})
    .then(r=>r.json())
    .then(()=>{
      const b=document.createElement('div');
      b.textContent='✓ Saved to brain';
      Object.assign(b.style,{position:'fixed',top:'20px',right:'20px',zIndex:'99999',background:'#1a1a1a',color:'#fff',padding:'10px 16px',borderRadius:'8px',fontSize:'14px'});
      document.body.appendChild(b);
      setTimeout(()=>b.remove(),2000)
    })
    .catch(()=>alert('Capture failed — check your token and Worker URL'));
})();
```

**Usage:**
- **Click** on any page with nothing selected → saves the page title + URL
- **Highlight text first** → saves your selection + page title + URL
- A **"✓ Saved to brain"** toast confirms the save

The full source with comments is in [`bookmarklet.js`](bookmarklet.js).

### iOS Shortcuts

#### Text capture (type what's on your mind)

1. New Shortcut → **Ask for Input** (prompt: "What's on your mind?", type: Text)
2. **Get Contents of URL** → `https://YOUR_WORKER_URL/capture`, Method: `POST`
   - Header: `Authorization` = `Bearer YOUR_TOKEN`
   - Body (JSON): `content` = Ask for Input result, `source` = `phone`
3. **Show Notification** → "Saved ✓"

[⬇ Download Shortcut Template](https://www.icloud.com/shortcuts/f415ad8658084c17b5a2916b327e4ff2)

#### Voice capture (hands-free brain dump)

1. New Shortcut → **Dictate Text** (stop: after pause)
2. **Get Contents of URL** → same config as above, `source` = `voice`
3. **Show Notification** → "Saved ✓"

Name it something Siri-friendly like **"Brain dump"** to trigger hands-free: *"Hey Siri, Brain dump."*

[⬇ Download Shortcut Template](https://www.icloud.com/shortcuts/d82917d9bc904f619fdb7f8f57f8797b)

### Share Sheet

Save any link directly from Safari or any app:

1. New Shortcut → enable **Show in Share Sheet** (accepts: URLs, Articles, Text)
2. **Get Name** of Shortcut Input
3. **Get URLs** from Shortcut Input
4. **Text** action combining name + URL
5. **Get Contents of URL** → same POST config, `source` = `browser`, `tags` = `["reading"]`
6. **Show Notification** → "Saved ✓"

---

## API Reference

All endpoints require an `Authorization: Bearer YOUR_TOKEN` header (except CORS preflight).

### `POST /capture`

Store an entry. Embedding happens in the background so the response is instant.

**Request body:**

```json
{
  "content": "your note here",      // required
  "tags": ["work", "idea"],         // optional
  "source": "api"                   // optional, defaults to "api"
}
```

**Response:**

```json
{ "ok": true, "id": "uuid-v4" }
```

| Status | Meaning |
|---|---|
| `200` | Entry stored successfully |
| `400` | Missing/invalid `content` or malformed JSON |
| `401` | Missing or invalid auth token |

---

### `GET /list?n=20`

List recent entries in reverse chronological order.

| Query param | Default | Max | Description |
|---|---|---|---|
| `n` | `20` | `100` | Number of entries to return |

**Response:** JSON array of entry objects.

---

### `GET+POST /mcp`

MCP server endpoint using the Streamable HTTP transport. Connect any MCP-compatible client here.

---

## MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| `remember` | `content` (string), `tags?` (string[]), `source?` (string) | Store a note with optional tags and source label |
| `recall` | `query` (string), `topK?` (1–20, default 5), `tag?` (string) | Semantic vector search, optionally filtered by tag |
| `list_recent` | `n?` (1–50, default 10), `tag?` (string) | Chronological listing, optionally filtered by tag |
| `forget` | `id` (string) | Delete an entry by ID from both D1 and Vectorize |

---

## How Semantic Search Works

Every entry is embedded using **`bge-small-en-v1.5`** via Workers AI, converting text into a 384-dimensional vector that represents its *meaning*. When you call `recall`, your query is embedded the same way and Cloudflare Vectorize finds the closest stored vectors by cosine similarity.

**Example:** Store *"users drop off at the payment step"* and later recall it with *"onboarding problems."* The keyword "payment" never appears in the query — but the meaning matches.

This is what separates Second Brain from a simple keyword search or a tag system.

---

## Stack

| Service | Role |
|---|---|
| [Cloudflare Workers](https://workers.cloudflare.com/) | Serverless runtime — globally distributed, ~0ms cold start |
| [Cloudflare D1](https://developers.cloudflare.com/d1/) | SQLite-compatible relational database for structured storage |
| [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) | Vector index for semantic (cosine) similarity search |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | Runs `bge-small-en-v1.5` for text embeddings |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Implements the Model Context Protocol server |

**All free tier at personal scale** — no credit card required for typical usage.

---

## Local Development

```bash
npm install
npm run dev        # starts wrangler dev with local D1 + Vectorize stubs
```

> **Note:** Vectorize and Workers AI are only available remotely. For local development, embedding calls will gracefully fail and entries will still be stored in D1 without vectors.

To run against remote resources during development:

```bash
npx wrangler dev --remote
```

### Useful scripts

| Script | Description |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run db:create` | Create the D1 database |
| `npm run db:migrate` | Run schema against local D1 |
| `npm run db:migrate:remote` | Run schema against remote D1 |
| `npm run vectors:create` | Create the Vectorize index |

---

## License

[MIT](LICENSE) — use it, fork it, make it your own.
