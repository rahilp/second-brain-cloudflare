#!/usr/bin/env bash
# Wires up Second Brain for Claude Code and Codex CLI in one shot:
#   - installs or updates global system instructions in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
#   - registers the /mcp endpoint as an MCP server via OAuth (no token ever stored here)
#
# Usage:
#   curl -fsSL <raw-url>/scripts/connect-ai-clients.sh | bash -s -- https://YOUR-WORKER-URL

set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/rahilp/second-brain-cloudflare/main"

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

resolve_instruction_block_helper() {
  local script_path="${BASH_SOURCE[0]:-}"
  if [[ -n "$script_path" && "$script_path" != "-" && -f "$script_path" ]]; then
    local local_helper
    local_helper="$(cd "$(dirname "$script_path")" && pwd)/instruction-block.mjs"
    if [[ -f "$local_helper" ]]; then
      INSTRUCTION_BLOCK_HELPER="$local_helper"
      return
    fi
  fi

  INSTRUCTION_BLOCK_HELPER="$(mktemp)"
  fetch "${RAW_BASE}/scripts/instruction-block.mjs" > "$INSTRUCTION_BLOCK_HELPER"
  FETCHED_INSTRUCTION_BLOCK_HELPER="$INSTRUCTION_BLOCK_HELPER"
}

FETCHED_INSTRUCTION_BLOCK_HELPER=""
INSTRUCTION_BLOCK_HELPER=""
resolve_instruction_block_helper
if [[ -n "$FETCHED_INSTRUCTION_BLOCK_HELPER" ]]; then
  trap 'rm -f "$FETCHED_INSTRUCTION_BLOCK_HELPER"' EXIT
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required to install or update Second Brain instructions." >&2
  exit 1
fi

# ─── Install or refresh instructions ────────────────────────────────────────
apply_instructions() {
  local target_file="$1"
  local source_path="$2"
  local label="$3"

  mkdir -p "$(dirname "$target_file")"
  touch "$target_file"

  local body
  if ! body="$(fetch "${RAW_BASE}/${source_path}")"; then
    echo "[$label] Could not fetch instruction body from ${RAW_BASE}/${source_path} — skipping." >&2
    return
  fi

  local action
  if ! action="$(printf '%s' "$body" | node "$INSTRUCTION_BLOCK_HELPER" "$target_file")"; then
    echo "[$label] Failed to update instructions in $target_file — skipping." >&2
    return
  fi

  case "$action" in
    updated)
      echo "[$label] Updated instructions in $target_file"
      ;;
    updated-legacy)
      echo "[$label] Updated instructions in $target_file (replaced legacy block; backup at ${target_file}.bak)"
      ;;
    appended)
      echo "[$label] Appended instructions to $target_file"
      ;;
    appended-legacy-kept)
      echo "[$label] Appended instructions to $target_file"
      echo "[$label] An older Second Brain block is still in that file. We could not tell where it ended, so nothing was deleted — please remove the old copy by hand."
      ;;
    *)
      echo "[$label] Installed instructions in $target_file"
      ;;
  esac
}

echo "── Global instructions ──"
apply_instructions "$HOME/.claude/CLAUDE.md" "AI_Instructions/CLAUDE_INSTRUCTIONS.md" "Claude Code"
apply_instructions "$HOME/.codex/AGENTS.md" "AI_Instructions/CODEX_INSTRUCTIONS.md" "Codex CLI"
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
echo "  • Also using Cursor? Install the agent rule — see AI_Instructions/CURSOR_INSTRUCTIONS.md"
echo "    or the wiki Cursor Instructions page. Quick copy:"
echo "    mkdir -p ~/.cursor/rules && curl -fsSL ${RAW_BASE}/.cursor/rules/second-brain-memory.mdc -o ~/.cursor/rules/second-brain-memory.mdc"
echo "  • Also using the ChatGPT or Claude apps (not Codex CLI / Claude Code)? Their"
echo "    personalization / custom-instruction settings are account-level and have no"
echo "    public write API — paste AI_Instructions/CHATGPT_INSTRUCTIONS.md into ChatGPT's"
echo "    Settings → Personalization → Custom Instructions, and a similar block into"
echo "    claude.ai's profile preferences, by hand."
echo "  • Team Edition (v3.0.0): re-run this script after upgrades to refresh AI_Instructions/*.md."
echo "    v3.0.0 ships one shared team per brain; optional team/list_teams params are API plumbing"
echo "    for a future multi-team release. See CHANGELOG.md."
