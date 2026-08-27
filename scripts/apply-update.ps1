<#
.SYNOPSIS
  Installs a staged update over a Claude Web install folder and restarts the app.

.DESCRIPTION
  The app cannot overwrite its own running exe, so it launches this script as a detached process and
  then shuts itself down. From here on the app is gone and this script owns the update:

    1. wait for the app's process to exit (it is stopping itself); force it down if it hangs
    2. mirror <Staging> over <Target>, preserving the installed appsettings*.json
    3. start the app again the same way it was running (service or tray exe)

  Sessions that were running come back on their own: the app freezes its session state as it goes
  down and resumes those conversations on the next start (Sessions:ResumeOnStart, or the explicit
  --resume-sessions this script passes to the tray exe).

  Everything is logged to -LogPath, since nobody is watching a detached window. On any failure the
  script still tries to start the old build back up rather than leaving the machine with no app.

  The app embeds this file and extracts it outside the install folder before running it -- it must not
  live in <Target>, which step 2 mirrors.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File apply-update.ps1 `
    -Staging C:\apps\claude-web-updates\payload -Target C:\apps\claude-web -ProcessId 1234 -Mode tray
#>
# Keep this file pure ASCII. Windows PowerShell 5.1 reads a .ps1 as ANSI, so a UTF-8 em-dash arrives
# as bytes including 0x94 -- a CP1252 smart quote, which closes a double-quoted string early and turns
# the whole script into a parse error.
param(
  [Parameter(Mandatory)][string]$Staging,               # folder holding the staged build (the payload)
  [Parameter(Mandatory)][string]$Target,                # install folder to update in place
  [Parameter(Mandatory)][int]$ProcessId,                # the app process to wait for; it is stopping itself
  [ValidateSet("service", "tray")][string]$Mode = "tray",
  [string]$ServiceName = "ClaudeWeb",
  [string]$LogPath,
  [int]$WaitSeconds = 45                                # how long to let the app close gracefully
)

$ErrorActionPreference = "Stop"

if (-not $LogPath) {
  $LogPath = Join-Path $env:LOCALAPPDATA "ClaudeWeb\logs\update.log"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Write-Log([string]$message) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $message
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
  Write-Host $line
}

function Start-App {
  if ($Mode -eq "service") {
    Write-Log "Starting service '$ServiceName'"
    Start-Service -Name $ServiceName
  } else {
    $exe = Join-Path $Target "ClaudeWeb.exe"
    Write-Log "Launching $exe (tray, resuming sessions)"
    # The app auto-resumes what was running, but say so explicitly: this launch must resume even if
    # the installed appsettings.json has Sessions:ResumeOnStart turned off.
    Start-Process $exe -ArgumentList "--resume-sessions"
  }
}

Write-Log "=== apply-update: $Staging -> $Target (mode=$Mode, pid=$ProcessId) ==="

try {
  if (-not (Test-Path (Join-Path $Staging "ClaudeWeb.exe"))) {
    throw "Staged build has no ClaudeWeb.exe: $Staging"
  }
  if (-not (Test-Path (Join-Path $Target "ClaudeWeb.exe"))) {
    throw "Target is not a Claude Web install: $Target"
  }

  # --- 1) Wait the app out, then insist -------------------------------------------------------
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Log "Waiting up to ${WaitSeconds}s for pid $ProcessId to exit"
    if (-not $proc.WaitForExit($WaitSeconds * 1000)) {
      Write-Log "Still running after ${WaitSeconds}s -- stopping it"
      if ($Mode -eq "service") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        # A service that ignores the SCM still has to go: its files must unlock before the mirror.
        Get-Process -Id $ProcessId -ErrorAction SilentlyContinue | Stop-Process -Force
      } else {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds 2
    }
  } else {
    Write-Log "Process $ProcessId already gone"
  }

  # A service that stopped on its own is Stopped, not Running -- but the SCM may still be finishing
  # the transition, and Start-Service on a stopping service fails. Settle it first.
  if ($Mode -eq "service") {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne "Stopped") {
      Write-Log "Service status is $($svc.Status) -- stopping it"
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      try { $svc.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(20)) } catch { Write-Log "WaitForStatus: $_" }
    }
  }

  # A leftover instance of THIS install still holds a lock on the single-file exe and would fail the
  # copy. Match on the executable's path, never on the process name alone: other Claude Web installs
  # (a second port, a test build, a colleague's copy) are none of our business and must be left alone.
  $targetExe = (Join-Path $Target "ClaudeWeb.exe")
  $strays = @(Get-Process -Name "ClaudeWeb" -ErrorAction SilentlyContinue | Where-Object {
    # .Path throws for a process we can't open; such a process isn't ours to stop either.
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq [IO.Path]::GetFullPath($targetExe)) } catch { $false }
  })
  if ($strays.Count -gt 0) {
    Write-Log "Stopping $($strays.Count) leftover process(es) from $Target"
    $strays | Stop-Process -Force
    Start-Sleep -Seconds 1   # let the OS release the file locks
  }

  # --- 2) Mirror the payload over the install, preserving settings -----------------------------
  # Same shape as deploy.ps1: top-level files copied without /MIR (so unrelated files the target may
  # have are left alone) and settings excluded; wwwroot mirrored so stale hashed assets are pruned.
  $quiet = @("/NFL", "/NDL", "/NP", "/NJH", "/NJS")

  Write-Log "Copying program files (preserving appsettings*.json)"
  robocopy $Staging $Target /E /XD "wwwroot" /XF "appsettings.json" "appsettings.*.json" @quiet | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE): program files" }

  Write-Log "Mirroring wwwroot"
  robocopy (Join-Path $Staging "wwwroot") (Join-Path $Target "wwwroot") /MIR @quiet | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE): wwwroot" }

  # --- 3) Back up on its feet ------------------------------------------------------------------
  Start-App
  Write-Log "=== apply-update: done ==="
} catch {
  Write-Log "FAILED: $_"
  # Never leave the machine without a running app: whatever is in $Target now (the old build if the
  # copy never started, the new one if it finished and the restart failed) is what we bring back.
  try { Start-App; Write-Log "Restarted the app after the failure" }
  catch { Write-Log "Could not restart the app: $_" }
  exit 1
}
