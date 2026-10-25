<#
.SYNOPSIS
  Builds Hangar and stages the result as a pending update, without touching the running app.

.DESCRIPTION
  This is the "publish an update" half of the in-app updater. It builds (scripts\build.ps1) and drops
  the published output into <Staging>\payload. The live app watches that folder: as soon as the staged
  build.json names a build id other than its own, an "Update available" button appears in the UI, and
  clicking it hands off to scripts\apply-update.ps1 -- which stops the app, mirrors the payload over the
  install folder and restarts it. Sessions that were running come back on their own (Sessions:ResumeOnStart).

  Nothing here stops or overwrites the running app, so staging is safe at any time. The payload is
  built in <Staging>\payload.tmp and swapped into place at the end, so the app never sees a half-copied
  update.

  The install folder's appsettings*.json are never part of the payload's authority -- apply-update.ps1
  preserves the ones already installed, exactly like deploy.ps1.

.PARAMETER Staging
  The folder to stage into -- it must be the one the running app watches. Defaults to that folder as
  the app finds it: $env:Update__StagingPath, else Update:StagingPath from the install's
  appsettings.Local.json, else from its appsettings.json, else %LocalAppData%\Hangar\updates (see
  scripts\_paths.ps1).

.PARAMETER NotesFile
  A "what's new" file to carry with the build, shown in the update dialog before anyone installs it.
  Plain text: lines starting with "-" or "*" are the changes, and the first line that is neither a
  bullet nor a heading is the one-line summary. Written for a person -- "the file panels can select
  and delete several files at once", not "d9ef182". Optional: without it the script falls back to the
  commit subjects between the installed build and this one, and -NoNotes carries nothing at all.

.PARAMETER Summary
  Overrides the summary line from -NotesFile, or supplies one when the notes came from the commits.

.PARAMETER NoNotes
  Stage with no "what's new" at all -- not even the commit subjects.

.PARAMETER InstallPath
  Where the running app lives: $env:HANGAR_INSTALL_DIR, else %LocalAppData%\Programs\Hangar, by
  default. Only read: its build.json names the commit the notes are measured from, and its settings
  name the staging folder when -Staging doesn't.

.PARAMETER NoTray
  Build without the tray app (passed to build.ps1). The installed tray is then left as it is.

.PARAMETER AllowDroppingCommits
  Stage even though the installed build's commit is not in the history of the one being staged.
  Without it the script stops there, since installing would quietly take away what that commit
  brought: a build made from a branch that was never merged, say.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1 -NotesFile .\whats-new.md
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1 -Staging D:\apps\hangar-updates -SkipBuild
#>
param(
  [string]$Staging,
  [switch]$SkipBuild,  # stage the existing ./publish output without rebuilding
  [string]$NotesFile,
  [string]$Summary,
  [switch]$NoNotes,
  [string]$InstallPath,
  [switch]$NoTray,
  [switch]$AllowDroppingCommits
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_paths.ps1")
if (-not $InstallPath) { $InstallPath = Get-HangarInstallDir }
if (-not $Staging) { $Staging = Get-HangarStagingDir $InstallPath }
$root    = Split-Path -Parent $PSScriptRoot
$publish = Join-Path $root "publish"

# The commit the installed build came from -- the one being replaced, and so the only place a range
# of "news" can honestly start.
function Get-InstalledCommit([string]$installPath) {
  $stampPath = Join-Path $installPath "build.json"
  if (-not (Test-Path $stampPath)) { return $null }
  try { return (Get-Content $stampPath -Raw | ConvertFrom-Json).commit } catch { return $null }
}

# --- 0) Nothing installed is left behind -------------------------------------------------------
# A build staged from a history that doesn't contain the installed one's commit takes away whatever
# that commit brought, and nothing says so: the notes only list what is *added*. That is how a
# feature built and staged from an unmerged branch vanished when the next build came from main.
# Asked before building, of what will be built (HEAD) or, with -SkipBuild, of what was.
function Assert-KeepsInstalled([string]$target) {
  $installed = Get-InstalledCommit $InstallPath
  if (-not $installed -or -not $target -or $AllowDroppingCommits) { return }
  # Windows PowerShell turns a native command's stderr into an error, which "Stop" makes fatal; the
  # answers here are exit codes, and "fatal: Not a valid object name" is one of them.
  $ErrorActionPreference = "Continue"
  git -C $root cat-file -e "$installed^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "The installed build's commit $installed is not in this repository; can't tell what staging would drop."
    return
  }
  git -C $root merge-base --is-ancestor $installed $target 2>$null
  if ($LASTEXITCODE -eq 0) { return }
  $dropped = @(git -C $root log --oneline "$target..$installed" 2>$null)
  throw ("The installed build ($installed) has commits the build being staged ($target) does not:`n" +
    (($dropped | Select-Object -First 15 | ForEach-Object { "  $_" }) -join "`n") +
    "`nInstalling it would take them away. Merge them first, or pass -AllowDroppingCommits if that is the intent.")
}
if (-not $SkipBuild) {
  Assert-KeepsInstalled (git -C $root rev-parse --short HEAD 2>$null)
}

# --- 1) Build + publish (single self-contained exe into ./publish) ---------------------------
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build.ps1") -NoTray:$NoTray
} elseif (-not (Test-Path (Join-Path $publish "Hangar.exe"))) {
  throw "No published build at '$publish'. Run without -SkipBuild first."
}

