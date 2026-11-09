<#
.SYNOPSIS
  Builds the SPA and publishes Hangar into ./publish: the daemon, the pty host and (when it can be built
  here) the tray, each a single self-contained exe.

.DESCRIPTION
  The daemon and the pty host need the .NET SDK and Node. The tray (tray\, a Tauri app) also needs Rust
  (cargo) and the MSVC build tools, and builds only for the machine it is built on; it is left out, with a
  warning, when cargo is not on PATH or -Rid names another CPU -- the server is complete without it.
  -NoTray leaves it out regardless. The pty host is compiled to native code when -Rid is this machine's
  own CPU and the MSVC build tools are installed (the "Desktop development with C++" workload, which the
  tray needs too), and published as a larger trimmed single file otherwise.

  Every step's exit code is checked and the first failure stops the build: a web build that failed must
  not leave the previous server\wwwroot to be published as if it were this one.

  Writes publish\build.json, the stamp the in-app updater tells builds apart by. A release build sets
  HANGAR_VERSION (the release workflow does, from the tag: v1.2.3 is 1.2.3); it goes into build.json and
  the exes' version resources. Unset, the build is named by its commit alone.

.PARAMETER Rid
  The .NET runtime id to publish for: win-x64 or win-arm64. Defaults to this machine's own CPU.

.PARAMETER NoTray
  Build without the tray app (Hangar.Tray.exe).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -NoTray
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Rid win-arm64
#>
param(
  [ValidateSet("", "win-x64", "win-arm64")][string]$Rid = "",
  [switch]$NoTray
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# A native command's failure is only an exit code; $ErrorActionPreference doesn't see it.
function Assert-ExitCode([string]$what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)." }
}

# This machine's runtime id. Read from the machine's own environment block rather than this process's:
# an x64 PowerShell emulated on an arm64 machine is told it runs on AMD64.
function Get-HostRid {
  $arch = try {
    (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  } catch { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    "AMD64" { return "win-x64" }
    "ARM64" { return "win-arm64" }
    default { throw "Unsupported CPU '$arch'. Pass -Rid win-x64 or -Rid win-arm64." }
  }
}
$hostRid = Get-HostRid
if (-not $Rid) { $Rid = $hostRid }

# The release version, when this build is one (see the help).
$version = $env:HANGAR_VERSION
if ($version -and $version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "HANGAR_VERSION must be a version like 1.2.3 or 1.2.3-rc.1; got '$version'."
}
# @(...): an if's lone result would come out a string, and a string splats as its characters.
$versionArgs = @(if ($version) { "-p:Version=$version" })

# The tray, when it can be built here (see the help). Decided up front so the summary can say why not.
$trayNote = $null
if ($NoTray) {
  $trayNote = "left out (-NoTray)"
} elseif ($Rid -ne $hostRid) {
  $trayNote = "left out: a $Rid tray can only be built on a $Rid machine"
} elseif (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  $trayNote = "left out: no cargo (Rust) on PATH -- install Rust and the MSVC build tools to build it"
  Write-Warning "cargo is not on PATH: building without the tray app (Hangar.Tray.exe)."
}
$withTray = -not $trayNote

Write-Host "==> Building frontend (web)" -ForegroundColor Cyan
Push-Location (Join-Path $root "web")
try {
  if (-not (Test-Path "node_modules")) { npm install; Assert-ExitCode "npm install (web)" }
  npm run build; Assert-ExitCode "npm run build (web)"   # emits into ../server/wwwroot
} finally { Pop-Location }

Write-Host "==> Publishing daemon (server) for $Rid" -ForegroundColor Cyan
$publish = Join-Path $root "publish"
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
Push-Location (Join-Path $root "server")
try {
  # Self-contained single-file so it runs on a machine without the .NET runtime installed.
  dotnet publish -c Release -r $Rid --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    @versionArgs `
    -o $publish
  Assert-ExitCode "dotnet publish (server)"
} finally { Pop-Location }

# The other two projects are each published into a scratch folder and then copied in: publishing them
# straight into ./publish would let one project's runtime files land on top of another's.

# The per-session pty host. It owns each session's pseudoconsole, which is what lets a claude session
# outlive the daemon -- so it ships alongside Hangar.exe and the daemon refuses to launch a session
# without it. Self-contained for the same reason the daemon is (no .NET runtime assumed), but a much
# smaller image: no ASP.NET.
#
# Compiled to native code (NativeAOT) when it can be: one runs per session, and against the trimmed single
# file a native host is ~6 MB on disk rather than ~15, and runs in ~5 MB less private memory, ~20 MB less
# working set and half the threads (no JIT; the rest is the terminal's own history). That takes the MSVC
# linker, so a build without the build tools gets the trimmed single file instead -- the same host, only
# bigger. So does a build for another CPU: compiling across CPUs needs that CPU's MSVC tools as well, and
# is left alone rather than shipped untried.
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$ptyAot = $false
if ($Rid -ne $hostRid) {
  $ptyNote = "trimmed single file: it is compiled natively only for this machine's own CPU ($hostRid)"
} elseif (-not (Test-Path $vswhere)) {
  $ptyNote = "trimmed single file: no Visual Studio installer here, so no MSVC build tools to compile it natively"
} else {
  $vcTools = if ($Rid -eq "win-arm64") { "ARM64" } else { "x86.x64" }
  $vs = & $vswhere -latest -prerelease -products * -requires "Microsoft.VisualStudio.Component.VC.Tools.$vcTools" -property installationPath
  if ($vs) {
    $ptyAot = $true
    $ptyNote = "native (NativeAOT)"
  } else {
    $ptyNote = "trimmed single file: no MSVC build tools for $Rid, so it can't be compiled natively"
  }
}
if (-not $ptyAot) { Write-Warning "Pty host: $ptyNote." }

Write-Host "==> Publishing pty host (ptyhost) for $Rid" -ForegroundColor Cyan
$ptyOut = Join-Path $root "publish-ptyhost"
if (Test-Path $ptyOut) { Remove-Item $ptyOut -Recurse -Force }
Push-Location (Join-Path $root "ptyhost")
$path = $env:PATH
try {
  # Either way the build trims, which is safe because everything crossing the pipe goes through a
  # source-generated JSON context (shared\Pty\PtyJson.cs) rather than reflection -- if you add a wire
  # type, add it there too.
  if ($ptyAot) {
    # The compiler finds the linker through vcvarsall.bat, which runs vswhere.exe by bare name: from a
    # shell whose PATH lacks the installer folder, its "not recognized" lands in the linker's path.
    $env:PATH = "$(Split-Path $vswhere);$env:PATH"
    dotnet publish -c Release -r $Rid -p:PublishAot=true @versionArgs -o $ptyOut
  } else {
    dotnet publish -c Release -r $Rid --self-contained true `
      -p:PublishSingleFile=true `
      -p:PublishTrimmed=true `
      -p:IncludeNativeLibrariesForSelfExtract=true `
      @versionArgs `
      -o $ptyOut
  }
  Assert-ExitCode "dotnet publish (ptyhost)"
} finally {
  $env:PATH = $path
  Pop-Location
}
# A native build's symbols are ~25 MB, four times the exe they describe, and nothing in an install reads
# them: its exception stack traces carry method names without them.
if ($ptyAot) { Remove-Item (Join-Path $ptyOut "*.pdb") -Force }
Copy-Item (Join-Path $ptyOut "*") $publish -Recurse -Force
Remove-Item $ptyOut -Recurse -Force

