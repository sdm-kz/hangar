# Installs Hangar from a GitHub release, on Windows. In PowerShell (Windows PowerShell 5.1 or 7):
#
#   irm https://github.com/sdm-kz/hangar/releases/latest/download/install.ps1 | iex
#
# It downloads this machine's build from the release, checks it against the release's SHA256SUMS, and
# installs it with the build's own scripts: deploy.ps1 (into %LocalAppData%\Programs\Hangar, started at
# once) and register-autostart.ps1 (started at sign-in) -- the same install a checkout makes. Run it
# again to update: settings, the app's data and running sessions are kept.
#
# Settings, as environment variables set first ($env:HANGAR_VERSION = "1.2.0"; irm ... | iex):
#   HANGAR_VERSION       the release to install (1.2.0, or a prerelease such as 1.2.0-rc.1); the latest by default
#   HANGAR_INSTALL_DIR   where to install it; %LocalAppData%\Programs\Hangar by default
#   HANGAR_NO_AUTOSTART  set to 1 to add no sign-in entries on a first install (an update never adds them)
#
# A script block, not a script: iex runs it in the caller's own session, where an `exit` would close
# their window and a stray variable would stay behind. Failures throw instead.
& {
  $ErrorActionPreference = "Stop"
  # Windows PowerShell draws Invoke-WebRequest's progress bar so slowly that it slows the download itself.
  $ProgressPreference = "SilentlyContinue"
  # Windows PowerShell 5.1 may offer no TLS 1.2 on its own, which GitHub requires.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "sdm-kz/hangar"

  # This machine's CPU from its own environment block: an x64 PowerShell emulated on arm64 is told AMD64.
  $arch = try {
    (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  } catch { $env:PROCESSOR_ARCHITECTURE }
  $rid = switch ($arch) {
    "AMD64" { "win-x64" }
    "ARM64" { "win-arm64" }
    default { throw "There is no Hangar build for this CPU ($arch)." }
  }

  $base = if ($env:HANGAR_VERSION) {
    "https://github.com/$repo/releases/download/v$($env:HANGAR_VERSION.TrimStart('v'))"
  } else {
    "https://github.com/$repo/releases/latest/download"
  }

  $installDir = if ($env:HANGAR_INSTALL_DIR) { $env:HANGAR_INSTALL_DIR } else {
    [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData), "Programs", "Hangar")
  }
  # Absolute, with no trailing separator. A relative one would mean one folder here and another in the
  # scripts below (a new process, its own working folder), and Windows PowerShell passes a quoted
  # "D:\My Apps\Hangar\" on as D:\My Apps\Hangar".
  $installDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installDir).TrimEnd('\', '/')
  $firstInstall = -not (Test-Path -LiteralPath (Join-Path $installDir "Hangar.exe"))

  $work = Join-Path ([IO.Path]::GetTempPath()) ("hangar-install-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $archive = "hangar-$rid.zip"
    $zip = Join-Path $work $archive
    $sums = Join-Path $work "SHA256SUMS"
    Write-Host "==> Downloading $base/$archive" -ForegroundColor Cyan
    Invoke-WebRequest "$base/$archive" -OutFile $zip -UseBasicParsing
    Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing

    # sha256sum's lines are "<hash>  <name>", or "<hash> *<name>" in binary mode.
    $expected = Get-Content -LiteralPath $sums | ForEach-Object {
      $fields = $_.Trim() -split '\s+', 2
      if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq $archive) { $fields[0].ToLowerInvariant() }
    } | Select-Object -First 1
    if (-not $expected) { throw "$archive is not listed in the release's SHA256SUMS." }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "$archive does not match the release's SHA256SUMS (expected $expected, got $actual)."
    }

    Expand-Archive -LiteralPath $zip -DestinationPath $work
    $dir = Join-Path $work "hangar-$rid"
    $version = try { (Get-Content -LiteralPath (Join-Path $dir "publish\build.json") -Raw | ConvertFrom-Json).version } catch { $null }
    Write-Host "==> Installing Hangar $(if ($version) { $version } else { '(unversioned build)' }) for $rid" -ForegroundColor Cyan

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
      Write-Warning "The Claude Code CLI (claude) is not on PATH. Hangar needs it: https://github.com/$repo/blob/main/docs/install.md#prerequisites"
    }

    # The build's scripts, each in a Windows PowerShell of its own: an execution policy that forbids
    # running script files (the default on Windows client editions) is bypassed for that process only.
    function Invoke-HangarScript([string]$name, [string[]]$arguments) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "scripts\$name") @arguments
      if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)." }
    }
    Invoke-HangarScript "deploy.ps1" @("-SkipBuild", "-Target", $installDir)

    # The scripts that set up and remove an install (uninstall.ps1, install-service.ps1, ...), kept with
    # it: the download they came in is deleted below.
    $scriptsDir = Join-Path $installDir "scripts"
    New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
    Copy-Item (Join-Path $dir "scripts\*") $scriptsDir -Force

    # The "Hangar" service runs this install when its exe is this install's Hangar.exe (deploy.ps1's
    # rule). It starts it already, and a sign-in entry too would start a second daemon on the same port.
    $serviceExe = $null
    $svcInfo = Get-CimInstance Win32_Service -Filter "Name='Hangar'" -ErrorAction SilentlyContinue
    if ($svcInfo -and $svcInfo.PathName) {
      $serviceExe = if ($svcInfo.PathName -match '^\s*"([^"]+)"') { $Matches[1] } else { ($svcInfo.PathName.Trim() -split '\s+')[0] }
    }
    $ownService = try { $serviceExe -and ([IO.Path]::GetFullPath($serviceExe) -ieq (Join-Path $installDir "Hangar.exe")) } catch { $false }
    # On a first install only: an update leaves the sign-in entries as they are, the tray's own
    # "Start when I sign in" switched off included.
    if (-not $firstInstall) {
      Write-Host "    An update: the sign-in entries are left as they were." -ForegroundColor DarkGray
    } elseif ($env:HANGAR_NO_AUTOSTART -eq "1") {
      Write-Host "    HANGAR_NO_AUTOSTART is set: not starting it at sign-in." -ForegroundColor DarkGray
    } elseif ($ownService) {
      Write-Host "    It runs as the Hangar service: not adding a sign-in entry." -ForegroundColor DarkGray
    } else {
      Invoke-HangarScript "register-autostart.ps1" @("-ExePath", (Join-Path $installDir "Hangar.exe"))
    }

    # deploy.ps1 brings the tray back only when it was running; a first install starts it.
    $tray = Join-Path $installDir "Hangar.Tray.exe"
    if ($firstInstall -and (Test-Path -LiteralPath $tray)) { Start-Process $tray }

    Write-Host "==> Hangar is installed. Until you set a password it answers only this machine:" -ForegroundColor Green
    Write-Host "    https://github.com/$repo/blob/main/docs/install.md#first-run-set-a-password"
    Write-Host "    To remove it: powershell -ExecutionPolicy Bypass -File `"$scriptsDir\uninstall.ps1`""
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
