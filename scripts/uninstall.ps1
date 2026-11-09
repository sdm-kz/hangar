<#
.SYNOPSIS
  Removes a Hangar install from this Windows account: its sign-in entries, its running daemon and tray,
  and (on request) its files and its data.

.DESCRIPTION
  In order:
    1. Removes the "Hangar" and "Hangar.Tray" sign-in entries (scripts\register-autostart.ps1 -Remove).
    2. Stops this install's tray and daemon. Matched by their exe's real path (junctions, links and
       8.3 short names resolved on both sides), never by name alone: a Hangar running from anywhere
       else is left alone.
    3. With -RemoveFiles, deletes the files a deploy puts in the install folder -- the exes, their
       .pdb files, build.json, web.config, appsettings*.json and wwwroot -- and then the folder itself
       if nothing else is left in it. Anything else found there is kept and listed. It refuses unless
       the folder holds Hangar.exe, Hangar.PtyHost.exe and build.json, and stops before deleting
       anything while any Hangar*.exe in it is still running.
    4. With -RemoveData, stops the pty hosts started from the data folder -- which ENDS every session
       still running in them -- and deletes the data folder (%LocalAppData%\Hangar: sessions,
       settings saved from the UI, logs, staged updates, the node identity) and the tray app's own
       folder (%LocalAppData%\<the tray's app identifier>: its settings, including the token it
       signs in to the server with, and its web view's cache).

  Without -RemoveData, running sessions keep running: each lives in its own Hangar.PtyHost.exe, which
  this script leaves alone.

  Not done here:
    * A Windows service (scripts\install-service.ps1) is removed with scripts\uninstall-service.ps1,
      from an elevated prompt. This script stops if this install runs as one.
    * Claude Code hooks. When Hooks:Enabled is on, the app registers hooks in ~/.claude/settings.json:
      entries whose URL ends in /api/hooks. Once the app is gone those calls have nowhere to go, so
      open %USERPROFILE%\.claude\settings.json and delete the hook entries whose URL ends in
      /api/hooks, and the SessionStart command that posts to it, keeping any others.
    * A staging folder set by Update:StagingPath outside the data folder; delete it by hand if wanted.

.PARAMETER InstallPath
  The install folder: $env:HANGAR_INSTALL_DIR, else %LocalAppData%\Programs\Hangar, by default (see
  scripts\_paths.ps1).

.PARAMETER RemoveFiles
  Delete the install's files (settings included), and the folder when nothing else is in it.

.PARAMETER RemoveData
  End running sessions and delete the data folder (%LocalAppData%\Hangar, or <HANGAR_TEST_ROOT>\Hangar)
  and the tray app's folder.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
  Stops Hangar and takes it out of sign-in; files, data and running sessions stay.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveFiles -RemoveData
#>
param(
  [string]$InstallPath,
  [switch]$RemoveFiles,
  [switch]$RemoveData
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_paths.ps1")
if (-not $InstallPath) { $InstallPath = Get-HangarInstallDir }
$InstallPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallPath)
$InstallPath = Assert-HangarAbsolutePath $InstallPath "-InstallPath"
$dataRoot = Get-HangarDataRoot   # absolute, or it has already thrown

# --- Real paths --------------------------------------------------------------------------------
# The path Windows itself has for a file or folder: junctions and symbolic links followed, 8.3 short
# names expanded. Two spellings of one place compare equal only in this form.
Add-Type -Namespace HangarUninstall -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string name, uint access,
  uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
  System.Text.StringBuilder path, uint size, uint flags);
