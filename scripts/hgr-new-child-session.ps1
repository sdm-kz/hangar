<#
.SYNOPSIS
    Creates a Claude session nested under another one in the Hangar sessions list.

.DESCRIPTION
    hgr-new-session.ps1 with the parent filled in, and every other parameter passed straight
    through to it. Run from inside a Hangar session with no -ParentSessionId, the parent is the
    session you are running in: Hangar puts its id in HANGAR_SESSION_ID when it launches one
    (and in CLAUDEWEB_SESSION_ID, all a session launched before the rename has).

    Nesting is an arrangement of the list and nothing more. The new session gets its own conversation
    and its own folder -- it is not a fork of the parent, shares no history with it, and can be moved
    out of it later (in the UI, or by POSTing a null parent to /api/sessions/<id>/parent).

    A row is only drawn under something in its own list, so the server puts the new session where the
    parent is: in the parent's virtual folder if it is filed in one, and -- when the new session runs
    in a folder no project claims -- in the parent's project, by linking that folder to it. A folder
    another project already claims keeps the project it has.

    Failing rather than guessing is the point of this wrapper: with no parent to nest under it stops,
    because a session that silently arrived at the top level is the one outcome nobody asked for. Use
    hgr-new-session.ps1 directly when a top-level session is what you want.

.EXAMPLE
    .\hgr-new-child-session.ps1 -PermissionMode auto -InitialPrompt 'run the tests'
    A child of the session this runs inside, in the current folder.

.EXAMPLE
    .\hgr-new-child-session.ps1 -ParentSessionId 8f2c1b... -WorkingDirectory C:\Git\other `
        -Name 'docs pass' -Model sonnet -PermissionMode auto -InitialPrompt '/docs'
    Under a session named explicitly -- what to use when this is not running inside one.

.EXAMPLE
    $child = .\hgr-new-child-session.ps1 -PermissionMode auto -PassThru
    $child.id
#>
[CmdletBinding()]
param(
    # Folder the session runs in. Defaults to the current directory, like hgr-new-session.ps1 --
    # a child session is a separate session, so it need not share the parent's folder.
    [Parameter(Position = 0)]
    [string] $WorkingDirectory = (Get-Location).Path,

    # The session to nest the new one under. Defaults to HANGAR_SESSION_ID, which Hangar sets
    # in every session it launches -- so from inside one, the parent is that one.
    [string] $ParentSessionId = $(if ($env:HANGAR_SESSION_ID) { $env:HANGAR_SESSION_ID } else { $env:CLAUDEWEB_SESSION_ID }),

    # Everything below is hgr-new-session.ps1's, passed through untouched. See its help.
    [string] $Name,
    [switch] $NameTimestamp,
    [string] $Model,
    [string] $InitialPrompt,
    [ValidateSet('default', 'auto', 'acceptEdits', 'bypassPermissions')]
    [string] $PermissionMode,
    [bool] $RemoteControl = $true,
    [switch] $Continue,
    [string] $ResumeSessionId,
    [string] $Color,
    [switch] $WatchdogEnabled,
    [string] $BaseUrl,
    [string] $ApiKey,
    [switch] $PassThru
)

$ErrorActionPreference = 'Stop'

if (-not $ParentSessionId) {
    Write-Error ("No parent session. Pass -ParentSessionId, or run this from inside a Hangar " +
        "session (it sets `$env:HANGAR_SESSION_ID). For a top-level session use hgr-new-session.ps1.")
    exit 1
}

# The sibling first: both scripts ship together, and finding the one next to this file beats
# whichever copy happens to be on PATH. The PATH lookup is the fallback for a relocated script.
$create = Join-Path $PSScriptRoot 'hgr-new-session.ps1'
if (-not (Test-Path $create)) {
    $create = (Get-Command 'hgr-new-session.ps1' -ErrorAction SilentlyContinue).Source
}
if (-not $create) {
    Write-Error "Can't find hgr-new-session.ps1 (looked next to this script and on PATH)."
    exit 1
}

# Pass on exactly what was asked for: anything the caller left out stays out, so hgr-new-session
# omits it from the request and the server applies its own default. -ParentSessionId is this script's
# own word for it and becomes the parameter that script knows.
$pass = @{}
foreach ($kv in $PSBoundParameters.GetEnumerator()) { $pass[$kv.Key] = $kv.Value }
$pass.Remove('ParentSessionId') | Out-Null
$pass.WorkingDirectory = $WorkingDirectory
$pass.NestUnderSessionId = $ParentSessionId

# Cleared first, and read back global: $LASTEXITCODE belongs to the session, and a script that
# returns without calling exit -- which is what hgr-new-session.ps1 does when it succeeds -- leaves
# whatever ran before it standing. Without the reset, launching a session from a shell where anything
# had failed would report that old failure as this one's.
$global:LASTEXITCODE = 0
& $create @pass
if ($global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE }
