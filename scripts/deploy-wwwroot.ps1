<#
.SYNOPSIS
  Builds the SPA and deploys ONLY wwwroot (static frontend assets) to the install folder: -Target,
  else $env:HANGAR_INSTALL_DIR, else %LocalAppData%\Programs\Hangar (see scripts\_paths.ps1).

  Unlike scripts\deploy.ps1 this never rebuilds/replaces the exe and never stops or restarts
  the running instance — it just mirrors the freshly built wwwroot, so the live app picks up
  the new assets on the next browser refresh. Safe to run unprompted for frontend-only changes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-wwwroot.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-wwwroot.ps1 -Target D:\apps\hangar -SkipBuild
#>
param(
  [string]$Target,     # install folder; default $env:HANGAR_INSTALL_DIR, else %LocalAppData%\Programs\Hangar
  [switch]$SkipBuild   # deploy the existing server\wwwroot without rebuilding
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_paths.ps1")
if (-not $Target) { $Target = Get-HangarInstallDir }
# Only into an existing install: mirroring into a folder with no app in it would just make one with
# a lone wwwroot, which nothing serves.
if (-not (Test-Path (Join-Path $Target "Hangar.exe"))) {
  throw "No Hangar install at '$Target'. Deploy it first (scripts\deploy.ps1), or pass -Target."
}
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root "server\wwwroot"

# --- 1) Build the frontend (emits into server\wwwroot) ---------------------------------------
if (-not $SkipBuild) {
  Write-Host "==> Building frontend (web)" -ForegroundColor Cyan
  Push-Location (Join-Path $root "web")
  try {
    # A failed build must stop here: mirroring would ship whatever an earlier build left behind.
    if (-not (Test-Path "node_modules")) {
      npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
  } finally { Pop-Location }
} elseif (-not (Test-Path (Join-Path $src "index.html"))) {
  throw "No built frontend at '$src'. Run without -SkipBuild first."
}

# --- 2) Mirror wwwroot into the install folder (prunes stale hashed assets) ------------------
$dst = Join-Path $Target "wwwroot"
Write-Host "==> Mirroring wwwroot -> $dst" -ForegroundColor Cyan
robocopy $src $dst /MIR /NFL /NDL /NP /NJH /NJS | Out-Null
# robocopy exit codes 0-7 are success (bit flags); 8+ indicate a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE): $src -> $dst" }

Write-Host "==> Deployed wwwroot. Refresh the browser to pick up changes." -ForegroundColor Green

# The robocopy above exits 1 for "files were copied" and 2 for "extras were pruned" -- success, as
# far as robocopy is concerned, but it would otherwise be left as this script's own exit code and
# read as a failure by whatever ran it. Reaching this line means every step succeeded (the check
# above catches a real robocopy failure, and $ErrorActionPreference = "Stop" ends the script on any
# other error).
exit 0
