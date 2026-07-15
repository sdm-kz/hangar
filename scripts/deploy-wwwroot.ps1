<#
.SYNOPSIS
  Builds the SPA and deploys ONLY wwwroot (static frontend assets) to the install folder.

  Unlike scripts\deploy.ps1 this never rebuilds/replaces the exe and never stops or restarts
  the running instance — it just mirrors the freshly built wwwroot, so the live app picks up
  the new assets on the next browser refresh. Safe to run unprompted for frontend-only changes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-wwwroot.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy-wwwroot.ps1 -Target D:\apps\claude-web -SkipBuild
#>
param(
  [string]$Target = "C:\apps\claude-web",
  [switch]$SkipBuild   # deploy the existing server\wwwroot without rebuilding
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root "server\wwwroot"

# --- 1) Build the frontend (emits into server\wwwroot) ---------------------------------------
if (-not $SkipBuild) {
  Write-Host "==> Building frontend (web)" -ForegroundColor Cyan
  Push-Location (Join-Path $root "web")
  try {
    if (-not (Test-Path "node_modules")) { npm install }
    npm run build
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
