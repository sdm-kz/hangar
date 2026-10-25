<#
.SYNOPSIS
  Builds and deploys Hangar to an install folder: -Target, else $env:HANGAR_INSTALL_DIR, else
  %LocalAppData%\Programs\Hangar (see scripts\_paths.ps1).

  Settings are preserved: the target's appsettings.json / appsettings.*.json are NEVER
  overwritten. Everything else (the single-file exes, web.config, wwwroot) is replaced, and
  wwwroot is mirrored so stale hashed assets from previous builds are pruned.

  This install's running daemon (the Windows service "Hangar" when it runs from -Target, or
  Hangar.exe started at logon) and its tray (Hangar.Tray.exe) are stopped so their files unlock; then
  the daemon is restarted the same way it was running, and the tray is started again if it was
  running. Processes are matched by their exe's full path, never by name alone: another Hangar
  running from anywhere else (a test copy, a second port) is left alone. Running sessions survive
  this: each one's pseudoconsole lives in its own Hangar.PtyHost.exe, which is left alone too (the
  name matches below catch neither "Hangar.PtyHost" nor, for the daemon, "Hangar.Tray"), so the
  restarted daemon re-attaches to them rather than relaunching them.
  A session that genuinely died still comes back by resuming its conversation
  (Sessions:ResumeOnStart, on by default); pass -ResumeSessions:$false to launch with
  --no-resume-sessions and leave those as manual "Reopen" entries for this deploy instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Target D:\apps\hangar -SkipBuild -NoRestart
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -NoTray
#>
param(
  [string]$Target,              # install folder; default $env:HANGAR_INSTALL_DIR, else %LocalAppData%\Programs\Hangar
  [switch]$SkipBuild,           # deploy the existing ./publish output without rebuilding
  [switch]$NoTray,              # build without the tray app (passed to build.ps1)
  [switch]$NoRestart,           # leave the app stopped after deploying
  [bool]$ResumeSessions = $true # relaunch (with --continue) the sessions that were running before the restart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_paths.ps1")
if (-not $Target) { $Target = Get-HangarInstallDir }
# Absolute, against this shell's location (not the process's), for the path matches below.
$Target  = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Target)
$root    = Split-Path -Parent $PSScriptRoot
$publish = Join-Path $root "publish"

# --- 1) Build + publish (single self-contained exes into ./publish) --------------------------
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build.ps1") -NoTray:$NoTray
} elseif (-not (Test-Path (Join-Path $publish "Hangar.exe"))) {
  throw "No published build at '$publish'. Run without -SkipBuild first."
}

# --- 2) Stop what holds the install's files; remember how the daemon was running ---------------
# Only this install's processes, matched by their exe's full path, never by name alone: a Hangar running
# from anywhere else (a test copy, a dev build on another port) is not ours to stop, and would not be
# started again below. The same rule as apply-update.ps1's Stop-FromTarget.
function Get-ProcessFromTarget([string]$name) {
  $exe = [IO.Path]::GetFullPath((Join-Path $Target "$name.exe"))
  @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    # .Path throws for a process we can't open; such a process isn't ours to stop either.
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $exe) } catch { $false }
  })
}

# The tray first: it is only a client, nothing is lost by closing it, and closing it before the daemon
# spares it announcing that the server went away.
$trayExe = [IO.Path]::GetFullPath((Join-Path $Target "Hangar.Tray.exe"))
$trays = Get-ProcessFromTarget "Hangar.Tray"
if ($trays.Count -gt 0) {
  Write-Host "==> Closing the tray ($($trays.Count) process(es))" -ForegroundColor Cyan
  $trays | Stop-Process -Force
}

# The "Hangar" service counts as this install's only when its exe is this install's Hangar.exe: a
# service installed from another folder is not ours to stop or start.
$svc = $null
$svcInfo = Get-CimInstance Win32_Service -Filter "Name='Hangar'" -ErrorAction SilentlyContinue
if ($svcInfo -and $svcInfo.PathName) {
  # PathName is the command line: a quoted or bare exe path, then any arguments.
  $svcExe = if ($svcInfo.PathName -match '^\s*"([^"]+)"') { $Matches[1] } else { ($svcInfo.PathName.Trim() -split '\s+')[0] }
  $ours = try { [IO.Path]::GetFullPath($svcExe) -ieq [IO.Path]::GetFullPath((Join-Path $Target "Hangar.exe")) } catch { $false }
  if ($ours) {
    $svc = Get-Service -Name "Hangar"
  } else {
    Write-Host "    The Hangar service runs '$svcExe', not this install; leaving it alone." -ForegroundColor DarkGray
  }
}

$restart = "none"
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "==> Stopping Hangar service" -ForegroundColor Cyan
  Stop-Service -Name "Hangar" -Force
  $restart = "service"
}
$procs = Get-ProcessFromTarget "Hangar"
if ($procs.Count -gt 0) {
  Write-Host "==> Stopping Hangar.exe running from $Target ($($procs.Count) process(es))" -ForegroundColor Cyan
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
# This machine's own settings go in appsettings.Local.json beside it: the app reads it over
# appsettings.json, and no deploy or update ever writes it.
Write-Host "    Your settings: $(Join-Path $Target 'appsettings.Local.json') (overrides appsettings.json)" -ForegroundColor DarkGray

# A build staged for the in-app updater before this deploy is now older than what is installed. Left
# there, it would be offered as an "update" and roll the app back (an app from before the updater
# compared build times did exactly that). Removed, unless it is newer than the build just deployed.
# It is the folder the app watches: see _paths.ps1 for how that is found.
# The files are already in place, so a settings file that can't be read must not stop the script
# here: that would leave the app down. Skipped with a warning instead.
$stagedStamp = $null
try {
  $staging = Get-HangarStagingDir $Target
  $payload = Join-Path $staging "payload"
  $stagedStamp = Join-Path $payload "build.json"
} catch {
  Write-Host "    Could not check for a stale staged update: $($_.Exception.Message)" -ForegroundColor Yellow
}
if ($stagedStamp -and (Test-Path $stagedStamp)) {
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
# Prefer this install's service when there is one (whether or not it was running before); otherwise the
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
  if ($trays.Count -gt 0 -and (Test-Path $trayExe)) {
    Write-Host "==> Launching Hangar.Tray.exe" -ForegroundColor Cyan
    Start-Process $trayExe -ArgumentList "--autostart"
  }
} else {
  Write-Host "    (-NoRestart) App left stopped. Start it with: $Target\Hangar.exe (and $Target\Hangar.Tray.exe)" -ForegroundColor DarkGray
}

# Surface the URL from the (preserved) settings for convenience: Server:Urls as the app reads it,
# appsettings.Local.json over appsettings.json. 127.0.0.1 rather than localhost, which Windows tries
# as ::1 first -- a couple of seconds lost against a server listening on IPv4 only.
$port = try { Get-HangarPort $Target } catch { $null }
if ($port) { Write-Host "==> Deployed. UI: http://127.0.0.1:$port" -ForegroundColor Green }
else { Write-Host "==> Deployed to $Target" -ForegroundColor Green }
