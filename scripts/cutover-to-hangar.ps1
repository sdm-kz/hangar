<#
.SYNOPSIS
  Moves a Claude Web install (ClaudeWeb.exe in C:\apps\claude-web, started at sign-in) over to Hangar
  (Hangar.exe in C:\apps\hangar), once. Running sessions keep running.

.DESCRIPTION
  The in-app updater can't make this move: the build it runs looks for ClaudeWeb.exe in its own folder
  and starts it again, and every name it would look for has changed. So this does it by hand, in the
  order that keeps the app down for the shortest time and touches nothing until it can't fail:

    1. Windows Firewall. An inbound rule allows a program by its path, so Hangar.exe in a new folder
       would be cut off from the LAN (and from a reverse proxy in front of it). Every enabled inbound
       rule for the old exe is copied for the new one -- the one step that needs elevation, so a UAC
       prompt. Declining it stops here, before anything else has happened.
    2. Build, and carry appsettings*.json over to the new folder (the password, the URLs).
    3. Stop the old tray, then the old daemon: through its own API first, the way the tray's
       "Stop server" does, so it saves its session list on the way down; killed if it won't go.
    4. Deploy to the new folder and start Hangar.exe (scripts\deploy.ps1). It re-attaches to every
       running session: their pty hosts outlive the daemon, and the pipe names have not changed.
    5. Swap the ClaudeWeb / ClaudeWeb.Tray sign-in entries for Hangar / Hangar.Tray, and start the tray.

  The old folder is left as it was, to roll back to: stop Hangar.exe, start ClaudeWeb.exe from it. Both
  builds use the same data folder (%LocalAppData%\Hangar). Delete it once the new one has run a while.

  A Windows service install is not handled: uninstall-service.ps1 first, run this, then
  install-service.ps1 for the new exe.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\cutover-to-hangar.ps1
#>
param(
  [string]$From = "C:\apps\claude-web",
  [string]$Target = "C:\apps\hangar",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$oldExe  = [IO.Path]::GetFullPath((Join-Path $From "ClaudeWeb.exe"))
$oldTray = [IO.Path]::GetFullPath((Join-Path $From "ClaudeWeb.Tray.exe"))
$newExe  = [IO.Path]::GetFullPath((Join-Path $Target "Hangar.exe"))
$newTray = [IO.Path]::GetFullPath((Join-Path $Target "Hangar.Tray.exe"))
$runKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

if (-not (Test-Path $oldExe)) { throw "No Claude Web install at '$From' (no ClaudeWeb.exe)." }
if (Get-Service -Name "ClaudeWeb" -ErrorAction SilentlyContinue) {
  throw "ClaudeWeb runs as a Windows service. Run uninstall-service.ps1 (elevated), then this, then install-service.ps1."
}

function Get-ProcessByPath([string]$name, [string]$path) {
  @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    # .Path throws for a process we can't open; such a process isn't this install's.
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $path) } catch { $false }
  })
}

# --- 1) Firewall -------------------------------------------------------------------------------------
$oldRules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program) -ieq $oldExe) } |
  Get-NetFirewallRule | Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" })
$haveNew = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program) -ieq $newExe) })

