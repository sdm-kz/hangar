<#
.SYNOPSIS
  Builds and deploys Hangar to an install folder (default C:\apps\hangar).

  Settings are preserved: the target's appsettings.json / appsettings.*.json are NEVER
  overwritten. Everything else (the single-file exes, web.config, wwwroot) is replaced, and
  wwwroot is mirrored so stale hashed assets from previous builds are pruned.

  The running daemon (Windows service "Hangar", or Hangar.exe started at logon) and this
  install's tray (Hangar.Tray.exe) are stopped so their files unlock; then the daemon is restarted
  the same way it was running, and the tray is started again if it was running. Running sessions
  survive this: each one's pseudoconsole lives in its own Hangar.PtyHost.exe, which is left alone
  (the process matches below are by exact name and catch neither "Hangar.PtyHost" nor, for the
  daemon, "Hangar.Tray"), so the restarted daemon re-attaches to them rather than relaunching them.
  A session that genuinely died still comes back by resuming its conversation
  (Sessions:ResumeOnStart, on by default); pass -ResumeSessions:$false to launch with
  --no-resume-sessions and leave those as manual "Reopen" entries for this deploy instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Target D:\apps\hangar -SkipBuild -NoRestart
#>
param(
  [string]$Target = "C:\apps\hangar",
  [switch]$SkipBuild,           # deploy the existing ./publish output without rebuilding
  [switch]$NoRestart,           # leave the app stopped after deploying
  [bool]$ResumeSessions = $true # relaunch (with --continue) the sessions that were running before the restart
)

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$publish = Join-Path $root "publish"

# --- 1) Build + publish (single self-contained exes into ./publish) --------------------------
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build.ps1")
} elseif (-not (Test-Path (Join-Path $publish "Hangar.exe"))) {
  throw "No published build at '$publish'. Run without -SkipBuild first."
}

# --- 2) Stop what holds the install's files; remember how the daemon was running ---------------
# The tray first: it is only a client, nothing is lost by closing it, and closing it before the daemon
# spares it announcing that the server went away. Only this install's tray, matched by its exe path: a
# tray running from anywhere else (a dev build following another port) is not ours to close, and would
# not be started again below.
$trayExe = [IO.Path]::GetFullPath((Join-Path $Target "Hangar.Tray.exe"))
$trays = @(Get-Process -Name "Hangar.Tray" -ErrorAction SilentlyContinue | Where-Object {
  # .Path throws for a process we can't open; such a process isn't ours to stop either.
  try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $trayExe) } catch { $false }
})
if ($trays.Count -gt 0) {
  Write-Host "==> Closing the tray ($($trays.Count) process(es))" -ForegroundColor Cyan
  $trays | Stop-Process -Force
}

# Hangar Snap, the screenshot app the tray took over (scripts\deploy-snap.ps1 used to install it to
# C:\apps\hangar-snap). Left running it would hold the capture hotkeys the tray registers. Its sign-in
# entry is removed by the tray itself on its first run, and its settings carried over.
$hadSnap = $false
$snaps = @(Get-Process -Name "hangar-snap", "homeport-snap" -ErrorAction SilentlyContinue)
if ($snaps.Count -gt 0) {
  Write-Host "==> Closing Hangar Snap ($($snaps.Count) process(es)); the tray does what it did" -ForegroundColor Cyan
  $snaps | Stop-Process -Force
  $hadSnap = $true
}

$restart = "none"
$svc = Get-Service -Name "Hangar" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "==> Stopping Hangar service" -ForegroundColor Cyan
  Stop-Service -Name "Hangar" -Force
  $restart = "service"
}
$procs = Get-Process -Name "Hangar" -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host "==> Stopping running Hangar.exe ($($procs.Count) process(es))" -ForegroundColor Cyan
  $procs | Stop-Process -Force
  if ($restart -eq "none") { $restart = "process" }
}
if ($restart -ne "none" -or $trays.Count -gt 0) { Start-Sleep -Seconds 1 }  # let the OS release file locks

# --- 3) Deploy, preserving settings ----------------------------------------------------------
Write-Host "==> Deploying to $Target (preserving appsettings*.json)" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Target | Out-Null

