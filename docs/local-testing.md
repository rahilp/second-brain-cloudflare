# Running a brain locally, and sharing it for testing

How to run the Worker on your own machine, point a phone or a colleague at it
through a temporary public URL, and take it all down again.

Written after doing it end to end. The gotchas near the bottom are the ones that
actually cost time — read them before assuming something is broken.

## What you need

- Node and this repo's dependencies (`npm ci`).
- A Cloudflare account. Only whoever runs the Worker needs one; whoever is
  *testing* just needs the URL and a token.
- `cloudflared`, for the temporary public URL: `brew install cloudflared`.

## The one thing that is not obvious

**Vectorize and Workers AI cannot run locally.** `wrangler dev` will start, but
the health endpoint reports `Binding VECTORIZE needs to be run remotely` and
recall returns nothing.

The fix is a per-environment config that marks *only those two* bindings as
remote. D1 and KV stay local, so the local run never touches a production
database:

```jsonc
// wrangler.mine.jsonc  — gitignored; wrangler.*.jsonc always is
{
  "name": "second-brain-local",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./public" },

  "d1_databases": [
    { "binding": "DB", "database_name": "second-brain-db", "database_id": "<any-id>" }
  ],

  // remote: these two only. Everything else is local.
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": "<your-index>", "remote": true }
  ],
  "ai": { "binding": "AI", "remote": true },

  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<your-kv-id>" }],
  "vars": { "VECTORIZE_GRACE_MS": "300000" }
}
```

Copy `wrangler.jsonc` and add the two `"remote": true` lines rather than writing
this from scratch — it will drift otherwise.

Put your brain's password in `.dev.vars` (also gitignored):

```
AUTH_TOKEN=your_token_here
```

## Run it

```bash
# --persist-to keeps this run's database in its own directory, so it cannot
# collide with any other local brain you have.
npx wrangler dev -c wrangler.mine.jsonc --port 8788 --persist-to /tmp/sb-local
```

Check it came up, and that Vectorize really is connected:

```bash
curl -s http://localhost:8788/health -H "Authorization: Bearer $AUTH_TOKEN"
# ok: true, and vectorize.ok: true — if vectorize.ok is false the remote
# bindings above are not being applied.
```

Open `http://localhost:8788` and sign in with the Worker URL and that token.

## Put memories in it

An empty brain proves the plumbing and nothing else. Either:

```bash
# a throwaway brain with varied memories
node scripts/seed-test-brain.mjs
```

or, to rehearse against a copy of a real brain **without touching it**:

```bash
# read-only on production
npx wrangler d1 export <your-db> --remote --output=/tmp/brain.sql

# load the copy into the LOCAL database only
npx wrangler d1 execute <your-db> --local --persist-to /tmp/sb-local \
  -c wrangler.mine.jsonc --file=/tmp/brain.sql
```

The export is a read. The import writes only to the local directory. Point
Vectorize at a throwaway index if you plan to *capture* anything, because
captures write vectors to whichever index the config names.

## Share it for testing

```bash
cloudflared tunnel --url http://localhost:8788
```

It prints a URL like `https://<random-words>.trycloudflare.com`. That is the
whole thing — no account, no DNS record, no config file. Send the URL and a
sign-in token to whoever is testing.

To stop it, stop the process. The hostname is released and cannot be reused; a
new run gets a new name. There is nothing to clean up afterwards.

```bash
pkill -f "cloudflared tunnel"
pkill -f "wrangler dev"
```

Confirm it is really gone — the URL should return **530**, meaning Cloudflare has
no origin to route to:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<your-url>.trycloudflare.com/
```

### Before you share that URL

It is reachable from anywhere on the internet. The name is random and
unguessable and every request needs the bearer token, but treat it as public:

- Point it at a **seeded** brain rather than a copy of anything real, unless you
  specifically need real data.
- Stop the tunnel when you finish. It does not expire on its own.
- Never paste the URL somewhere it gets indexed.

## Gotchas

**Local network access does not work on a Mac, but the tunnel does.**
`wrangler dev --ip 0.0.0.0` binds correctly and `lsof` shows it listening on all
interfaces, yet connections to the machine's LAN address time out — including
from the machine itself. macOS's firewall blocks the inbound connection. A plain
`python3 -m http.server` behaves identically, so it is nothing to do with
wrangler. Either allow the binary through the firewall, or use the tunnel, which
makes an *outbound* connection and sidesteps the question entirely (and gives
you HTTPS, so the token is not crossing the network in clear text).

**`npm run deploy` will refuse to run** once you have a `wrangler.<env>.jsonc`.
That is `scripts/predeploy-guard.mjs` doing its job: the file's existence marks
you as someone with a live Worker, and a bare deploy would aim at it with an
unresolved KV binding. Use `ALLOW_BARE_DEPLOY=1` only if you mean it.

**Static assets are served from disk with no build step.** Editing anything in
`public/` shows up on the next page load. Editing `src/` restarts the Worker.

**If the page loads blank or half-dead**, check the Worker is still up
(`curl localhost:8788/health`) before debugging the front end — a crashed
`wrangler dev` looks like a front-end problem from the browser.

**`/tmp` does not keep anything.** macOS purges it on reboot and clears files
untouched for about three days. Use a directory under your home if you want a
local brain to survive.