if ($oldRules.Count -eq 0) {
  Write-Host "==> No inbound firewall rule names $oldExe; nothing to carry over" -ForegroundColor DarkGray
} elseif ($haveNew.Count -gt 0) {
  Write-Host "==> Windows Firewall already has a rule for $newExe" -ForegroundColor DarkGray
} else {
  $commands = foreach ($rule in $oldRules) {
    $protocol = ($rule | Get-NetFirewallPortFilter).Protocol
    "New-NetFirewallRule -DisplayName 'Hangar' -Description 'Hangar server (carried over from ClaudeWeb.exe)' " +
      "-Direction Inbound -Action $($rule.Action) -Profile '$($rule.Profile)' -Protocol '$protocol' " +
      "-Program '$newExe' | Out-Null"
  }
  $script = ($commands | Sort-Object -Unique) -join "`n"
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  Write-Host "==> Allowing $newExe through Windows Firewall, as $oldExe is$(if (-not $admin) { ' (UAC prompt)' })" -ForegroundColor Cyan
  if ($admin) {
    Invoke-Expression $script
  } else {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ErrorActionPreference = 'Stop'`n$script"))
    try {
      Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
    } catch { throw "The firewall rule needs elevation, which was declined. Nothing else was changed." }
  }
  $haveNew = @(Get-NetFirewallApplicationFilter | Where-Object {
    $_.Program -and ([Environment]::ExpandEnvironmentVariables($_.Program) -ieq $newExe) })
  if ($haveNew.Count -eq 0) { throw "No firewall rule for $newExe was created. Nothing else was changed." }
}

# --- 2) Build, and the settings ------------------------------------------------------------------------
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot "build.ps1") }
New-Item -ItemType Directory -Force -Path $Target | Out-Null
if (-not (Test-Path (Join-Path $Target "appsettings.json"))) {
  Get-ChildItem $From -Filter "appsettings*.json" | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $Target $_.Name)
    Write-Host "==> Carried $($_.Name) over to $Target" -ForegroundColor Cyan
  }
}

# --- 3) Stop the old tray and daemon ---------------------------------------------------------------
$trays = Get-ProcessByPath "ClaudeWeb.Tray" $oldTray
$hadTray = $trays.Count -gt 0 -or [bool](Get-ItemProperty -Path $runKey -Name "ClaudeWeb.Tray" -ErrorAction SilentlyContinue)
if ($trays.Count -gt 0) {
  Write-Host "==> Closing the old tray" -ForegroundColor Cyan
  $trays | Stop-Process -Force
}

$daemons = Get-ProcessByPath "ClaudeWeb" $oldExe
if ($daemons.Count -gt 0) {
  Write-Host "==> Stopping the old daemon" -ForegroundColor Cyan
  # Its instance file has the loopback URL and a token for its API (written to both data folders).
  $instance = foreach ($dir in "Hangar", "ClaudeWeb") {
    Get-ChildItem (Join-Path $env:LOCALAPPDATA "$dir\instances") -Filter "*.json" -ErrorAction SilentlyContinue |
      ForEach-Object { try { Get-Content $_.FullName -Raw | ConvertFrom-Json } catch { } } |
      Where-Object { $_.exePath -and ([IO.Path]::GetFullPath($_.exePath) -ieq $oldExe) }
  }
  $instance = @($instance) | Select-Object -First 1
  if ($instance) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 10 -Headers @{ Authorization = "Bearer $($instance.token)" } `
        -Uri ($instance.localUrl.TrimEnd('/') + "/api/daemon/stop") | Out-Null
    } catch { Write-Host "    It did not take the stop request ($($_.Exception.Message))" -ForegroundColor Yellow }
  }
  foreach ($p in $daemons) {
    try { if (-not $p.WaitForExit(30000)) { $p | Stop-Process -Force } } catch { }
  }
  Start-Sleep -Seconds 1 # let the OS release the port and file locks
}

# --- 4) Deploy and start --------------------------------------------------------------------------
& (Join-Path $PSScriptRoot "deploy.ps1") -Target $Target -SkipBuild

# --- 5) Sign-in entries, and the tray --------------------------------------------------------------
foreach ($entry in "ClaudeWeb", "ClaudeWeb.Tray") {
  if (Get-ItemProperty -Path $runKey -Name $entry -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $entry
    Write-Host "==> Removed the '$entry' sign-in entry" -ForegroundColor Cyan
  }
}
if ($hadTray) {
  & (Join-Path $PSScriptRoot "register-autostart.ps1") -ExePath $newExe
  if ((Get-ProcessByPath "Hangar.Tray" $newTray).Count -eq 0) { Start-Process $newTray }
} else {
  & (Join-Path $PSScriptRoot "register-autostart.ps1") -ExePath $newExe -NoTray
}

Write-Host ""
Write-Host "Hangar runs from $Target." -ForegroundColor Green
Write-Host "  $From is left as it was. To roll back: stop Hangar.exe (and Hangar.Tray.exe), start"
Write-Host "  $oldExe, and point the 'Hangar' sign-in entry at it."
Write-Host "  Snap: scripts\deploy-snap.ps1 moves it to C:\apps\hangar-snap."
