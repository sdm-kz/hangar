<#
.SYNOPSIS
  Runs backend (.NET) and frontend (Vite) dev servers together for local development.
  Backend: http://127.0.0.1:5099   Frontend: http://localhost:5173 (proxies /api + /hub)

  Run with Windows PowerShell:   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
  (Use scripts\run.ps1 if you just want the app without the Vite dev server.)
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Pick whichever PowerShell host exists (PowerShell 7 'pwsh' or Windows PowerShell).
$psHost = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psHost) { $psHost = (Get-Command powershell -ErrorAction SilentlyContinue).Source }

Write-Host "Starting backend on http://127.0.0.1:5099 (separate window)..." -ForegroundColor Cyan
$server = Start-Process $psHost -PassThru -ArgumentList @(
  "-NoExit", "-Command", "Set-Location '$root\server'; dotnet run --urls http://127.0.0.1:5099"
)
Write-Host "Backend pid $($server.Id)"

Push-Location (Join-Path $root "web")
if (-not (Test-Path "node_modules")) { npm install }
Write-Host "Starting frontend on http://localhost:5173 ..." -ForegroundColor Cyan
npm run dev
Pop-Location
