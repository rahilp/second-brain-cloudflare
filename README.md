# Second Brain — MCP Server on Cloudflare Workers

A personal memory layer that works across every AI tool you use. Built on Cloudflare Workers, D1, Vectorize, and Workers AI. Exposes four MCP tools — `remember`, `recall`, `list_recent`, `forget` — that any MCP-compatible AI client can call.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rahilp/second-brain-cloudflare)

---

## What this is

A Cloudflare Worker that acts as your personal second brain:

- **Stores** anything you tell it with semantic embeddings for natural language search
- **Recalls** relevant context using meaning, not just keywords
- **Exposes** an MCP server that Claude Desktop, Claude Code, claude.ai, and any MCP client can connect to
- **Accepts** captures from anywhere via a plain HTTP endpoint (browser bookmarklet, iOS Shortcut, scripts)

---

## One-click deploy

Click the Deploy to Cloudflare button above. Cloudflare will:

1. Fork this repo into your GitHub account
2. Provision a D1 database and Vectorize index automatically
3. Deploy the Worker to your account
4. Configure CI/CD so future pushes redeploy automatically

### After deploying

Find your Worker URL in the Cloudflare dashboard → Workers & Pages → `second-brain`. It will look like:

```
https://second-brain.<your-cloudflare-subdomain>.workers.dev
```

You'll use this URL everywhere below. Replace `<your-worker-url>` throughout this guide with that full URL.

### Step 1 — Run the database schema

In the Cloudflare dashboard → D1 → `second-brain-db` → Console, paste and execute:

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

Or via CLI:

```bash
wrangler d1 execute second-brain-db --remote --file=schema.sql
```

### Step 2 — Set your auth token

```bash
# Generate a secure random token
openssl rand -base64 32

# Set it as a Worker secret
wrangler secret put AUTH_TOKEN
```

Save this token — you'll need it for the bookmarklet and iOS Shortcuts.

### Step 3 — Create the Vectorize index (if not auto-provisioned)

```bash
wrangler vectorize create second-brain-vectors --dimensions=384 --metric=cosine
```

---

## Test it

```bash
curl -X POST https://<your-worker-url>/capture \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "second brain is working", "source": "test"}'

# Should return: {"ok":true,"id":"..."}

curl https://<your-worker-url>/list \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Connect to Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop. Add this to Settings → Custom Instructions:

```
You have access to a personal second brain via MCP tools: remember, recall, list_recent, forget.

At the start of every conversation, call recall with the main topic before responding.
Store anything important the user mentions automatically — goals, decisions, project context,
ideas, tasks. Never use Claude's built-in memory. Always use the remember tool instead.
Auto-detect the current project or topic and include it as a tag alongside generic ones
like personal, work, idea, task. Set source to "claude-desktop" when storing.
If the second brain MCP tools are unavailable, say so immediately.
```

---

## Connect to Claude Code

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
5. Auto-detect the current project or topic and include it as a tag. Always combine specific tags with generic ones (personal, work, idea, task, context).

Set source to "claude-code" when storing. If MCP tools are unavailable, say so immediately.
```

---

## Connect to claude.ai and iOS

In claude.ai → Settings → Integrations → Add custom connector:

- **Name:** `second-brain`
- **Remote MCP server URL:** `https://<your-worker-url>/mcp`

This makes your second brain available in the claude.ai web app and Claude iOS app automatically.

---

## Capture from anywhere

### Browser bookmarklet

Create a bookmark and paste this as the URL. Edit `YOUR_WORKER_URL` and `YOUR_TOKEN` first:

```javascript
javascript:(function(){
  const WORKER='https://YOUR_WORKER_URL/capture';
  const TOKEN='YOUR_TOKEN';
  const text=window.getSelection().toString().trim();
  const content=text?`${text}\n\n${document.title}\n${location.href}`:`${document.title}\n${location.href}`;
  fetch(WORKER,{method:'POST',headers:{'Authorization':`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({content,source:'browser',tags:['reading']})}).then(r=>r.json()).then(()=>{const b=document.createElement('div');b.textContent='✓ Saved to brain';Object.assign(b.style,{position:'fixed',top:'20px',right:'20px',zIndex:'99999',background:'#1a1a1a',color:'#fff',padding:'10px 16px',borderRadius:'8px',fontSize:'14px'});document.body.appendChild(b);setTimeout(()=>b.remove(),2000)}).catch(()=>alert('Capture failed — check your token and Worker URL'));
})();
```

### iOS Shortcut — text capture

1. New Shortcut → Ask for Input (prompt: "What's on your mind?", type: Text)
2. Get Contents of URL → `https://YOUR_WORKER_URL/capture`, Method: POST
   - Header: `Authorization` = `Bearer YOUR_TOKEN`
   - Body (JSON): `content` = Ask for Input result, `source` = `phone`
3. Show Notification → "Saved ✓"

[Download Shortcut Template](https://www.icloud.com/shortcuts/f415ad8658084c17b5a2916b327e4ff2)

### iOS Shortcut — voice capture

1. New Shortcut → Dictate Text (stop: after pause)
2. Get Contents of URL → same config as above, `source` = `voice`
3. Show Notification → "Saved ✓"

Name it something Siri-friendly like "Brain dump" for hands-free triggering.

[Download Shortcut Template](https://www.icloud.com/shortcuts/d82917d9bc904f619fdb7f8f57f8797b)

### Share Sheet (save from Safari or any app)

1. New Shortcut → enable Show in Share Sheet (accept: URLs, Articles, Text)
2. Get Name of Shortcut Input
3. Get URLs from Shortcut Input
4. Text action combining name + URL
5. Get Contents of URL → same POST config, `source` = `browser`, `tags` = `["reading"]`
6. Show Notification → "Saved ✓"

---

## API reference

### POST /capture
Store an entry. Requires `Authorization: Bearer YOUR_TOKEN` header.

```json
{
  "content": "your note here",
  "tags": ["work", "idea"],
  "source": "api"
}
```

### GET /list?n=20
List recent entries. Requires auth header.

### GET+POST /mcp
MCP server endpoint. Connect any MCP-compatible client here.

### MCP tools

| Tool | Parameters | Description |
|---|---|---|
| `remember` | `content`, `tags?`, `source?` | Store a note |
| `recall` | `query`, `topK?`, `tag?` | Semantic search |
| `list_recent` | `n?`, `tag?` | Chronological listing |
| `forget` | `id` | Delete by ID |

---

## How semantic search works

Every entry is embedded using `bge-small-en-v1.5` on Workers AI — converting text to 384 numbers representing its meaning. Queries are embedded the same way. Vectorize finds the closest stored vectors using cosine similarity.

You can store "users drop off at the payment step" and recall it with "onboarding problems." The keyword never appears — the meaning matches.

---

## Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) — serverless runtime
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — SQLite database
- [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) — vector search
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) — embeddings
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server

All free tier at personal scale.
