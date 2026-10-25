<#
.SYNOPSIS
  Where Hangar lives on Windows: the one place the scripts work out the install folder, the staging
  folder for updates and the data folder, and read the install's settings. Dot-source it; it does
  nothing on its own.

.DESCRIPTION
  Install folder (Get-HangarInstallDir):
    1. $env:HANGAR_INSTALL_DIR, when set (must be an absolute path)
    2. %LocalAppData%\Programs\Hangar
  A per-user folder by default, not one under C:\ : a folder made at the root of C:\ inherits
  "Authenticated Users: Modify", so any other account on the machine could drop a file into it and
  have it run as you. An explicit -Target / -InstallPath on a script still wins over both.

  Settings (Get-HangarSetting) are read the way the app layers them: the environment variable
  (Section__Key) over <install>\appsettings.Local.json over <install>\appsettings.json. The JSON may
  hold // and /* */ comments and trailing commas, as the app's own reader allows. A settings file
  that is there but can't be read stops the script: guessing past it would act on a value the app
  isn't using (staging an update where it isn't looking, say).

  Staging folder for the in-app updater (Get-HangarStagingDir), the same one the app itself watches:
    1. Update:StagingPath, as above ($env:Update__StagingPath, then appsettings.Local.json, then
       appsettings.json). A relative one is taken as relative to the install folder.
    2. %LocalAppData%\Hangar\updates (the app's own default)
  An explicit -Staging on a script still wins over all of them.

  Data folder (Get-HangarDataRoot): %LocalAppData%\Hangar, or <HANGAR_TEST_ROOT>\Hangar when that is set
  -- the variable the app honours so a test or dev instance gets a data folder of its own. dev.ps1 and
  run.ps1 set it to %LocalAppData%\Hangar-dev unless it is already set (Get-HangarDevTestRoot).

  Every folder these return is absolute, or the call throws: a relative one would quietly mean
  "under whatever the current folder is", and some callers delete what they are given.

  Keep apply-update.ps1 free of this file: the app embeds that script and runs it on its own, with
  every path passed in.

.EXAMPLE
  . (Join-Path $PSScriptRoot "_paths.ps1")
  if (-not $Target) { $Target = Get-HangarInstallDir }
#>

# A path that must be absolute, or a stop. "C:\x" and "\\server\share\x" pass; "x", "" and the
# drive-relative "C:x" or "\x" do not.
function Assert-HangarAbsolutePath([string]$path, [string]$what) {
  if (-not $path -or -not [IO.Path]::IsPathRooted($path) -or $path -notmatch '^([A-Za-z]:\\|\\\\)') {
    throw "$what must be an absolute path; got '$path'."
  }
  return $path
}

# %LocalAppData% itself, as Windows knows it (not the variable, which anything can set).
function Get-HangarKnownLocalAppData {
  $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  return Assert-HangarAbsolutePath $local "The Local AppData folder"
}

# %LocalAppData%, or HANGAR_TEST_ROOT standing in for it (as the app's AppDataFolder does).
function Get-HangarLocalAppData {
  if ($env:HANGAR_TEST_ROOT) { return Assert-HangarAbsolutePath $env:HANGAR_TEST_ROOT "HANGAR_TEST_ROOT" }
  return Get-HangarKnownLocalAppData
}

function Get-HangarDataRoot {
  return [IO.Path]::Combine((Get-HangarLocalAppData), "Hangar")
}

# The HANGAR_TEST_ROOT dev.ps1 and run.ps1 give a dev instance by default, so it doesn't share the
# installed app's data folder (its sessions, settings, node identity and pty hosts): the one already
# set, else %LocalAppData%\Hangar-dev (the instance's data then lands in its Hangar subfolder).
function Get-HangarDevTestRoot {
  if ($env:HANGAR_TEST_ROOT) { return Assert-HangarAbsolutePath $env:HANGAR_TEST_ROOT "HANGAR_TEST_ROOT" }
  return [IO.Path]::Combine((Get-HangarKnownLocalAppData), "Hangar-dev")
}

function Get-HangarInstallDir {
  if ($env:HANGAR_INSTALL_DIR) { return Assert-HangarAbsolutePath $env:HANGAR_INSTALL_DIR "HANGAR_INSTALL_DIR" }
  # The install folder is not test-rooted: a test instance runs from a copy of its own, by path.
  return [IO.Path]::Combine((Get-HangarKnownLocalAppData), "Programs", "Hangar")
}

# JSON as the app's settings reader takes it -- comments and trailing commas allowed -- turned into
# JSON that ConvertFrom-Json takes (Windows PowerShell 5.1's rejects both). Strings are copied as they
# are, so a "//" inside a URL stays.
function ConvertFrom-HangarJsonc([string]$text) {
  $sb = New-Object System.Text.StringBuilder $text.Length
  $i = 0; $n = $text.Length
  while ($i -lt $n) {
    $c = $text[$i]
    if ($c -eq '"') {
      # A string, escapes and all.
      $j = $i + 1
      while ($j -lt $n -and $text[$j] -ne '"') { if ($text[$j] -eq '\') { $j++ }; $j++ }
      [void]$sb.Append($text, $i, [Math]::Min($j + 1, $n) - $i)
      $i = $j + 1
    } elseif ($c -eq '/' -and $i + 1 -lt $n -and $text[$i + 1] -eq '/') {
      while ($i -lt $n -and $text[$i] -ne "`n") { $i++ }
    } elseif ($c -eq '/' -and $i + 1 -lt $n -and $text[$i + 1] -eq '*') {
      $end = $text.IndexOf('*/', $i + 2)
      $i = if ($end -lt 0) { $n } else { $end + 2 }
      [void]$sb.Append(' ')
    } else {
      [void]$sb.Append($c); $i++
    }
  }
  # Trailing commas, now that no comment can sit between one and its bracket. Outside strings only:
  # the same walk again, dropping a comma whose next non-blank character closes an object or array.
  $text = $sb.ToString()
  $sb = New-Object System.Text.StringBuilder $text.Length
  $i = 0; $n = $text.Length
  while ($i -lt $n) {
    $c = $text[$i]
    if ($c -eq '"') {
      $j = $i + 1
      while ($j -lt $n -and $text[$j] -ne '"') { if ($text[$j] -eq '\') { $j++ }; $j++ }
      [void]$sb.Append($text, $i, [Math]::Min($j + 1, $n) - $i)
      $i = $j + 1
      continue
    }
    if ($c -eq ',') {
      $j = $i + 1
      while ($j -lt $n -and [char]::IsWhiteSpace($text[$j])) { $j++ }
      if ($j -lt $n -and ($text[$j] -eq '}' -or $text[$j] -eq ']')) { $i++; continue }
    }
    [void]$sb.Append($c); $i++
  }
  return $sb.ToString() | ConvertFrom-Json
}

# One settings file of the install, parsed; $null when there is no such file. Throws when it is
# there but unreadable (see the help).
function Read-HangarSettingsFile([string]$settingsPath) {
  if (-not (Test-Path -LiteralPath $settingsPath)) { return $null }
  try {
    return ConvertFrom-HangarJsonc (Get-Content -LiteralPath $settingsPath -Raw)
  } catch {
    throw "Could not read '$settingsPath': $($_.Exception.Message). Fix the file, or pass the value this script needs explicitly."
  }
}

# A setting the way the app resolves it: $env:Section__Key, then appsettings.Local.json, then
# appsettings.json in the install folder. $null when none of them sets it.
function Get-HangarSetting([string]$installDir, [string]$section, [string]$key) {
  $fromEnv = [Environment]::GetEnvironmentVariable("${section}__$key")
  if ($fromEnv) { return $fromEnv }
  foreach ($file in "appsettings.Local.json", "appsettings.json") {
    $settings = Read-HangarSettingsFile ([IO.Path]::Combine($installDir, $file))
    if ($settings -and $settings.$section -and $settings.$section.$key) { return [string]$settings.$section.$key }
  }
  return $null
}

# The local port from Server:Urls (its first entry), or $null.
function Get-HangarPort([string]$installDir) {
  $urls = Get-HangarSetting $installDir "Server" "Urls"
  if (-not $urls) { return $null }
  try {
    return ([uri](($urls -split ';')[0].Trim() -replace '0\.0\.0\.0|\*|\+', 'localhost')).Port
  } catch { return $null }
}

function Get-HangarStagingDir([string]$installDir = (Get-HangarInstallDir)) {
  $value = Get-HangarSetting $installDir "Update" "StagingPath"
  if (-not $value) { return [IO.Path]::Combine((Get-HangarDataRoot), "updates") }
  # Relative to the install folder -- the app's content root -- rather than to wherever this runs.
  if (-not [IO.Path]::IsPathRooted($value)) { $value = [IO.Path]::GetFullPath([IO.Path]::Combine($installDir, $value)) }
  return Assert-HangarAbsolutePath $value "Update:StagingPath"
}