$stampFile = Join-Path $publish "build.json"
if (-not (Test-Path $stampFile)) {
  throw "No build stamp at '$stampFile'. Rebuild with scripts\build.ps1 (it writes build.json)."
}
$stamp = Get-Content $stampFile -Raw | ConvertFrom-Json
if ($SkipBuild) { Assert-KeepsInstalled $stamp.commit }

# --- 1b) What's new ---------------------------------------------------------------------------
# The notes ride in the payload's own build.json: the one file the running app already reads out of
# the staging folder, so there is nothing new for it to poll. It also means they survive the update
# -- once installed, a build still carries the account of what it brought.
function Read-NotesFile([string]$path) {
  $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
  $changes = @()
  $summary = $null
  foreach ($line in $lines) {
    $t = $line.Trim()
    if (-not $t) { continue }
    if ($t -match '^[-*]\s+(.*)$') { $changes += $Matches[1].Trim() }
    # A heading ("# What's new") labels the file rather than saying anything; the first plain line is
    # the summary, and further prose is left out rather than mixed in among the bullets.
    elseif (-not $summary -and $t -notmatch '^#') { $summary = $t }
  }
  return @{ summary = $summary; changes = $changes }
}

function Get-CommitNotes([string]$since, [string]$root) {
  if (-not $since) { return $null }
  $subjects = @(git -C $root log --no-merges --pretty=format:%s "$since..HEAD" 2>$null)
  if ($LASTEXITCODE -ne 0 -or $subjects.Count -eq 0) { return $null }
  return @{ summary = $null; changes = @($subjects | Select-Object -First 40); since = $since }
}

$notes = $null
if (-not $NoNotes) {
  if ($NotesFile) {
    if (-not (Test-Path -LiteralPath $NotesFile)) { throw "Notes file not found: '$NotesFile'." }
    $notes = Read-NotesFile $NotesFile
  } else {
    # Nobody wrote any, so let the commits speak. Worth less than a summary written for a reader and
    # worth more than an empty dialog, and it costs a staging run done by hand nothing to get it.
    $notes = Get-CommitNotes (Get-InstalledCommit $InstallPath) $root
  }
}
# -NoNotes wins: it says "carry nothing", and a summary passed alongside it is a contradiction that
# should not quietly turn the notes back on.
if ($Summary -and -not $NoNotes) {
  if (-not $notes) { $notes = @{ changes = @() } }
  $notes.summary = $Summary
}
if ($notes -and -not $notes.ContainsKey('since')) { $notes.since = Get-InstalledCommit $InstallPath }
# Notes that say nothing are no notes: the dialog tests for their presence, not their contents.
if ($notes -and -not $notes.summary -and @($notes.changes).Count -eq 0) { $notes = $null }

# --- 2) Copy into a scratch payload, then swap it in ------------------------------------------
# Building the payload under a temp name means an app polling <Staging>\payload never reads a
# partially-copied build: it sees the previous payload, then the new one, never a mixture.
$final = Join-Path $Staging "payload"
$tmp   = Join-Path $Staging "payload.tmp"
$old   = Join-Path $Staging "payload.old"

New-Item -ItemType Directory -Force -Path $Staging | Out-Null
foreach ($stale in @($tmp, $old)) {
  if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
}

Write-Host "==> Staging update $($stamp.buildId) -> $final" -ForegroundColor Cyan
$quiet = @("/NFL", "/NDL", "/NP", "/NJH", "/NJS")
robocopy $publish $tmp /E @quiet | Out-Null
# robocopy exit codes 0-7 are success (bit flags); 8+ indicate a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE): $publish -> $tmp" }

# Written into the payload's copy of the stamp rather than ./publish's: the notes belong to this
# staging, not to the build, so staging the same build again with a different account of it stays a
# thing that can be done.
if ($notes) {
  $stamped = [ordered]@{
    buildId    = $stamp.buildId
    commit     = $stamp.commit
    branch     = $stamp.branch
    builtAtUtc = $stamp.builtAtUtc
    runtime    = $stamp.runtime
    notes      = [ordered]@{
      summary = $notes.summary
      changes = @($notes.changes)
      since   = $notes.since
    }
  }
  $stamped | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $tmp "build.json") -Encoding UTF8
}

# Swap: rename the live payload out of the way, the new one in, then drop the old. A rename within
# one folder is near-instant, so the window where <Staging>\payload doesn't exist is negligible --
# and the app treats "no payload" as simply nothing staged, never as an error.
if (Test-Path $final) { Rename-Item $final -NewName "payload.old" }
Rename-Item $tmp -NewName "payload"
if (Test-Path $old) { Remove-Item $old -Recurse -Force }

Write-Host "==> Staged. The running app will offer this build in its UI." -ForegroundColor Green
Write-Host "    Build:  $($stamp.buildId)"
Write-Host "    Commit: $($stamp.commit)  Branch: $($stamp.branch)"
if ($notes) {
  $n = @($notes.changes).Count
  $line = "    What's new: $n change" + $(if ($n -ne 1) { "s" }) + $(if ($notes.summary) { " -- $($notes.summary)" })
  Write-Host $line
} else {
  Write-Host "    What's new: nothing recorded (pass -NotesFile to say what changed)."
}
Write-Host ("    If no button appears, check Update:StagingPath in $InstallPath\appsettings.Local.json (or " +
  "appsettings.json) -- the app must be watching '$Staging'.")

# The robocopy above exits 1 for "files were copied" -- success, as far as robocopy is concerned, but it
# would otherwise be left as this script's own exit code and read as a failure by whatever ran it.
# Reaching this line means every step succeeded ($ErrorActionPreference = "Stop" ends the script otherwise).
exit 0
