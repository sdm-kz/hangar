<#
.SYNOPSIS
  Runs backend (.NET) and frontend (Vite) dev servers together for local development.
  Backend: http://127.0.0.1:5199   Frontend: http://localhost:5173 (proxies /api + /hub to the backend)

  Run with Windows PowerShell:   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
  (Use scripts\run.ps1 if you just want the app without the Vite dev server.)

.DESCRIPTION
  A dev instance is made to run BESIDE an installed Hangar without disturbing it:

    * It listens on -Port (5199), not the installed app's 5099. The port goes in as Server:Urls, the
      setting the app binds; `dotnet run --urls` would be ignored. The launch profile is skipped
      (--no-launch-profile) so it can't put its own port back, and Vite is pointed at the same port
      through BACKEND_URL (web\vite.config.ts falls back to 5099 without it).
    * Claude hooks are always off (Hooks:Enabled=false). ~/.claude/settings.json is GLOBAL: every
      Claude Code session on the machine posts its tool-use events to the port registered there, so a
      dev instance that registered itself would claim them all -- and, once stopped, leave every
      session failing every tool call with "hook error connect ECONNREFUSED".
    * Sessions are not resumed on start (Sessions:ResumeOnStart=false).
    * Its data folder is its own. The app keeps its data (sessions, settings, node identity, pty host
      state) in %LocalAppData%\Hangar, shared by every instance of it on the machine unless
      HANGAR_TEST_ROOT says otherwise. This script sets HANGAR_TEST_ROOT for the backend to -DataRoot
      (default: HANGAR_TEST_ROOT when already set, else %LocalAppData%\Hangar-dev), so the data lands
      in <DataRoot>\Hangar. -SharedData uses the real %LocalAppData%\Hangar instead -- only with the
      installed app stopped.

.PARAMETER Port
  Backend port. Defaults to 5199, beside the installed app's 5099.

.PARAMETER DataRoot
  Folder that stands in for %LocalAppData% for the backend (HANGAR_TEST_ROOT).

.PARAMETER SharedData
  Use the real %LocalAppData%\Hangar data folder, the installed app's, instead of -DataRoot.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 -Port 5299 -DataRoot D:\scratch\hangar-dev
#>
param(
  [int]$Port = 5199,
  [string]$DataRoot,
  [switch]$SharedData
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_paths.ps1")

# A single-quoted PowerShell literal, for the command line the backend window runs.
function ConvertTo-PsLiteral([string]$value) { "'" + ($value -replace "'", "''") + "'" }

# Pick whichever PowerShell host exists (PowerShell 7 'pwsh' or Windows PowerShell).
$psHost = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psHost) { $psHost = (Get-Command powershell -ErrorAction SilentlyContinue).Source }

if ($SharedData) {
  # Clear one inherited from this shell too, or "shared" would quietly mean something else.
  $dataSetup = "Remove-Item Env:HANGAR_TEST_ROOT -ErrorAction SilentlyContinue; "
  Write-Host "Data folder: the installed app's (%LocalAppData%\Hangar) -- stop the installed app first." -ForegroundColor Yellow
} else {
  if (-not $DataRoot) { $DataRoot = Get-HangarDevTestRoot }
  New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
  $dataSetup = "`$env:HANGAR_TEST_ROOT = $(ConvertTo-PsLiteral $DataRoot); "
  Write-Host "Data folder: $DataRoot\Hangar (HANGAR_TEST_ROOT)" -ForegroundColor DarkGray
}

# Each argument quoted: an unquoted "--" or "--Name:value" can be taken apart by PowerShell's own parsing
# before dotnet sees it.
$serverArgs = "'--' '--Server:Urls=http://127.0.0.1:$Port' '--Hooks:Enabled=false' '--Sessions:ResumeOnStart=false'"
$command = $dataSetup + "Set-Location -LiteralPath $(ConvertTo-PsLiteral (Join-Path $root 'server')); " +
  "dotnet run --no-launch-profile $serverArgs"
Write-Host "Starting backend on http://127.0.0.1:$Port (separate window; Claude hooks off)..." -ForegroundColor Cyan
# -EncodedCommand: the command reaches the new window exactly as written, whatever quotes or spaces the
# paths in it hold -- a plain -Command string is split and re-joined by the command line on the way.
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$server = Start-Process $psHost -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $encoded)
Write-Host "Backend pid $($server.Id)"

Push-Location (Join-Path $root "web")
try {
  if (-not (Test-Path "node_modules")) {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
  }
  # vite.config.ts proxies /api and /hub to BACKEND_URL; the default it falls back to is the installed app.
  $env:BACKEND_URL = "http://127.0.0.1:$Port"
  Write-Host "Starting frontend on http://localhost:5173 ..." -ForegroundColor Cyan
  npm run dev
} finally {
  Pop-Location
}
