<#
.SYNOPSIS
  Installs a staged update over a Claude Web install folder and restarts the daemon.

.DESCRIPTION
  The daemon cannot overwrite its own running exe, so it launches this script as a detached process and
  then shuts itself down. From here on the daemon is gone and this script owns the update:

    1. wait for the daemon's process to exit (it is stopping itself); force it down if it hangs
    2. mirror <Staging> over <Target>, preserving the installed appsettings*.json
    3. start the daemon again the same way it was running (service or process)

  Running sessions are NOT interrupted. Each one's pseudoconsole lives in its own
  ClaudeWeb.PtyHost.exe, which this script never touches: the daemon detaches on the way down, the
  hosts and their claude processes keep running throughout, and the restarted daemon re-attaches to
  them with their scrollback and their in-flight conversations intact. Only a session that genuinely
  died comes back the old way, by resuming its conversation (Sessions:ResumeOnStart, or the explicit
  --resume-sessions this script passes to the daemon exe).

  Two details make that work, and both must be preserved if this script is edited:
    * The process matching below is by exact name ("ClaudeWeb"), which does not catch
      "ClaudeWeb.PtyHost" -- stopping the hosts would kill the very sessions we are protecting.
    * The daemon launches each host from a per-build copy under %LocalAppData%\ClaudeWeb\ptyhost, so
      the ClaudeWeb.PtyHost.exe this script mirrors into <Target> is never a running, locked file.

  The tray (ClaudeWeb.Tray.exe) is a separate process that holds its own exe open. It steps aside by
  itself: when the daemon reports the update, the tray exits and arranges to start again once the new
  daemon answers. As a backstop, a tray still running from <Target> when the copy is due is stopped --
  it is only a client, so nothing is lost, but that one stays closed until it is next started.

  Everything is logged to -LogPath, since nobody is watching a detached window. On any failure the
  script still tries to start the old build back up rather than leaving the machine with no app.

  The daemon embeds this file and extracts it outside the install folder before running it -- it must
  not live in <Target>, which step 2 mirrors.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File apply-update.ps1 `
    -Staging C:\apps\claude-web-updates\payload -Target C:\apps\claude-web -ProcessId 1234 -Mode process
#>
# Keep this file pure ASCII. Windows PowerShell 5.1 reads a .ps1 as ANSI, so a UTF-8 em-dash arrives
# as bytes including 0x94 -- a CP1252 smart quote, which closes a double-quoted string early and turns
# the whole script into a parse error.
param(
  [Parameter(Mandatory)][string]$Staging,               # folder holding the staged build (the payload)
  [Parameter(Mandatory)][string]$Target,                # install folder to update in place
  [Parameter(Mandatory)][int]$ProcessId,                # the daemon process to wait for; it is stopping itself
  [ValidateSet("service", "process")][string]$Mode = "process",
  [string]$ServiceName = "ClaudeWeb",
  [string]$LogPath,
  [int]$WaitSeconds = 45                                # how long to let the daemon close gracefully
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
    Write-Log "Launching $exe (daemon, resuming sessions)"
    # The daemon auto-resumes what was running, but say so explicitly: this launch must resume even if
    # the installed appsettings.json has Sessions:ResumeOnStart turned off.
    Start-Process $exe -ArgumentList "--resume-sessions"
  }
}

# Stop processes named $name that run from this install. Match on the executable's path, never on the
# process name alone: other Claude Web installs (a second port, a test build, a colleague's copy) are
# none of our business and must be left alone.
function Stop-FromTarget([string]$name) {
  $exe = [IO.Path]::GetFullPath((Join-Path $Target "$name.exe"))
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    # .Path throws for a process we can't open; such a process isn't ours to stop either.
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $exe) } catch { $false }
  })
  if ($procs.Count -gt 0) {
    Write-Log "Stopping $($procs.Count) $name process(es) running from $Target"
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1   # let the OS release the file locks
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

  # --- 1) Wait the daemon out, then insist ----------------------------------------------------
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

  # Anything of THIS install still holding its exe open would fail the copy: a leftover daemon, or a
  # tray that did not step aside on its own (an older tray, or one that had lost its connection).
  Stop-FromTarget "ClaudeWeb"
  Stop-FromTarget "ClaudeWeb.Tray"

  # --- 2) Mirror the payload over the install, preserving settings -----------------------------
  # Same shape as deploy.ps1: top-level files copied without /MIR (so unrelated files the target may
  # have are left alone) and settings excluded; wwwroot mirrored so stale hashed assets are pruned.
  # /R and /W keep a file that is still locked from stalling the update: robocopy's defaults retry a
  # million times, 30 seconds apart. Failing quickly lands in the catch below, which brings the app back.
  $quiet = @("/NFL", "/NDL", "/NP", "/NJH", "/NJS", "/R:3", "/W:2")

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
