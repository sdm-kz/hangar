<#
.SYNOPSIS
  Register (or remove) Hangar in the CURRENT USER's autostart, so the daemon (Hangar.exe) and
  the tray icon (Hangar.Tray.exe) both launch at sign-in.
  Uses the per-user Run key (HKCU) -- no admin rights required, affects only your account.

.DESCRIPTION
  Starting at sign-in is the recommended way to run the daemon. It runs as you, in your session: the
  same profile, PATH and credential files an interactive `claude` uses, and a desktop to open a browser
  on for a first-run login. The Windows service (scripts\install-service.ps1) is the exception, for a
  daemon that has to keep running while nobody is signed in.

  The two entries are independent. The daemon doesn't need the tray, and the tray only follows the
  daemon on its port -- it never starts one by itself -- so -NoTray gives a headless setup.

.PARAMETER ExePath
  Path to the daemon, Hangar.exe. Defaults to .\publish\Hangar.exe next to the repo. The tray is
  expected beside it.

.PARAMETER NoTray
  Register the daemon only (and remove a tray entry left from an earlier registration).

.PARAMETER Remove
  Remove both autostart entries instead of adding them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -ExePath "C:\apps\hangar\Hangar.exe"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -Remove
#>
param(
  [string]$ExePath = "$PSScriptRoot\..\publish\Hangar.exe",
  [string]$Name = "Hangar",
  [switch]$NoTray,
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$trayName = "$Name.Tray"

function Remove-Entry([string]$entry) {
  if (Get-ItemProperty -Path $runKey -Name $entry -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $entry
    Write-Host "Removed '$entry' from autostart." -ForegroundColor Green
  } else {
    Write-Host "'$entry' is not in autostart."
  }
}

if ($Remove) {
  Remove-Entry $Name
  Remove-Entry $trayName
  return
}

$resolved = Resolve-Path $ExePath -ErrorAction SilentlyContinue
if (-not $resolved -or -not (Test-Path $resolved.Path)) {
  throw "Hangar.exe not found at '$ExePath'. Build it first (scripts\build.ps1) or pass -ExePath <path>."
}
$daemon = $resolved.Path
$tray = Join-Path (Split-Path -Parent $daemon) "Hangar.Tray.exe"
$withTray = -not $NoTray -and (Test-Path $tray)

# Values are quoted exe paths (quotes handle spaces in the path).
Set-ItemProperty -Path $runKey -Name $Name -Value ('"{0}"' -f $daemon)
Write-Host "Registered autostart for the current user:" -ForegroundColor Green
Write-Host "  $Name = `"$daemon`"   (server)"

if ($withTray) {
  # The same entry the tray's own "Start when I sign in" switches, flag and all: --autostart tells it
  # that it was started at sign-in, so it doesn't open its settings on a first run.
  Set-ItemProperty -Path $runKey -Name $trayName -Value ('"{0}" --autostart' -f $tray)
  Write-Host "  $trayName = `"$tray`" --autostart   (tray app)"
} elseif ($NoTray) {
  if (Get-ItemProperty -Path $runKey -Name $trayName -ErrorAction SilentlyContinue) { Remove-Entry $trayName }
} else {
  Write-Warning "No Hangar.Tray.exe beside the daemon ('$tray'); registered the server only."
}

Write-Host "It starts automatically at your next sign-in. Start it now with:"
Write-Host "  & `"$daemon`""
if ($withTray) { Write-Host "  & `"$tray`"" }
