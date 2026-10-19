<#
.SYNOPSIS
  Moves each session folder's .claudeweb\ (Hangar's files from before the rename) to .hangar\, and
  points the .gitignore line that ignored it at the new name.

.DESCRIPTION
  Hangar keeps pasted images, postponed messages and pull-request reviews in .hangar\ under a
  session's working directory. Builds from before the rename used .claudeweb\; the app still reads
  what is there, so this is tidying, not a requirement. For every folder Hangar knows about (its
  sessions, recent folders and projects, plus any -Path you add) that still has a .claudeweb\:

    1. Its contents move into .hangar\ and .claudeweb\ goes. Nothing is overwritten: when a file of
       the same name is already in .hangar\, an identical old copy is dropped and a different one is
       kept beside it as <name>.from-claudeweb<ext> (reported).
    2. .hangar\ gets the .gitignore of "*" the app writes, so git never lists it.
    3. Postponed messages that name an image under .claudeweb\ are pointed at .hangar\.
    4. The ignore rule that matched .claudeweb\ -- found with `git check-ignore`, plus the folder's own
       .gitignore -- is changed to .hangar/, or dropped when the file already lists .hangar. Not while
       a folder it covers still has a .claudeweb\ (a move that failed): that would put the folder in
       git status. These are changes in the repos themselves: commit them (or not) as you see fit.

  Without -Apply it only prints what it would do. Conversations that mention an old image path keep
  mentioning it; Claude already read those images when they were sent.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\migrate-claudeweb-folders.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\migrate-claudeweb-folders.ps1 -Apply
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\migrate-claudeweb-folders.ps1 -Path "D:\work\repo;D:\other" -Apply
#>
param(
  [string[]]$Path = @(),   # more folders to look at, beside the ones Hangar knows ("a;b" for several)
  [switch]$Apply           # without it, only say what would be done
)
$ErrorActionPreference = "Stop"

$Old = ".claudeweb"
$New = ".hangar"
$data = Join-Path $env:LOCALAPPDATA "Hangar"

function Say([string]$text, [string]$color = "Gray") { Write-Host $text -ForegroundColor $color }

