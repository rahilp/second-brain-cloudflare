<#
.SYNOPSIS
  Installs, upgrades, checks or removes the Second Brain hooks in Claude Code's
  user settings (%USERPROFILE%\.claude\settings.json).

.DESCRIPTION
  The PowerShell mirror of install.sh, for Windows machines where Claude Code
  runs its hooks under PowerShell rather than Git Bash. Same guarantees:
  credentials go to ~/.config/second-brain/config.json (the file the CLI and the
  desktop app already use), never into settings.json and never onto the hook
  command line; re-running reconciles our own entries instead of appending;
  a settings.json that is not valid JSON is refused, not overwritten.

  Node.js does the JSON editing so this script and install.sh cannot drift:
  PowerShell's ConvertTo-Json would flatten deeply nested settings.

.PARAMETER WorkerUrl
  Worker origin, e.g. https://your-worker.workers.dev. Prompted for when absent.

.PARAMETER Token
  AUTH_TOKEN for that worker. Prompted for when absent.

.PARAMETER Check
  Prove the hooks reach the Worker and show what they would do.

.PARAMETER Uninstall
  Remove only our entries from settings.json. Credentials are left in place.

.EXAMPLE
  .\install.ps1 -WorkerUrl https://your-worker.workers.dev -Token your-token

.EXAMPLE
  .\install.ps1 -Check

.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [string]$WorkerUrl,
  [string]$Token,
  [switch]$Check,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# Write-Error under -ErrorActionPreference Stop always ends the script with exit
# code 1; the installer needs its own codes (2 = no credentials and no console).
function Stop-WithError {
  param([string]$Message, [int]$Code = 1)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

$HooksDir = $PSScriptRoot
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$SettingsFile = if ($env:CLAUDE_SETTINGS_FILE) { $env:CLAUDE_SETTINGS_FILE } else { Join-Path $HomeDir ".claude/settings.json" }
$ConfigDir = Join-Path $HomeDir ".config/second-brain"
$ConfigFile = Join-Path $ConfigDir "config.json"
$Mode = if ($Uninstall) { "uninstall" } else { "install" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithError "Error: Node.js is required to run the hook scripts."
}

if ($Check) {
  # check.js reports its own failures and exits non-zero; that is a result, not
  # a terminating error, so PowerShell 7.4 must not throw on it.
  $PSNativeCommandUseErrorActionPreference = $false
  $ErrorActionPreference = "Continue"
  & node (Join-Path $HooksDir "check.js")
  exit $LASTEXITCODE
}

# Node reads the script from a temp file rather than stdin so a console encoding
# cannot corrupt it. Node's own output goes straight to the host, so the only
# value this function returns is node's exit code.
function Invoke-NodeScript {
  param([string]$Script)
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sb-hooks-" + [Guid]::NewGuid().ToString("N") + ".js")
  try {
    Set-Content -Path $tmp -Value $Script -Encoding utf8
    # A non-zero exit from node is a result to inspect, not a terminating error;
    # PowerShell 7.4 would otherwise throw before the exit code can be read.
    # Both assignments are function-local.
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = "Continue"
    & node $tmp 2>&1 | Out-Host
    return $LASTEXITCODE
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }
}

$ConfigWriter = @'
const fs = require('fs');
const { WORKER_URL, TOKEN, CONFIG_FILE } = process.env;
let existing = {};
try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
const next = { ...existing, workerUrl: WORKER_URL, authToken: TOKEN };
const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
// mode 0600 is a no-op on NTFS; the file still stays out of settings.json.
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, CONFIG_FILE);
'@

$SettingsWriter = @'
const fs = require('fs');
const { SETTINGS_FILE, HOOKS_DIR, MODE } = process.env;

let settings = {};
if (fs.existsSync(SETTINGS_FILE)) {
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  if (raw.trim()) {
    try { settings = JSON.parse(raw); } catch (e) {
      console.error(`Refusing to touch ${SETTINGS_FILE}: it is not valid JSON (${e.message}).`);
      console.error('Claude Code settings must be plain JSON — no comments or trailing commas. Fix the file and re-run.');
      process.exit(1);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.error(`Refusing to touch ${SETTINGS_FILE}: expected a JSON object at the top level.`);
      process.exit(1);
    }
  }
}

