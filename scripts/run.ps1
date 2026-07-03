<#
.SYNOPSIS
  Runs just the backend, which also serves the already-built web UI.
  Browse to the URL from Server:Urls in server/appsettings.json (default http://localhost:5099).

  Windows PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\run.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Ensure the SPA is built into server/wwwroot so the backend has something to serve.
if (-not (Test-Path (Join-Path $root "server\wwwroot\index.html"))) {
  Write-Host "Building web UI first..." -ForegroundColor Cyan
  Push-Location (Join-Path $root "web")
  if (-not (Test-Path "node_modules")) { npm install }
  npm run build
  Pop-Location
}

Push-Location (Join-Path $root "server")
Write-Host "Starting Claude Web..." -ForegroundColor Cyan
dotnet run
Pop-Location