# --- Which folders ---------------------------------------------------------------------------------
function Read-Json([string]$file) {
  if (-not (Test-Path $file)) { return $null }
  try { return Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}
$folders = New-Object System.Collections.Generic.List[string]
# -File hands "-Path a,b" over as one string; ";" separates folders there (a "," can be in a name).
foreach ($p in $Path) { foreach ($one in ($p -split ';')) { if ($one.Trim()) { $folders.Add($one.Trim()) } } }
# Parentheses around each source: Windows PowerShell 5.1 hands a JSON array down the pipeline as one object.
$sessions = Read-Json (Join-Path $data "sessions.json")
if ($sessions) { (@($sessions)) | ForEach-Object { if ($_.WorkingDirectory) { $folders.Add($_.WorkingDirectory) } } }
$recents = Read-Json (Join-Path $data "recents.json")
if ($recents) {
  (@($recents.Sessions)) | ForEach-Object { if ($_.WorkingDirectory) { $folders.Add($_.WorkingDirectory) } }
  (@($recents.Folders)) | ForEach-Object {
    if ($_ -is [string]) { $folders.Add($_) } elseif ($_.Path) { $folders.Add($_.Path) }
  }
}
$projects = Read-Json (Join-Path $data "projects.json")
if ($projects) { (@($projects.projects)) | ForEach-Object { (@($_.folders)) | ForEach-Object { if ($_) { $folders.Add($_) } } } }

$seen = @{}
$targets = foreach ($f in $folders) {
  try { $full = [IO.Path]::GetFullPath($f).TrimEnd('\') } catch { continue }
  if ($seen.ContainsKey($full.ToLowerInvariant())) { continue }
  $seen[$full.ToLowerInvariant()] = $true
  if (Test-Path -LiteralPath (Join-Path $full $Old) -PathType Container) { $full }
}
$targets = @($targets)
if ($targets.Count -eq 0) { Say "No folder Hangar knows has a $Old\ left. Nothing to do." Green; exit 0 }
Say "$($targets.Count) folder(s) with a $Old\:" Cyan
if (-not $Apply) { Say "(dry run -- nothing is changed; run again with -Apply)" Yellow }

# --- Ignore rules ------------------------------------------------------------------------------------
# A line that is just the old folder's name, in the forms people write it.
$ruleLine = '^(\s*/?)\.claudeweb(/?\**)?(\s*)$'

# The ignore files to fix, each once however many folders share it: path -> the folders it covers.
$ignoreFiles = [ordered]@{}
function Add-IgnoreFile([string]$file, [string]$folder) {
  $key = [IO.Path]::GetFullPath($file)
  if (-not $ignoreFiles.Contains($key)) { $ignoreFiles[$key] = New-Object System.Collections.Generic.List[string] }
  $ignoreFiles[$key].Add($folder)
}
function Add-IgnoreSources([string]$folder) {
  # git's "not a git repository" on stderr is an answer here, not a failure -- and under "Stop"
  # Windows PowerShell 5.1 turns any native stderr line into a terminating error, 2>$null or not.
  $ErrorActionPreference = "Continue"
  $own = Join-Path $folder ".gitignore"
  if (Test-Path -LiteralPath $own) { Add-IgnoreFile $own $folder }
  $null = git -C $folder rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0) { return }
  # "source:line:pattern<TAB>path" for the rule that ignores it, nothing if none does.
  $hit = git -C $folder check-ignore -v --no-index "$Old/x" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $hit) { return }
  $m = [regex]::Match([string]$hit, '^(.*):(\d+):([^\t]*)\t')
  if (-not $m.Success -or $m.Groups[3].Value -notmatch 'claudeweb') { return }
  $source = $m.Groups[1].Value
  if (-not [IO.Path]::IsPathRooted($source)) {
    $top = git -C $folder rev-parse --show-toplevel 2>$null
    $source = Join-Path $top $source
  }
  Add-IgnoreFile $source $folder
}

# --- Per folder --------------------------------------------------------------------------------------
$failed = 0
foreach ($folder in $targets) {
  $oldDir = Join-Path $folder $Old
  $newDir = Join-Path $folder $New
  Add-IgnoreSources $folder

  $files = @(Get-ChildItem -LiteralPath $oldDir -Recurse -File -Force)
  $clash = @($files | Where-Object { Test-Path -LiteralPath (Join-Path $newDir $_.FullName.Substring($oldDir.Length + 1)) })
  $note = if ($clash.Count) { ", $($clash.Count) also in $New\ under the same name" } else { "" }
  Say ("  {0}  ({1} file(s){2})" -f $folder, $files.Count, $note)
  if (-not $Apply) { continue }
  try {
    # 1) Move, never overwriting. A plain rename when there is no .hangar\ yet.
    if (-not (Test-Path -LiteralPath $newDir)) {
      Rename-Item -LiteralPath $oldDir -NewName $New
    } else {
      foreach ($file in $files) {
        $dest = Join-Path $newDir $file.FullName.Substring($oldDir.Length + 1)
        if (Test-Path -LiteralPath $dest) {
          if ((Get-FileHash -LiteralPath $dest).Hash -eq (Get-FileHash -LiteralPath $file.FullName).Hash) {
            Remove-Item -LiteralPath $file.FullName   # the same file twice: one is enough
            continue
          }
          $stem = [IO.Path]::GetFileNameWithoutExtension($dest); $ext = [IO.Path]::GetExtension($dest)
          $dest = Join-Path (Split-Path $dest) "$stem.from-claudeweb$ext"
          for ($n = 2; Test-Path -LiteralPath $dest; $n++) { $dest = Join-Path (Split-Path $dest) "$stem.from-claudeweb-$n$ext" }
          Say "    kept the old $($file.Name) as $(Split-Path -Leaf $dest)" Yellow
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        Move-Item -LiteralPath $file.FullName -Destination $dest
      }
      # Empty folders, deepest first, then .claudeweb\ itself if nothing is left in it
      # (-Force: OneDrive marks its folders read-only).
      Get-ChildItem -LiteralPath $oldDir -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending |
        Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
      if (-not (Get-ChildItem -LiteralPath $oldDir -Force)) { Remove-Item -LiteralPath $oldDir -Force }
    }

    # 2) The folder ignores itself, as the app makes it.
    $selfIgnore = Join-Path $newDir ".gitignore"
    if (-not (Test-Path -LiteralPath $selfIgnore)) {
      [IO.File]::WriteAllText($selfIgnore, "# Hangar's own files (pasted images, postponed messages, reviews).`n*`n")
    }

    # 3) Postponed messages name their images by path, relative and absolute (backslashes doubled in JSON).
    foreach ($pool in @(Get-ChildItem -LiteralPath (Join-Path $newDir "postponed") -Filter "*.json" -File -ErrorAction SilentlyContinue)) {
      $text = [IO.File]::ReadAllText($pool.FullName)
      $fixed = $text.Replace("$Old/", "$New/").Replace("\\$Old\\", "\\$New\\")
      if ($fixed -ne $text) { [IO.File]::WriteAllText($pool.FullName, $fixed, (New-Object Text.UTF8Encoding $false)) }
    }
  } catch {
    # Something holds a file open (an editor, a running build): this folder stays as it was, or half
    # moved -- run the script again later; it picks up whatever is left.
    Say "    could not finish: $($_.Exception.Message)" Red
    $failed++
  }
}

# --- 4) The ignore files ----------------------------------------------------------------------------
$changedIgnores = @()
$heldIgnores = @()
foreach ($file in $ignoreFiles.Keys) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  if ($Apply -and @($ignoreFiles[$file] | Where-Object { Test-Path -LiteralPath (Join-Path $_ $Old) }).Count) {
    $heldIgnores += $file
    continue
  }
  $bytes = [IO.File]::ReadAllBytes($file)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = (New-Object Text.UTF8Encoding $false).GetString($bytes, $(if ($bom) { 3 } else { 0 }), $bytes.Length - $(if ($bom) { 3 } else { 0 }))
  $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = $text -split "`r?`n"   # no limit: in PowerShell 7 a negative one splits from the right
  if (-not ($lines | Where-Object { $_ -match $ruleLine })) { continue }
  $hasNew = [bool]($lines | Where-Object { $_ -match '^\s*/?\.hangar(/?\**)?\s*$' })
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match $ruleLine) {
      if ($hasNew) { continue }           # already listed under its new name: the old line just goes
      $line = $line -replace '\.claudeweb', $New
      $hasNew = $true                     # a second old line would only repeat it
    }
    $out.Add($line)
  }
  $changedIgnores += $file
  if ($Apply) {
    $body = (New-Object Text.UTF8Encoding $false).GetBytes(($out -join $nl))
    if ($bom) { $body = [byte[]]((0xEF, 0xBB, 0xBF) + $body) }
    [IO.File]::WriteAllBytes($file, $body)
  }
}

Say ""
if ($changedIgnores.Count) {
  Say "Ignore rules $(if ($Apply) { 'changed' } else { 'to change' }) ($New/ in place of $Old/):" Cyan
  $changedIgnores | ForEach-Object { Say "  $_" }
  if ($Apply) { Say "These are changes in the repos: commit them where you want them kept." Yellow }
}
if ($heldIgnores.Count) {
  Say "Left as they are, since a folder they cover still has a $Old\ (run again once it is gone):" Yellow
  $heldIgnores | ForEach-Object { Say "  $_" }
}
if ($failed) { Say "$failed folder(s) could not be finished; run the script again once nothing holds them open." Red }
Say $(if ($Apply) { "Done." } else { "Dry run done. Run again with -Apply to make these changes." }) Green