# The tray app: a client of the daemon's API, built with Tauri (Rust, with its pages compiled in), so
# it is one exe with nothing beside it. Shipped as Hangar.Tray.exe, the name everything that starts,
# stops and updates it already uses. Once it is being built, a failure stops the build like any other
# (unlike build.sh, which goes on without it): pass -NoTray to build without it on purpose.
if ($withTray) {
  Write-Host "==> Building tray (tray)" -ForegroundColor Cyan
  Push-Location (Join-Path $root "tray")
  try {
    if (-not (Test-Path "node_modules")) { npm ci; Assert-ExitCode "npm ci (tray)" }
    # --no-bundle: the exe is all an install needs; installers (MSI/NSIS) are for handing it to others.
    $trayArgs = @("--no-bundle")
    $trayConfig = $null
    if ($version) {
      # Merged over tauri.conf.json. The plain major.minor.patch: a Windows version resource has no
      # room for "-rc.1". Written without a BOM, which Windows PowerShell's Set-Content would add.
      $trayConfig = Join-Path ([IO.Path]::GetTempPath()) "hangar-tray-version-$PID.json"
      [IO.File]::WriteAllText($trayConfig, (@{ version = ($version -split '-')[0] } | ConvertTo-Json))
      $trayArgs += @("--config", $trayConfig)
    }
    npx tauri build @trayArgs
    Assert-ExitCode "tauri build (tray; pass -NoTray to build without it)"
  } finally {
    if ($trayConfig) { Remove-Item $trayConfig -Force -ErrorAction SilentlyContinue }
    Pop-Location
  }
  Copy-Item (Join-Path $root "tray\src-tauri\target\release\hangar-tray.exe") (Join-Path $publish "Hangar.Tray.exe") -Force
  $trayNote = Join-Path $publish "Hangar.Tray.exe"
}

# --- Build stamp ------------------------------------------------------------------------------
# Names this exact build so a running app can tell a staged update apart from itself. deploy.ps1
# copies it next to the exe; the app reads its own from there and the staged one from the update
# folder (see scripts\stage-update.ps1 and server\Update\UpdateService.cs).
$commit  = try { (git -C $root rev-parse --short HEAD 2>$null) } catch { $null }
$branch  = try { (git -C $root rev-parse --abbrev-ref HEAD 2>$null) } catch { $null }
$builtAt = (Get-Date).ToUniversalTime()
$stamp = [ordered]@{
  buildId    = "{0}-{1}" -f $builtAt.ToString("yyyyMMdd'T'HHmmss'Z'"), $(if ($commit) { $commit } else { "nogit" })
  version    = $(if ($version) { $version } else { $null })
  commit     = $commit
  branch     = $branch
  builtAtUtc = $builtAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  runtime    = $Rid
}
$stamp | ConvertTo-Json | Set-Content (Join-Path $publish "build.json") -Encoding UTF8

$expected = @("Hangar.exe", "Hangar.PtyHost.exe")
if ($withTray) { $expected += "Hangar.Tray.exe" }
foreach ($exe in $expected) {
  if (-not (Test-Path (Join-Path $publish $exe))) { throw "$exe is missing from '$publish'." }
}
Write-Host "==> Done. Published to: $publish ($Rid)" -ForegroundColor Green
Write-Host "    Build stamp: $($stamp.buildId)$(if ($version) { " (version $version)" })" -ForegroundColor DarkGray
Write-Host "    Pty host:            $ptyNote"
Write-Host "    Run the server:      $publish\Hangar.exe        (headless; browse to its port)"
Write-Host "    Tray app:            $trayNote"
Write-Host "    Install it:          scripts\deploy.ps1 -SkipBuild, then scripts\register-autostart.ps1"
# git's "not a repository" above is an exit code too; this script's own is success by now.
exit 0
