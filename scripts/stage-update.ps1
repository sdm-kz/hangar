<#
.SYNOPSIS
  Builds Claude Web and stages the result as a pending update, without touching the running app.

.DESCRIPTION
  This is the "publish an update" half of the in-app updater. It builds (scripts\build.ps1) and drops
  the published output into <Staging>\payload. The live app watches that folder: as soon as the staged
  build.json names a build id other than its own, an "Update available" button appears in the UI, and
  clicking it hands off to scripts\apply-update.ps1 -- which stops the app, mirrors the payload over the
  install folder and restarts it. Sessions that were running come back on their own (Sessions:ResumeOnStart).

  Nothing here stops or overwrites the running app, so staging is safe at any time. The payload is
  built in <Staging>\payload.tmp and swapped into place at the end, so the app never sees a half-copied
  update.

  The install folder's appsettings*.json are never part of the payload's authority -- apply-update.ps1
  preserves the ones already installed, exactly like deploy.ps1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1 -Staging D:\apps\claude-web-updates -SkipBuild
#>
param(
  [string]$Staging = "C:\apps\claude-web-updates",
  [switch]$SkipBuild   # stage the existing ./publish output without rebuilding
)

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$publish = Join-Path $root "publish"

# --- 1) Build + publish (single self-contained exe into ./publish) ---------------------------
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build.ps1")
} elseif (-not (Test-Path (Join-Path $publish "ClaudeWeb.exe"))) {
  throw "No published build at '$publish'. Run without -SkipBuild first."
}

$stampFile = Join-Path $publish "build.json"
if (-not (Test-Path $stampFile)) {
  throw "No build stamp at '$stampFile'. Rebuild with scripts\build.ps1 (it writes build.json)."
}
$stamp = Get-Content $stampFile -Raw | ConvertFrom-Json

# --- 2) Copy into a scratch payload, then swap it in ------------------------------------------
# Building the payload under a temp name means an app polling <Staging>\payload never reads a
# partially-copied build: it sees the previous payload, then the new one, never a mixture.
$final = Join-Path $Staging "payload"
$tmp   = Join-Path $Staging "payload.tmp"
$old   = Join-Path $Staging "payload.old"

New-Item -ItemType Directory -Force -Path $Staging | Out-Null
foreach ($stale in @($tmp, $old)) {
  if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
}

Write-Host "==> Staging update $($stamp.buildId) -> $final" -ForegroundColor Cyan
$quiet = @("/NFL", "/NDL", "/NP", "/NJH", "/NJS")
robocopy $publish $tmp /E @quiet | Out-Null
# robocopy exit codes 0-7 are success (bit flags); 8+ indicate a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE): $publish -> $tmp" }

# Swap: rename the live payload out of the way, the new one in, then drop the old. A rename within
# one folder is near-instant, so the window where <Staging>\payload doesn't exist is negligible --
# and the app treats "no payload" as simply nothing staged, never as an error.
if (Test-Path $final) { Rename-Item $final -NewName "payload.old" }
Rename-Item $tmp -NewName "payload"
if (Test-Path $old) { Remove-Item $old -Recurse -Force }

Write-Host "==> Staged. The running app will offer this build in its UI." -ForegroundColor Green
Write-Host "    Build:  $($stamp.buildId)"
Write-Host "    Commit: $($stamp.commit)  Branch: $($stamp.branch)"
Write-Host "    If no button appears, check Update:StagingPath in the app's appsettings.json -- it must point at '$Staging'."
