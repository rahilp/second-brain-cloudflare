#!/usr/bin/env bash
# Adds Second Brain hooks to Claude Code's global settings.
# Usage: bash install.sh https://your-worker.workers.dev your-token
#
# After running, every Claude Code session will:
#   - auto-recall relevant context on start
#   - auto-save the conversation to Second Brain on end

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"
MARKER='"second-brain-hooks"'

WORKER_URL="${1:-}"
TOKEN="${2:-}"

if [[ -z "$WORKER_URL" ]]; then
  read -rp "Enter your Second Brain worker URL (e.g. https://your-worker.workers.dev): " WORKER_URL
fi
if [[ -z "$TOKEN" ]]; then
  read -rsp "Enter your AUTH_TOKEN: " TOKEN
  echo
fi

while [[ "$WORKER_URL" == */ ]]; do WORKER_URL="${WORKER_URL%/}"; done

if [[ ! "$WORKER_URL" =~ ^https?:// ]]; then
  echo "Error: worker URL must start with http:// or https://" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run the hook scripts." >&2
  exit 1
fi

mkdir -p "$(dirname "$SETTINGS_FILE")"

# Check for existing installation
if [[ -f "$SETTINGS_FILE" ]] && grep -qF "$MARKER" "$SETTINGS_FILE" 2>/dev/null; then
  echo "Second Brain hooks already installed in $SETTINGS_FILE — skipping."
  exit 0
fi

START_CMD="SECOND_BRAIN_URL=${WORKER_URL} SECOND_BRAIN_TOKEN=${TOKEN} node ${HOOKS_DIR}/session-start.js"
END_CMD="SECOND_BRAIN_URL=${WORKER_URL} SECOND_BRAIN_TOKEN=${TOKEN} node ${HOOKS_DIR}/session-end.js"

# Merge hooks into existing settings or create new file
node - "$SETTINGS_FILE" "$START_CMD" "$END_CMD" "$MARKER" <<'NODEEOF'
const [, , settingsFile, startCmd, endCmd, marker] = process.argv;
const fs = require('fs');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}

settings.hooks = settings.hooks ?? {};
settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
settings.hooks.SessionEnd = settings.hooks.SessionEnd ?? [];

settings.hooks.SessionStart.push({
  matcher: '.*',
  hooks: [{ type: 'command', command: startCmd }],
});
settings.hooks.SessionEnd.push({
  matcher: '.*',
  hooks: [{ type: 'command', command: endCmd }],
});

// Tag for idempotency check
settings[marker.replace(/"/g, '')] = true;

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log('Updated', settingsFile);
NODEEOF

echo
echo "Done. Second Brain hooks installed."
echo "  SessionStart: recalls relevant context when a session opens"
echo "  SessionEnd:   saves the session conversation to your Second Brain"
echo
echo "To use without the hooks, keep the MCP server approach (see AI_Instructions/)."
