# Builds the SPA and publishes Hangar into ./publish: the daemon, the tray and the pty host, each a
# single self-contained exe. The daemon and the pty host need the .NET SDK; the tray (tray\, a Tauri
# app) needs Rust and Node.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> Building frontend (web)" -ForegroundColor Cyan
Push-Location (Join-Path $root "web")
if (-not (Test-Path "node_modules")) { npm install }
npm run build            # emits into ../server/wwwroot
Pop-Location

Write-Host "==> Publishing daemon (server)" -ForegroundColor Cyan
$publish = Join-Path $root "publish"
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
Push-Location (Join-Path $root "server")
# Self-contained single-file so it runs on a machine without the .NET runtime installed.
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $publish
Pop-Location

# The other two projects are each published into a scratch folder and then copied in: publishing them
# straight into ./publish would let one project's runtime files land on top of another's.

# The per-session pty host. It owns each session's pseudoconsole, which is what lets a claude session
# outlive the daemon -- so it ships alongside Hangar.exe and the daemon refuses to launch a session
# without it. Self-contained for the same reason the daemon is (no .NET runtime assumed), but a much
# smaller image: no ASP.NET.
Write-Host "==> Publishing pty host (ptyhost)" -ForegroundColor Cyan
$ptyOut = Join-Path $root "publish-ptyhost"
if (Test-Path $ptyOut) { Remove-Item $ptyOut -Recurse -Force }
Push-Location (Join-Path $root "ptyhost")
# Trimmed, unlike the daemon: it is a tiny console program, and trimming takes it from ~70 MB to ~14 MB.
# Safe because everything crossing the pipe goes through a source-generated JSON context
# (shared\Pty\PtyJson.cs) rather than reflection -- if you add a wire type, add it there too.
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $ptyOut
Pop-Location
Copy-Item (Join-Path $ptyOut "*") $publish -Recurse -Force
Remove-Item $ptyOut -Recurse -Force

# The tray app: a client of the daemon's API, built with Tauri (Rust, with its pages compiled in), so
# it is one exe with nothing beside it. Shipped as Hangar.Tray.exe, the name everything that starts,
# stops and updates it already uses.
Write-Host "==> Building tray (tray)" -ForegroundColor Cyan
Push-Location (Join-Path $root "tray")
try {
  if (-not (Test-Path "node_modules")) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed in tray\" }
  }
  # --no-bundle: the exe is all an install needs; installers (MSI/NSIS) are for handing it to others.
  npx tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed in tray\" }
} finally {
  Pop-Location
}
Copy-Item (Join-Path $root "tray\src-tauri\target\release\hangar-tray.exe") (Join-Path $publish "Hangar.Tray.exe") -Force

# --- Build stamp ------------------------------------------------------------------------------
# Names this exact build so a running app can tell a staged update apart from itself. deploy.ps1
# copies it next to the exe; the app reads its own from there and the staged one from the update
# folder (see scripts\stage-update.ps1 and server\Update\UpdateService.cs).
$commit  = try { (git -C $root rev-parse --short HEAD 2>$null) } catch { $null }
$branch  = try { (git -C $root rev-parse --abbrev-ref HEAD 2>$null) } catch { $null }
$builtAt = (Get-Date).ToUniversalTime()
$stamp = [ordered]@{
  buildId    = "{0}-{1}" -f $builtAt.ToString("yyyyMMdd'T'HHmmss'Z'"), $(if ($commit) { $commit } else { "nogit" })
  commit     = $commit
  branch     = $branch
  builtAtUtc = $builtAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
}
$stamp | ConvertTo-Json | Set-Content (Join-Path $publish "build.json") -Encoding UTF8

Write-Host "==> Done. Published to: $publish" -ForegroundColor Green
Write-Host "    Build stamp: $($stamp.buildId)" -ForegroundColor DarkGray
foreach ($exe in @("Hangar.exe", "Hangar.PtyHost.exe", "Hangar.Tray.exe")) {
  if (-not (Test-Path (Join-Path $publish $exe))) { throw "$exe is missing from '$publish'." }
}
Write-Host "    Run the server:      $publish\Hangar.exe        (headless; browse to its port)"
Write-Host "    Run the tray icon:   $publish\Hangar.Tray.exe"
Write-Host "    Both at sign-in:     scripts\register-autostart.ps1 -ExePath $publish\Hangar.exe"
