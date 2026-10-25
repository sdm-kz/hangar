<#
.SYNOPSIS
  Runs just the backend from source, which also serves the already-built web UI.
  Browse to http://127.0.0.1:5199 (or the -Port you pass).

  Windows PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\run.ps1

.DESCRIPTION
  Runs as a dev instance, the same way scripts\dev.ps1 does (see its help for the why of each):
  on -Port as Server:Urls with the launch profile skipped, with Claude hooks off
  (Hooks:Enabled=false -- ~/.claude/settings.json is global, and a dev instance registering itself
  there would break every Claude session on the machine once it stopped), without resuming sessions
  on start, and with a data folder of its own: HANGAR_TEST_ROOT is set to -DataRoot (default:
  HANGAR_TEST_ROOT when already set, else %LocalAppData%\Hangar-dev) unless -SharedData asks for the
  installed app's %LocalAppData%\Hangar.

.PARAMETER Port
  Port to listen on. Defaults to 5199, beside the installed app's 5099.

.PARAMETER DataRoot
  Folder that stands in for %LocalAppData% for this instance (HANGAR_TEST_ROOT).

.PARAMETER SharedData
  Use the real %LocalAppData%\Hangar data folder, the installed app's, instead of -DataRoot.
#>
param(
  [int]$Port = 5199,
  [string]$DataRoot,
  [switch]$SharedData
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "_paths.ps1")

# Ensure the SPA is built into server/wwwroot so the backend has something to serve.
if (-not (Test-Path (Join-Path $root "server\wwwroot\index.html"))) {
  Write-Host "Building web UI first..." -ForegroundColor Cyan
  Push-Location (Join-Path $root "web")
  try {
    if (-not (Test-Path "node_modules")) {
      npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
  } finally { Pop-Location }
}

# Set for the child only: put back as it was afterwards, since this script may run in the caller's shell.
$hadTestRoot = Test-Path Env:HANGAR_TEST_ROOT
$oldTestRoot = $env:HANGAR_TEST_ROOT
if ($SharedData) {
  Remove-Item Env:HANGAR_TEST_ROOT -ErrorAction SilentlyContinue
  Write-Host "Data folder: the installed app's (%LocalAppData%\Hangar) -- stop the installed app first." -ForegroundColor Yellow
} else {
  if (-not $DataRoot) { $DataRoot = Get-HangarDevTestRoot }
  New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
  $env:HANGAR_TEST_ROOT = $DataRoot
  Write-Host "Data folder: $DataRoot\Hangar (HANGAR_TEST_ROOT)" -ForegroundColor DarkGray
}

Push-Location (Join-Path $root "server")
try {
  Write-Host "Starting Hangar on http://127.0.0.1:$Port (Claude hooks off)..." -ForegroundColor Cyan
  # Each argument quoted: an unquoted "--" or "--Name:value" can be taken apart by PowerShell's own parsing.
  dotnet run --no-launch-profile "--" "--Server:Urls=http://127.0.0.1:$Port" "--Hooks:Enabled=false" "--Sessions:ResumeOnStart=false"
} finally {
  Pop-Location
  if ($hadTestRoot) { $env:HANGAR_TEST_ROOT = $oldTestRoot } else { Remove-Item Env:HANGAR_TEST_ROOT -ErrorAction SilentlyContinue }
}
