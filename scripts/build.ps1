# Builds the SPA and publishes the tray app (single self-contained exe) into ./publish
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> Building frontend (web)" -ForegroundColor Cyan
Push-Location (Join-Path $root "web")
if (-not (Test-Path "node_modules")) { npm install }
npm run build            # emits into ../server/wwwroot
Pop-Location

Write-Host "==> Publishing tray app (server)" -ForegroundColor Cyan
$publish = Join-Path $root "publish"
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
Push-Location (Join-Path $root "server")
# Self-contained single-file so it runs on a machine without the .NET runtime installed.
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $publish
Pop-Location

Write-Host "==> Done. Published to: $publish" -ForegroundColor Green
Write-Host "    Run the desktop app:  $publish\ClaudeWeb.exe   (starts in the system tray)"