'@
function Get-RealPath([string]$path) {
  # No access asked for, every kind of sharing allowed, and BACKUP_SEMANTICS so a folder opens too:
  # this works on a running exe and on a folder in use.
  $handle = [HangarUninstall.Native]::CreateFileW($path, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
  if ($handle.IsInvalid) { return [IO.Path]::GetFullPath($path) }
  try {
    $sb = New-Object System.Text.StringBuilder 1024
    $len = [HangarUninstall.Native]::GetFinalPathNameByHandleW($handle, $sb, 1024, 0)
    if ($len -eq 0 -or $len -ge 1024) { return [IO.Path]::GetFullPath($path) }
    $real = $sb.ToString()
    if ($real.StartsWith('\\?\UNC\')) { return '\\' + $real.Substring(8) }
    if ($real.StartsWith('\\?\')) { return $real.Substring(4) }
    return $real
  } finally { $handle.Dispose() }
}

$installReal = if (Test-Path -LiteralPath $InstallPath) { Get-RealPath $InstallPath } else { $InstallPath }

# Processes named $name whose exe's real path is under $folderReal (itself a real path).
function Get-ProcessUnder([string]$name, [string]$folderReal) {
  $prefix = $folderReal.TrimEnd('\') + '\'
  @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    # .Path throws for a process we can't open; such a process isn't ours to stop either.
    try { $_.Path -and (Get-RealPath $_.Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
}

# Whether a file is in use: a running exe can't be opened for writing by anyone, whatever path the
# process was started by -- the check that still holds when a path match misses.
function Test-FileInUse([string]$path) {
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.Dispose()
    return $false
  } catch [IO.IOException] { return $true }
  catch [UnauthorizedAccessException] { return $true }
}

# --- 0) A service is uninstall-service.ps1's ---------------------------------------------------
$svcInfo = Get-CimInstance Win32_Service -Filter "Name='Hangar'" -ErrorAction SilentlyContinue
if ($svcInfo -and $svcInfo.PathName) {
  $svcExe = if ($svcInfo.PathName -match '^\s*"([^"]+)"') { $Matches[1] } else { ($svcInfo.PathName.Trim() -split '\s+')[0] }
  $svcReal = if (Test-Path -LiteralPath $svcExe) { Get-RealPath $svcExe } else { $svcExe }
  if ($svcReal.StartsWith($installReal.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Hangar runs as a Windows service from '$InstallPath'. Remove it first, elevated: scripts\uninstall-service.ps1"
  }
}

# --- 1) Sign-in entries ------------------------------------------------------------------------
Write-Host "==> Removing the sign-in entries" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "register-autostart.ps1") -Remove

# --- 2) This install's tray and daemon ---------------------------------------------------------
# The exact names catch neither each other nor "Hangar.PtyHost", so sessions survive this step.
foreach ($name in "Hangar.Tray", "Hangar") {
  $procs = @(Get-ProcessUnder $name $installReal | Where-Object { [IO.Path]::GetFileName($_.Path) -ieq "$name.exe" })
  if ($procs.Count -gt 0) {
    Write-Host "==> Stopping $name ($($procs.Count) process(es)) running from $InstallPath" -ForegroundColor Cyan
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1   # let the OS release the file locks
  }
}

# --- 3) The install's files --------------------------------------------------------------------
if ($RemoveFiles) {
  if (Test-Path -LiteralPath $InstallPath) {
    # Three files only a Hangar install has together: a stray Hangar.exe in a shared folder is not enough.
    $missing = @("Hangar.exe", "Hangar.PtyHost.exe", "build.json") | Where-Object { -not (Test-Path -LiteralPath (Join-Path $InstallPath $_)) }
    if ($missing) {
      throw "'$InstallPath' doesn't look like a Hangar install (no $($missing -join ', ')); deleting nothing."
    }
    # Nothing is deleted while anything of it still runs, so a failure can't leave half an install.
    $busy = @(Get-ChildItem -LiteralPath $InstallPath -Filter "Hangar*.exe" -File | Where-Object { Test-FileInUse $_.FullName })
    if ($busy.Count -gt 0) {
      throw ("Still running from '$InstallPath': $(($busy | ForEach-Object Name) -join ', '). " +
        "Stop it (and any session host started from here) and run this again; nothing was deleted.")
    }
    # What a deploy puts there, and nothing else; scripts is where an install from a release keeps
    # these scripts (scripts\install.ps1).
    $known = @("Hangar.exe", "Hangar.PtyHost.exe", "Hangar.Tray.exe", "Hangar.pdb", "Hangar.PtyHost.pdb",
      "Hangar.Tray.pdb", "Hangar.staticwebassets.endpoints.json", "build.json", "web.config", "wwwroot", "scripts")
    $items = @(Get-ChildItem -LiteralPath $InstallPath -Force | Where-Object {
      $known -contains $_.Name -or ($_.Name -like "appsettings*.json" -and -not $_.PSIsContainer)
    })
    Write-Host "==> Deleting Hangar's files from $InstallPath" -ForegroundColor Cyan
    foreach ($item in $items) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
    $left = @(Get-ChildItem -LiteralPath $InstallPath -Force)
    if ($left.Count -eq 0) {
      Remove-Item -LiteralPath $InstallPath -Force
    } else {
      Write-Host "    Kept $InstallPath, which still holds files that aren't Hangar's:" -ForegroundColor Yellow
      $left | Select-Object -First 20 | ForEach-Object { Write-Host "      $($_.Name)" }
    }
  } else {
    Write-Host "    No install folder at $InstallPath." -ForegroundColor DarkGray
  }
}

# --- 4) The data folders -----------------------------------------------------------------------
if ($RemoveData) {
  if ([IO.Path]::GetFileName($dataRoot.TrimEnd('\')) -ne "Hangar") { throw "Unexpected data folder '$dataRoot'; deleting nothing." }
  if (Test-Path -LiteralPath $dataRoot) {
    # The pty hosts run from per-build copies inside the data folder; while they run, it can't go.
    $hosts = @(Get-ProcessUnder "Hangar.PtyHost" (Get-RealPath $dataRoot))
    if ($hosts.Count -gt 0) {
      Write-Host "==> Ending $($hosts.Count) running session host(s)" -ForegroundColor Yellow
      $hosts | Stop-Process -Force
      Start-Sleep -Seconds 1
    }
    Write-Host "==> Deleting $dataRoot" -ForegroundColor Cyan
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
  } else {
    Write-Host "    No data folder at $dataRoot." -ForegroundColor DarkGray
  }

  # The tray's own folder, named by its app identifier (tray\src-tauri\tauri.conf.json). Not under
  # HANGAR_TEST_ROOT: a test instance's tray keeps its settings where HANGAR_TRAY_CONFIG_DIR says.
  if ($env:HANGAR_TEST_ROOT) {
    Write-Host "    HANGAR_TEST_ROOT is set: the tray's own folder is left alone." -ForegroundColor DarkGray
  } else {
    $identifier = $null
    $conf = Join-Path $PSScriptRoot "..\tray\src-tauri\tauri.conf.json"
    if (Test-Path -LiteralPath $conf) {
      try { $identifier = (Get-Content -LiteralPath $conf -Raw | ConvertFrom-Json).identifier } catch { }
    }
    $local = Get-HangarKnownLocalAppData
    $trayDirs = if ($identifier) {
      @(Join-Path $local $identifier | Where-Object { Test-Path -LiteralPath $_ })
    } else {
      # Run from outside a checkout: the identifier always ends in "hangar.tray".
      @(Get-ChildItem -LiteralPath $local -Directory -Filter "*.hangar.tray" | ForEach-Object FullName)
    }
    foreach ($dir in $trayDirs) {
      Write-Host "==> Deleting the tray's folder $dir" -ForegroundColor Cyan
      try { Remove-Item -LiteralPath $dir -Recurse -Force }
      catch { Write-Warning "Could not delete '$dir' (is a tray still running from elsewhere?): $($_.Exception.Message)" }
    }
  }
}

Write-Host "==> Done." -ForegroundColor Green
Write-Host "    If Claude hooks were on, remove the hook entries that call /api/hooks from $env:USERPROFILE\.claude\settings.json."
if (-not $RemoveFiles) { Write-Host "    Files kept: $InstallPath (-RemoveFiles deletes them)." }
if (-not $RemoveData) { Write-Host "    Data kept: $dataRoot (-RemoveData ends running sessions and deletes it)." }
