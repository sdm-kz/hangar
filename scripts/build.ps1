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

# --- Build stamp ------------------------------------------------------------------------------
# Names this exact build so a running app can tell a staged update apart from itself. deploy.ps1
# copies it next to the exe; the app reads its own from there and the staged one from the update
# folder (see scripts\stage-update.ps1 and server\Update\UpdateService.cs).
$commit  = try { (git -C $root rev-parse --short HEAD 2>$null) } catch { $null }
$branch  = try { (git -C $root rev-parse --abbrev-ref HEAD 2>$null) } catch { $null }
$builtAt = (Get-Date).ToUniversalTime()
$stamp = [ordered]@{
  buildId    = "{0}-{1}" -f $builtAt.ToString("yyyyMMdd'T'HHmmss'Z'"), $(if ($commit) { $commit } else { "nogit" })
  commit     = $commit
  branch     = $branch
  builtAtUtc = $builtAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
}
$stamp | ConvertTo-Json | Set-Content (Join-Path $publish "build.json") -Encoding UTF8

Write-Host "==> Done. Published to: $publish" -ForegroundColor Green
Write-Host "    Build stamp: $($stamp.buildId)" -ForegroundColor DarkGray
Write-Host "    Run the desktop app:  $publish\ClaudeWeb.exe   (starts in the system tray)"