// Ours = any entry whose command runs a script from this folder, regardless of
// the checkout path or the pre-PR-A `VAR=x node …` form. Windows paths normalised.
const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) =>
  typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('/claude-code-hooks/session-'));

settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
for (const ev of ['SessionStart', 'SessionEnd']) {
  settings.hooks[ev] = (Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : []).filter((e) => !isOurs(e));
}
delete settings['second-brain-hooks']; // the old idempotency marker

if (MODE !== 'uninstall') {
  const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
  settings.hooks.SessionStart.push({
    matcher: 'startup|clear|compact',
    hooks: [{ type: 'command', command: `node ${q(`${HOOKS_DIR}/session-start.js`)}` }],
  });
  settings.hooks.SessionEnd.push({
    // SessionEnd hooks share a 1.5 s budget unless an entry asks for more; the
    // capture waits on an embedding and often a model call before the reply.
    hooks: [{ type: 'command', command: `node ${q(`${HOOKS_DIR}/session-end.js`)}`, timeout: 30 }],
  });
}
for (const ev of ['SessionStart', 'SessionEnd']) if (!settings.hooks[ev].length) delete settings.hooks[ev];
if (!Object.keys(settings.hooks).length) delete settings.hooks;

if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak-${Date.now()}`);
const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
fs.renameSync(tmp, SETTINGS_FILE);
console.log(`${MODE === 'uninstall' ? 'Removed Second Brain hooks from' : 'Updated'} ${SETTINGS_FILE}`);
'@

if ($Mode -eq "install") {
  if ([string]::IsNullOrWhiteSpace($WorkerUrl) -and [string]::IsNullOrWhiteSpace($Token) -and (Test-Path $ConfigFile)) {
    Write-Host "Using credentials from $ConfigFile"
  } else {
    if ([string]::IsNullOrWhiteSpace($WorkerUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
      # The analogue of bash's `[[ ! -t 0 ]]`: never hang a scripted install on a prompt.
      if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
        Stop-WithError "Usage: .\install.ps1 -WorkerUrl <worker-url> -Token <auth-token>   (no console to prompt on)" 2
      }
      if ([string]::IsNullOrWhiteSpace($WorkerUrl)) {
        $WorkerUrl = Read-Host "Enter your Second Brain worker URL (e.g. https://your-worker.workers.dev)"
      }
      if ([string]::IsNullOrWhiteSpace($Token)) {
        $secure = Read-Host "Enter your AUTH_TOKEN" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
      }
    }
    $WorkerUrl = $WorkerUrl.Trim().TrimEnd("/")
    if ($WorkerUrl -notmatch "^https?://") {
      Stop-WithError "Error: worker URL must start with http:// or https:// (got: $WorkerUrl)"
    }
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    $env:WORKER_URL = $WorkerUrl
    $env:TOKEN = $Token
    $env:CONFIG_FILE = $ConfigFile
    $code = Invoke-NodeScript $ConfigWriter
    $env:TOKEN = $null
    if ($code -ne 0) { Stop-WithError "Error: could not write $ConfigFile" $code }
    Write-Host "Wrote $ConfigFile"
  }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $SettingsFile) -Force | Out-Null

$env:SETTINGS_FILE = $SettingsFile
# Forward slashes so the written command reads the same as install.sh's; node and
# Claude Code both accept them on Windows.
$env:HOOKS_DIR = $HooksDir.Replace("\", "/")
$env:MODE = $Mode
$code = Invoke-NodeScript $SettingsWriter
if ($code -ne 0) { exit $code }

if ($Mode -eq "uninstall") {
  Write-Host "Done. Credentials in $ConfigFile were left in place."
  exit 0
}

Write-Host ""
Write-Host "Done. Second Brain hooks installed."
Write-Host "  SessionStart (startup, /clear, compaction): recalls context for the current project"
Write-Host "  SessionEnd:                                  saves the conversation (needs Worker 3.0+)"
Write-Host ""
Write-Host "Sessions already open keep the old hook config — restart them."
Write-Host "Verify with: powershell -File `"$HooksDir\install.ps1`" -Check"
