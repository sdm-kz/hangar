<#
.SYNOPSIS
  Runs backend (.NET) and frontend (Vite) dev servers together for local development.
  Backend: http://127.0.0.1:5099   Frontend: http://localhost:5173 (proxies /api + /hub)

  Run with Windows PowerShell:   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
  (Use scripts\run.ps1 if you just want the app without the Vite dev server.)

.PARAMETER Port
  Backend port. 5099 is the installed app's own port, so this only starts while that app is
  stopped — which is the usual way to work on it. Pass another port to run BESIDE the installed
  app, and the Claude hooks are then left alone (see below).

.PARAMETER Hooks
  Register this instance's Claude hooks in ~/.claude/settings.json. Defaults to on for the
  installed app's port and OFF for any other, because that file is GLOBAL: every Claude Code
  session on the machine posts its tool-use events to whatever port is registered there. A second
  instance on another port used to quietly claim them, and stopping it then left every session
  failing every tool call with "hook error connect ECONNREFUSED". On 5099 the registration this
  writes is the one the installed app wants anyway, so it stays on.
#>
param(
  [int]$Port = 5099,
  [switch]$Hooks
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# The port the installed app runs on (server/appsettings.json → Server:Urls).
$appPort = 5099
$useHooks = $Hooks.IsPresent -or ($Port -eq $appPort)

# Pick whichever PowerShell host exists (PowerShell 7 'pwsh' or Windows PowerShell).
$psHost = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psHost) { $psHost = (Get-Command powershell -ErrorAction SilentlyContinue).Source }

$serverArgs = "--urls http://127.0.0.1:$Port"
if (-not $useHooks) {
  $serverArgs += " --Hooks:Enabled=false"
  Write-Host "Claude hooks left untouched (port $Port is not the app's $appPort). Pass -Hooks to override." -ForegroundColor DarkGray
}

Write-Host "Starting backend on http://127.0.0.1:$Port (separate window)..." -ForegroundColor Cyan
$server = Start-Process $psHost -PassThru -ArgumentList @(
  "-NoExit", "-Command", "Set-Location '$root\server'; dotnet run $serverArgs"
)
Write-Host "Backend pid $($server.Id)"

Push-Location (Join-Path $root "web")
if (-not (Test-Path "node_modules")) { npm install }
$env:BACKEND_URL = "http://127.0.0.1:$Port"
Write-Host "Starting frontend on http://localhost:5173 ..." -ForegroundColor Cyan
npm run dev
Pop-Location
