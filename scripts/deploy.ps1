<#
.SYNOPSIS
  Builds and deploys Claude Web to an install folder (default C:\apps\claude-web).

  Settings are preserved: the target's appsettings.json / appsettings.*.json are NEVER
  overwritten. Everything else (the single-file exe, web.config, wwwroot) is replaced, and
  wwwroot is mirrored so stale hashed assets from previous builds are pruned.

  The running instance (Windows service "ClaudeWeb" or the tray ClaudeWeb.exe) is stopped so
  its files unlock, then restarted the same way it was running. The app resumes the sessions that
  were running before the restart on its own (Sessions:ResumeOnStart, on by default); pass
  -ResumeSessions:$false to launch with --no-resume-sessions and leave them as manual "Reopen"
  entries for this deploy instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Target D:\apps\claude-web -SkipBuild -NoRestart
#>
param(
  [string]$Target = "C:\apps\claude-web",
  [switch]$SkipBuild,           # deploy the existing ./publish output without rebuilding
  [switch]$NoRestart,           # leave the app stopped after deploying
  [bool]$ResumeSessions = $true # relaunch (with --continue) the sessions that were running before the restart
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

# --- 2) Stop the running instance so the single-file exe unlocks; remember how to restart -----
$restart = "none"
$svc = Get-Service -Name "ClaudeWeb" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "==> Stopping ClaudeWeb service" -ForegroundColor Cyan
  Stop-Service -Name "ClaudeWeb" -Force
  $restart = "service"
}
$procs = Get-Process -Name "ClaudeWeb" -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host "==> Stopping running ClaudeWeb.exe ($($procs.Count) process(es))" -ForegroundColor Cyan
  $procs | Stop-Process -Force
  if ($restart -eq "none") { $restart = "tray" }
}
if ($restart -ne "none") { Start-Sleep -Seconds 1 }  # let the OS release file locks

# --- 3) Deploy, preserving settings ----------------------------------------------------------
Write-Host "==> Deploying to $Target (preserving appsettings*.json)" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Target | Out-Null

function Invoke-Robocopy([string]$src, [string]$dst, [string[]]$roboArgs) {
  $quiet = @("/NFL", "/NDL", "/NP", "/NJH", "/NJS")
  $out = robocopy $src $dst @roboArgs @quiet
  # robocopy exit codes 0-7 are success (bit flags); 8+ indicate a real failure.
  if ($LASTEXITCODE -ge 8) { $out; throw "robocopy failed (exit $LASTEXITCODE): $src -> $dst" }
}

# Top-level files (exe, pdb, web.config, endpoints json). No /MIR here so unrelated files the
# target may have (e.g. aspnetcorev2_inprocess.dll) are left alone. Settings are excluded.
Invoke-Robocopy $publish $Target @("/E", "/XD", "wwwroot", "/XF", "appsettings.json", "appsettings.*.json")

# wwwroot is mirrored so renamed/removed hashed assets from old builds are pruned.
Invoke-Robocopy (Join-Path $publish "wwwroot") (Join-Path $Target "wwwroot") @("/MIR")

# First-time deploy (no settings in target yet): seed the published defaults so it can start.
$targetSettings = Join-Path $Target "appsettings.json"
if (-not (Test-Path $targetSettings)) {
  Copy-Item (Join-Path $publish "appsettings.json") $targetSettings
  Write-Host "    Seeded default appsettings.json (first deploy)" -ForegroundColor Yellow
} else {
  Write-Host "    Preserved existing appsettings.json" -ForegroundColor Green
}

# --- 4) Launch the app so it's running after every deploy (unless -NoRestart) ----------------
# Prefer the service when one is installed (whether or not it was running before); otherwise the
# tray exe. This also covers a deploy that started with the app stopped — it still comes back up.
if (-not $NoRestart) {
  if ($restart -eq "service" -or $svc) {
    Write-Host "==> Starting ClaudeWeb service" -ForegroundColor Cyan
    Start-Service -Name "ClaudeWeb"
  } else {
    # The app auto-resumes the sessions that were running before the stop; --no-resume-sessions
    # opts this launch out of that.
    $exe = Join-Path $Target "ClaudeWeb.exe"
    if ($ResumeSessions) {
      Write-Host "==> Launching ClaudeWeb.exe (system tray, resuming sessions)" -ForegroundColor Cyan
      Start-Process $exe -ArgumentList "--resume-sessions"
    } else {
      Write-Host "==> Launching ClaudeWeb.exe (system tray, not resuming sessions)" -ForegroundColor Cyan
      Start-Process $exe -ArgumentList "--no-resume-sessions"
    }
  }
} else {
  Write-Host "    (-NoRestart) App left stopped. Start it with: $Target\ClaudeWeb.exe" -ForegroundColor DarkGray
}

# Surface the URL from the (preserved) settings for convenience.
try {
  $urls = (Get-Content $targetSettings -Raw | ConvertFrom-Json).Server.Urls
  if ($urls) {
    $port = ([uri](($urls -split ';')[0].Trim() -replace '0\.0\.0\.0|\*|\+','localhost')).Port
    Write-Host "==> Deployed. UI: http://localhost:$port" -ForegroundColor Green
  } else { Write-Host "==> Deployed to $Target" -ForegroundColor Green }
} catch { Write-Host "==> Deployed to $Target" -ForegroundColor Green }
