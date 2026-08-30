<#
.SYNOPSIS
  Wires up Second Brain for Claude Code and Codex CLI in one shot:
    - installs or updates global system instructions in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
    - registers the /mcp endpoint as an MCP server via OAuth (no token ever stored here)

.USAGE
  iex "& { $(irm <raw-url>/scripts/connect-ai-clients.ps1) } -WorkerUrl https://YOUR-WORKER-URL"
#>

param(
  [string]$WorkerUrl
)

$ErrorActionPreference = "Stop"

$RawBase = "https://raw.githubusercontent.com/rahilp/second-brain-cloudflare/main"

if ([string]::IsNullOrWhiteSpace($WorkerUrl)) {
  $WorkerUrl = Read-Host "Enter your Second Brain worker URL (e.g. https://your-worker.workers.dev)"
}

$WorkerUrl = $WorkerUrl.TrimEnd("/")

if ($WorkerUrl -notmatch "^https?://") {
  Write-Error "Worker URL must start with http:// or https:// (got: $WorkerUrl)"
  exit 1
}

$McpUrl = "$WorkerUrl/mcp"

Write-Host "Worker URL: $WorkerUrl"
Write-Host "MCP endpoint: $McpUrl"
Write-Host ""

function Resolve-InstructionBlockHelper {
  $localHelper = Join-Path $PSScriptRoot "instruction-block.mjs"
  if (Test-Path $localHelper) {
    return $localHelper
  }

  $tmp = [System.IO.Path]::GetTempFileName()
  Invoke-RestMethod -Uri "$RawBase/scripts/instruction-block.mjs" -OutFile $tmp
  return $tmp
}

$InstructionBlockHelper = Resolve-InstructionBlockHelper
$RemoveTempHelper = $InstructionBlockHelper -ne (Join-Path $PSScriptRoot "instruction-block.mjs")

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is required to install or update Second Brain instructions."
  exit 1
}

function Apply-Instructions {
  param(
    [string]$TargetFile,
    [string]$SourcePath,
    [string]$Label
  )

  $dir = Split-Path -Parent $TargetFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (-not (Test-Path $TargetFile)) { New-Item -ItemType File -Path $TargetFile -Force | Out-Null }

  try {
    $body = Invoke-RestMethod -Uri "$RawBase/$SourcePath" -ErrorAction Stop
  } catch {
    Write-Warning "[$Label] Could not fetch instruction body from $RawBase/$SourcePath - skipping."
    return
  }

  try {
    $action = $body | node $InstructionBlockHelper $TargetFile
  } catch {
    Write-Warning "[$Label] Failed to update instructions in $TargetFile - skipping."
    return
  }

  switch ($action) {
    "updated" {
      Write-Host "[$Label] Updated instructions in $TargetFile"
    }
    "updated-legacy" {
      Write-Host "[$Label] Updated instructions in $TargetFile (replaced legacy block; backup at ${TargetFile}.bak)"
    }
    "appended-legacy-kept" {
      Write-Host "[$Label] Appended instructions to $TargetFile"
      Write-Host "[$Label] An older Second Brain block is still in that file. We could not tell where it ended, so nothing was deleted — please remove the old copy by hand."
    }
    "appended" {
      Write-Host "[$Label] Appended instructions to $TargetFile"
    }
    default {
      Write-Host "[$Label] Installed instructions in $TargetFile"
    }
  }
}

Write-Host "-- Global instructions --"
Apply-Instructions -TargetFile (Join-Path $env:USERPROFILE ".claude\CLAUDE.md") -SourcePath "AI_Instructions/CLAUDE_INSTRUCTIONS.md" -Label "Claude Code"
Apply-Instructions -TargetFile (Join-Path $env:USERPROFILE ".codex\AGENTS.md") -SourcePath "AI_Instructions/CODEX_INSTRUCTIONS.md" -Label "Codex CLI"

if ($RemoveTempHelper -and (Test-Path $InstructionBlockHelper)) {
  Remove-Item -Force $InstructionBlockHelper
}
Write-Host ""

Write-Host "-- MCP server registration (OAuth - no token needed here) --"

if (Get-Command claude -ErrorAction SilentlyContinue) {
  $alreadyRegistered = $false
  try { claude mcp get second-brain *> $null; $alreadyRegistered = $true } catch { $alreadyRegistered = $false }

  if ($alreadyRegistered) {
    Write-Host "[Claude Code] 'second-brain' MCP server is already registered - skipping."
  } else {
    try {
      claude mcp add --transport http second-brain $McpUrl
      Write-Host "[Claude Code] Registered 'second-brain'. You'll be prompted to authorize in your browser on first use."
    } catch {
      Write-Warning "[Claude Code] Failed to register 'second-brain' - you can add it manually with:`n  claude mcp add --transport http second-brain `"$McpUrl`""
    }
  }
} else {
  Write-Host "[Claude Code] 'claude' CLI not found on PATH - skipping."
}

if (Get-Command codex -ErrorAction SilentlyContinue) {
  $alreadyRegistered = $false
  try { codex mcp get second-brain *> $null; $alreadyRegistered = $true } catch { $alreadyRegistered = $false }

  if ($alreadyRegistered) {
    Write-Host "[Codex CLI] 'second-brain' MCP server is already registered - skipping."
  } else {
    try {
      codex mcp add second-brain --url $McpUrl
      Write-Host "[Codex CLI] Registered 'second-brain' and started the OAuth login flow."
    } catch {
      Write-Warning "[Codex CLI] Failed to register 'second-brain' - you can add it manually with:`n  codex mcp add second-brain --url `"$McpUrl`""
    }
  }
} else {
  Write-Host "[Codex CLI] 'codex' CLI not found on PATH - skipping."
}

Write-Host ""
Write-Host "-- Done --"
Write-Host "Reminders:"
Write-Host "  - On first use you'll be prompted in your browser to enter your AUTH_TOKEN -"
Write-Host "    that's the one-time OAuth handshake. (If you connect both Claude Code and"
Write-Host "    Codex in the same browser session, you may only be asked once.)"
Write-Host "  - Also using Cursor? Install the agent rule - see AI_Instructions/CURSOR_INSTRUCTIONS.md"
Write-Host "    or the wiki Cursor Instructions page. Quick copy (PowerShell):"
Write-Host '    New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ".cursor\rules") | Out-Null'
Write-Host "    Invoke-WebRequest -Uri `"$RawBase/.cursor/rules/second-brain-memory.mdc`" -OutFile (Join-Path `$env:USERPROFILE `".cursor\rules\second-brain-memory.mdc`")"
Write-Host "  - Also using the ChatGPT or Claude apps (not Codex CLI / Claude Code)? Their"
Write-Host "    personalization / custom-instruction settings are account-level and have no"
Write-Host "    public write API - paste AI_Instructions/CHATGPT_INSTRUCTIONS.md into ChatGPT's"
Write-Host "    Settings -> Personalization -> Custom Instructions, and a similar block into"
Write-Host "    claude.ai's profile preferences, by hand."
Write-Host "  - Team Edition (v3.0.0): re-run this script after upgrades to refresh AI_Instructions/*.md."
Write-Host "    v3.0.0 ships one shared team per brain; optional team/list_teams params are API plumbing"
Write-Host "    for a future multi-team release. See CHANGELOG.md."