function Invoke-Robocopy([string]$src, [string]$dst, [string[]]$roboArgs) {
  $quiet = @("/NFL", "/NDL", "/NP", "/NJH", "/NJS")
  $out = robocopy $src $dst @roboArgs @quiet
  # robocopy exit codes 0-7 are success (bit flags); 8+ indicate a real failure.
  if ($LASTEXITCODE -ge 8) { $out; throw "robocopy failed (exit $LASTEXITCODE): $src -> $dst" }
}

# Top-level files (exes, pdbs, web.config, endpoints json). No /MIR here so unrelated files the
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

# A build staged for the in-app updater before this deploy is now older than what is installed. Left
# there, it would be offered as an "update" and roll the app back (an app from before the updater
# compared build times did exactly that). Removed, unless it is newer than the build just deployed.
$staging = "C:\apps\hangar-updates"
try {
  $configured = (Get-Content $targetSettings -Raw | ConvertFrom-Json).Update.StagingPath
  if ($configured) { $staging = $configured }
} catch { }
$payload = Join-Path $staging "payload"
$stagedStamp = Join-Path $payload "build.json"
if (Test-Path $stagedStamp) {
  try {
    $staged = Get-Content $stagedStamp -Raw | ConvertFrom-Json
    $deployed = Get-Content (Join-Path $Target "build.json") -Raw | ConvertFrom-Json
    if ([datetime]$staged.builtAtUtc -le [datetime]$deployed.builtAtUtc) {
      Remove-Item -Recurse -Force $payload
      Write-Host "    Removed the staged update $($staged.buildId): not newer than this deploy" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "    Could not compare the staged update with this deploy: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# --- 4) Launch the app so it's running after every deploy (unless -NoRestart) ----------------
# Prefer the service when one is installed (whether or not it was running before); otherwise the
# daemon exe. This also covers a deploy that started with the app stopped — it still comes back up.
if (-not $NoRestart) {
  if ($restart -eq "service" -or $svc) {
    Write-Host "==> Starting Hangar service" -ForegroundColor Cyan
    Start-Service -Name "Hangar"
  } else {
    # The app auto-resumes the sessions that were running before the stop; --no-resume-sessions
    # opts this launch out of that.
    $exe = Join-Path $Target "Hangar.exe"
    if ($ResumeSessions) {
      Write-Host "==> Launching Hangar.exe (daemon, resuming sessions)" -ForegroundColor Cyan
      Start-Process $exe -ArgumentList "--resume-sessions"
    } else {
      Write-Host "==> Launching Hangar.exe (daemon, not resuming sessions)" -ForegroundColor Cyan
      Start-Process $exe -ArgumentList "--no-resume-sessions"
    }
  }

  # The tray comes back if it was running — whichever way the daemon runs, since it finds the daemon on
  # its own and waits for it to listen. An install set up without one (register-autostart -NoTray)
  # stays without one.
  # One that replaces a running Hangar Snap starts too, or the screenshots would go with Snap.
  if (($trays.Count -gt 0 -or $hadSnap) -and (Test-Path $trayExe)) {
    Write-Host "==> Launching Hangar.Tray.exe" -ForegroundColor Cyan
    Start-Process $trayExe -ArgumentList "--autostart"
  }
} else {
  Write-Host "    (-NoRestart) App left stopped. Start it with: $Target\Hangar.exe (and $Target\Hangar.Tray.exe)" -ForegroundColor DarkGray
}

# Surface the URL from the (preserved) settings for convenience.
try {
  $urls = (Get-Content $targetSettings -Raw | ConvertFrom-Json).Server.Urls
  if ($urls) {
    $port = ([uri](($urls -split ';')[0].Trim() -replace '0\.0\.0\.0|\*|\+','localhost')).Port
    Write-Host "==> Deployed. UI: http://localhost:$port" -ForegroundColor Green
  } else { Write-Host "==> Deployed to $Target" -ForegroundColor Green }
} catch { Write-Host "==> Deployed to $Target" -ForegroundColor Green }
