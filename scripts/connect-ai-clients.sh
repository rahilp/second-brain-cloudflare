#!/usr/bin/env bash
# Wires up Second Brain for Claude Code and Codex CLI in one shot:
#   - appends global system instructions to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
#   - registers the /mcp endpoint as an MCP server via OAuth (no token ever stored here)
#
# Usage:
#   curl -fsSL <raw-url>/scripts/connect-ai-clients.sh | bash -s -- https://YOUR-WORKER-URL

set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/rahilp/second-brain-cloudflare/main"
START_MARKER="<!-- second-brain:instructions:start -->"
END_MARKER="<!-- second-brain:instructions:end -->"
SENTINEL_PHRASE="At the start of EVERY conversation, call recall"

WORKER_URL="${1:-}"

if [[ -z "$WORKER_URL" ]]; then
  read -rp "Enter your Second Brain worker URL (e.g. https://your-worker.workers.dev): " WORKER_URL
fi

# Trim trailing slash(es)
while [[ "$WORKER_URL" == */ ]]; do WORKER_URL="${WORKER_URL%/}"; done

if [[ ! "$WORKER_URL" =~ ^https?:// ]]; then
  echo "Error: worker URL must start with http:// or https:// (got: $WORKER_URL)" >&2
  exit 1
fi

MCP_URL="${WORKER_URL}/mcp"

echo "Worker URL: $WORKER_URL"
echo "MCP endpoint: $MCP_URL"
echo

fetch() {
  curl -fsSL "$1"
}

# ─── Append instructions idempotently ────────────────────────────────────────
append_instructions() {
  local target_file="$1"
  local source_path="$2"
  local label="$3"

  mkdir -p "$(dirname "$target_file")"
  touch "$target_file"

  if grep -qF "$START_MARKER" "$target_file" 2>/dev/null; then
    echo "[$label] Already configured (marker found in $target_file) — skipping."
    return
  fi

  if grep -qF "$SENTINEL_PHRASE" "$target_file" 2>/dev/null; then
    echo "[$label] Looks like you already pasted these instructions manually into $target_file — skipping to avoid duplicating."
    return
  fi

  local body
  if ! body="$(fetch "${RAW_BASE}/${source_path}")"; then
    echo "[$label] Could not fetch instruction body from ${RAW_BASE}/${source_path} — skipping." >&2
    return
  fi

  {
    echo
    echo "$START_MARKER"
    echo "$body"
    echo "$END_MARKER"
  } >> "$target_file"

  echo "[$label] Appended instructions to $target_file"
}

echo "── Global instructions ──"
append_instructions "$HOME/.claude/CLAUDE.md" "AI_Instructions/CLAUDE_INSTRUCTIONS.md" "Claude Code"
append_instructions "$HOME/.codex/AGENTS.md" "AI_Instructions/CODEX_INSTRUCTIONS.md" "Codex CLI"
echo

# ─── Register MCP server via OAuth ────────────────────────────────────────────
echo "── MCP server registration (OAuth — no token needed here) ──"

if command -v claude >/dev/null 2>&1; then
  if claude mcp get second-brain >/dev/null 2>&1; then
    echo "[Claude Code] 'second-brain' MCP server is already registered — skipping."
  else
    if claude mcp add --transport http second-brain "$MCP_URL"; then
      echo "[Claude Code] Registered 'second-brain'. You'll be prompted to authorize in your browser on first use."
    else
      echo "[Claude Code] Failed to register 'second-brain' — you can add it manually with:" >&2
      echo "  claude mcp add --transport http second-brain \"$MCP_URL\"" >&2
    fi
  fi
else
  echo "[Claude Code] 'claude' CLI not found on PATH — skipping."
fi

if command -v codex >/dev/null 2>&1; then
  if codex mcp get second-brain >/dev/null 2>&1; then
    echo "[Codex CLI] 'second-brain' MCP server is already registered — skipping."
  else
    if codex mcp add second-brain --url "$MCP_URL"; then
      echo "[Codex CLI] Registered 'second-brain' and started the OAuth login flow."
    else
      echo "[Codex CLI] Failed to register 'second-brain' — you can add it manually with:" >&2
      echo "  codex mcp add second-brain --url \"$MCP_URL\"" >&2
    fi
  fi
else
  echo "[Codex CLI] 'codex' CLI not found on PATH — skipping."
fi

echo
echo "── Done ──"
echo "Reminders:"
echo "  • On first use you'll be prompted in your browser to enter your AUTH_TOKEN —"
echo "    that's the one-time OAuth handshake. (If you connect both Claude Code and"
echo "    Codex in the same browser session, you may only be asked once.)"
echo "  • Also using the ChatGPT or Claude apps (not Codex CLI / Claude Code)? Their"
echo "    personalization / custom-instruction settings are account-level and have no"
echo "    public write API — paste AI_Instructions/CHATGPT_INSTRUCTIONS.md into ChatGPT's"
echo "    Settings → Personalization → Custom Instructions, and a similar block into"
echo "    claude.ai's profile preferences, by hand."
