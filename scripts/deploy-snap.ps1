<#
.SYNOPSIS
  Builds Homeport Snap (snap/) in release mode and installs it to a folder of its own
  (default C:\apps\homeport-snap), then starts it.

  Snap is a single executable — the web pages are compiled into it — so installing is copying that one
  file. Its settings and recents live in the user's local app data
  (%LOCALAPPDATA%\io.github.sdm-kz.homeport.snap), not next to the exe, so a reinstall keeps them.

  Every running Homeport Snap is stopped first, wherever it runs from: the app is single-instance, so a
  copy left running (a dev build, an older install) would swallow the new one's launch. When the app
  is registered to start at sign-in, that registration names the exe it was made from; it is pointed
  at the installed one, so sign-in starts this build rather than whatever registered itself last.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-snap.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-snap.ps1 -SkipBuild -Autostart
#>
param(
  [string]$Target = "C:\apps\homeport-snap",
  [switch]$SkipBuild,   # install the existing release build without rebuilding
  [switch]$NoStart,     # leave it stopped after installing
  [switch]$Autostart    # also register it to start at sign-in (it is always re-pointed if registered)
)

$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $PSScriptRoot
$snap  = Join-Path $root "snap"
$built = Join-Path $snap "src-tauri\target\release\homeport-snap.exe"
$exe   = Join-Path $Target "homeport-snap.exe"

# --- 1) Build ---------------------------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host "==> Building Homeport Snap (release)" -ForegroundColor Cyan
  Push-Location $snap
  try {
    if (-not (Test-Path (Join-Path $snap "node_modules"))) {
      npm ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }
    # --no-bundle: the exe is all an install needs; installers (MSI/NSIS) are for handing it to others.
    npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $built)) { throw "No release build at '$built'. Run without -SkipBuild first." }

# --- 2) Stop every running Snap ------------------------------------------------------------------------
$running = @(Get-Process -Name "homeport-snap" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host "==> Stopping Homeport Snap ($($running.Count) process(es))" -ForegroundColor Cyan
  $running | Stop-Process -Force
  $running | ForEach-Object { try { $_.WaitForExit(5000) | Out-Null } catch { } }
}

# --- 3) Install ----------------------------------------------------------------------------------------
Write-Host "==> Installing to $Target" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -LiteralPath $built -Destination $exe -Force

# --- 4) Start at sign-in -----------------------------------------------------------------------------
# The same entry tauri-plugin-autostart writes: HKCU Run, named after the product, the exe and the flag
# that tells the app it was started at sign-in (so it doesn't open its settings window).
$runKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "Homeport Snap"
$command = "`"$exe`" --autostart"
$current = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue).$runName
if ($Autostart -or $current) {
  if ($current -ne $command) {
    Set-ItemProperty -Path $runKey -Name $runName -Value $command
    Write-Host "==> Starts at sign-in: $command" -ForegroundColor Cyan
  }
}

# --- 5) Run --------------------------------------------------------------------------------------------
if (-not $NoStart) {
  Write-Host "==> Starting Homeport Snap" -ForegroundColor Cyan
  # Without --autostart: on a machine that has never run it, the settings window should open.
  Start-Process -FilePath $exe -WorkingDirectory $Target
}

Write-Host "Done: $exe" -ForegroundColor Green
