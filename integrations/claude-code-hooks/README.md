# Claude Code hooks

Two hooks that connect a Claude Code session to your Second Brain: one recalls
project context when a session opens, one saves the conversation when it closes.

They are independent of the MCP server. Use either, or both.

## What the hooks do

| Event | Runs on | Action | Cost |
|---|---|---|---|
| `SessionStart` | `startup`, `clear`, `compact` | `GET /recall` for this project, prints up to 5 memories into the session | one recall (~1 s) |
| `SessionEnd` | every reason (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) | `POST /capture` with the tail of the conversation | one capture (embedding + often a model call), 30 s hook timeout |

`resume` and `fork` are skipped on start: those transcripts already contain the
earlier injection. `compact` is not skipped — compaction discards it.

## Install, upgrade, check, uninstall

```bash
bash install.sh https://your-worker.workers.dev your-token   # install or upgrade
bash install.sh                                             # reuse existing credentials, or prompt
bash install.sh --check                                     # prove the hooks reach the Worker
bash install.sh --uninstall                                 # remove only our entries
```

Re-running is safe: the installer replaces its own entries in
`~/.claude/settings.json` and preserves everything else. It refuses to write a
settings file that is not valid JSON rather than overwriting it.

**Restart any session that is already open.** Claude Code snapshots the hook
config at startup, so a running session keeps the old wiring.

## Where credentials live

`~/.config/second-brain/config.json` (mode 600) — the same file the CLI and the
desktop app use:

```json
{ "workerUrl": "https://your-worker.workers.dev", "authToken": "…" }
```

Nothing is written into `settings.json` and nothing is passed on the hook
command line, so the token never appears in Claude Code's settings or in `ps`.
`SECOND_BRAIN_URL` and `SECOND_BRAIN_TOKEN` in the environment take precedence
when set.

## What is sent

Recall:

```
GET /recall?query=<project>+decisions+and+context&topK=5&workspace=personal&tag=<project>
```

with a `tag`-less second attempt if the tagged one returns nothing. With no
project (a session opened in `$HOME`), one generic query limited to the last 14
days is sent instead.

Capture:

```json
{
  "content": "Claude Code session <id> — <project>@<branch> — <date> (<reason>)\n\nUser: …\n\nAssistant: …",
  "source": "claude-code",
  "tags": ["<project>"],
  "workspace": "personal"
}
```

The transcript is read backwards from the end until three human turns are in
hand (1 MB ceiling), and only human-readable turns survive: `tool_use`,
`tool_result` and `thinking` blocks, sidechain (subagent) lines, `isMeta` lines,
compaction summaries and harness noise such as `<system-reminder>` or
`<command-name>` are all dropped. The body is capped at 2000 characters, newest
turns first.

Set `SECOND_BRAIN_WORKSPACE=company` to write to the shared layer instead.
Set `SECOND_BRAIN_DRY_RUN=1` to print the capture body instead of sending it.

## The gate, and the Worker version

A session is captured only when it contains at least one human turn of 40+
characters and 200+ characters of conversation (the header does not count) — a
two-word prompt and a wall of tool output is not a session worth keeping.

Capture also requires **Worker 3.0 or newer** (`GET /health` reports the
version, cached for 24 h). Against an older brain, recall still works and the
capture is skipped with one notice per day. Deploy the Worker, then use the
hooks.

Opt out of either half:

```bash
SECOND_BRAIN_HOOK_RECALL=0    # no recall on session start
SECOND_BRAIN_HOOK_CAPTURE=0   # no capture on session end
```

## Overlap with the MCP instructions

`AI_Instructions/CLAUDE_INSTRUCTIONS.md` already tells the model to call `recall`
at the start of every conversation. If you use those instructions with the MCP
server, the SessionStart hook is a second, unprompted recall on the same topic.
It is still useful — it runs before the first token and cannot be skipped — but
if you would rather have only one, set `SECOND_BRAIN_HOOK_RECALL=0` and leave the
MCP rule in place.

The SessionEnd capture has no MCP equivalent and does not overlap with anything.

## Failure lines you will see

Hooks report failures on stderr and exit non-zero; Claude Code hides stderr from
a hook that exits 0, which is why nothing is silent any more.

| Line | Meaning |
|---|---|
| `[Second Brain] recall failed: HTTP 401 unauthorized — token rejected…` | the token is wrong or was rotated — re-run `install.sh` |
| `[Second Brain] recall failed: HTTP 404 — is SECOND_BRAIN_URL / workerUrl the Worker origin?` | the URL points at something that is not the Worker root |
| `[Second Brain] recall failed: no reply within 15s` | the Worker did not answer in time |
| `[Second Brain] session capture failed: …` | same causes, on the capture call |
| `SessionEnd hook [<cmd>] failed: …` | Claude Code's own wrapper around the line above |
| `[Second Brain] session capture needs Worker 3.0+ …` | the brain has not been redeployed to v3; shown once a day |

Nothing here blocks the session. A failed hook costs you the recall or the
capture, not the conversation.

## Windows

The hooks run under Git Bash if it is installed; without it Claude Code falls
back to PowerShell, where `install.sh` will not run. Install Git for Windows, or
wait for the PowerShell installer (follow-up work). The hook scripts themselves
are plain Node and work either way once they are in `settings.json`.
