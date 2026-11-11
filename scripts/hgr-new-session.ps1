<#
.SYNOPSIS
    Creates a Claude session through the external API (POST /api/external/sessions).

.DESCRIPTION
    Thin wrapper over the external session endpoint. Every request field is a parameter;
    only -WorkingDirectory has a value by default (the current directory). Fields that are
    not supplied are omitted from the body, so the server applies its own defaults.

    The API key and base URL come from the environment unless passed explicitly:
      HANGAR_API_KEY   the key from Auth:ApiKey (appsettings.Local.json or appsettings.json in the
                       install folder), when one is set; sent as the X-Api-Key header. Without one
                       the request goes without the header, and a server that wants a key answers 401.
      HANGAR_URL       base URL of the server (default http://127.0.0.1:5099). Inside a session
                       Hangar sets it to itself, so a session launches into the server it runs under.

    To call it by name from anywhere, add the repo's scripts folder to your PATH (or call it by its
    full path).

.EXAMPLE
    .\hgr-new-session.ps1
    Starts a session in the current folder with server defaults.

.EXAMPLE
    .\hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Name build -NameTimestamp `
        -Model opus -PermissionMode auto -InitialPrompt 'run the tests and fix any failures'

.EXAMPLE
    .\hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Continue -PassThru

.EXAMPLE
    .\hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Child -PermissionMode auto
    Starts a session nested under the one this script is running inside, and fails with something to
    read when there is no session to nest under.

.EXAMPLE
    .\hgr-new-session.ps1 -WorkingDirectory C:\Git\other -NestUnderSessionId 8f2c1b...
    Nested under a session named explicitly -- what to use when this is not running inside one.

.EXAMPLE
    $prompt = Get-Content .\task.md -Raw
    pwsh -File .\hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -InitialPrompt $prompt
    A multi-line prompt. Written inline instead, a here-string works too, but its closing '@ has to
    sit at column 0 -- which is why this example reads the text from a file. See the .agent.md notes.
#>
[CmdletBinding()]
param(
    # Folder the session runs in. Defaults to the current directory.
    [Parameter(Position = 0)]
    [string] $WorkingDirectory = (Get-Location).Path,

    # Session name. Omit to let the server name it.
    [string] $Name,

    # Append a -MMdd-HH:mm suffix to -Name (e.g. 'build' -> 'build-0709-14:03').
    [switch] $NameTimestamp,

    # 'opus' | 'sonnet' | 'haiku' or a full model id. Omit for the default model.
    [string] $Model,

    # Prompt (or slash command) sent as soon as the session starts. Multi-line is fine — pass a
    # single-quoted here-string (@'...'@). Run this script with pwsh, not Windows PowerShell 5.1:
    # 5.1 does not send the request body as UTF-8, which corrupts non-ASCII prompts.
    [string] $InitialPrompt,

    [ValidateSet('default', 'auto', 'acceptEdits', 'bypassPermissions')]
    [string] $PermissionMode,

    # Expose the session in the Claude Code app. On unless -RemoteControl:$false.
    [bool] $RemoteControl = $true,

    # Resume the folder's most recent conversation (claude --continue).
    [switch] $Continue,

    # Resume a specific conversation by id (claude --resume <id>); wins over -Continue.
    [string] $ResumeSessionId,

    # Session color, as set by /color.
    [string] $Color,

    # Put the new session under this one in the sessions list (its nestedUnderId). An arrangement of
    # the list and nothing more — the new session gets its own conversation, so this is not a fork.
    # It does take that session's place in the list, though: its virtual folder, and its project when
    # no project claims the folder this one runs in — a row is only drawn under something in its own
    # list — and its view: it opens on the chat or the terminal, whichever that session is on.
    [string] $NestUnderSessionId,

    # Nest under the session this script runs inside: -NestUnderSessionId filled in from
    # HANGAR_SESSION_ID, which Hangar sets in every session it launches. With no session to nest under
    # it stops rather than launching at the top level -- the one outcome nobody asked for. An explicit
    # -NestUnderSessionId wins.
    [switch] $Child,

    [string] $BaseUrl,

    # Sent as the X-Api-Key header.
    [string] $ApiKey,

    # Emit the created session object instead of printing a formatted list.
    [switch] $PassThru
)

$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) {
    # 127.0.0.1, not localhost: Windows tries localhost as ::1 first, and the server listens on IPv4.
    $BaseUrl = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
}
if (-not $ApiKey) { $ApiKey = $env:HANGAR_API_KEY }

if ($Child -and -not $NestUnderSessionId) {
    $NestUnderSessionId = $env:HANGAR_SESSION_ID
    if (-not $NestUnderSessionId) {
        Write-Error ("-Child, but no parent session. Run this from inside a Hangar session (it sets " +
            "`$env:HANGAR_SESSION_ID), or pass -NestUnderSessionId. Drop -Child for a top-level session.")
        exit 1
    }
}

if ($Name -and $NameTimestamp) {
    $Name = '{0}-{1}' -f $Name, (Get-Date -Format 'MMdd-HH:mm')
}

# Only send what was asked for; unset fields fall back to the server's defaults.
$payload = @{ workingDirectory = $WorkingDirectory }
if ($Name)             { $payload.name            = $Name }
if ($Model)            { $payload.model           = $Model }
if ($InitialPrompt)    { $payload.initialPrompt   = $InitialPrompt }
if ($PermissionMode)   { $payload.permissionMode  = $PermissionMode }
if ($ResumeSessionId)  { $payload.resumeSessionId = $ResumeSessionId }
if ($Color)            { $payload.color           = $Color }
if ($NestUnderSessionId) { $payload.nestedUnderId = $NestUnderSessionId }
if ($Continue)         { $payload.continue        = $true }
if ($PSBoundParameters.ContainsKey('RemoteControl')) { $payload.remoteControl = $RemoteControl }

$body = $payload | ConvertTo-Json -Depth 4
Write-Verbose "POST $BaseUrl/api/external/sessions`n$body"

# The key only when there is one: the server decides whether it needs it.
$headers = @{}
if ($ApiKey) { $headers['X-Api-Key'] = $ApiKey }

try {
    $resp = Invoke-RestMethod -Method Post `
        -Uri "$BaseUrl/api/external/sessions" `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body $body

    if ($PassThru) { return $resp }

    Write-Host "Session created:" -ForegroundColor Green
    $resp | Format-List
}
catch {
    Write-Host "Failed to create session: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
    if ($status -eq 401 -and -not $ApiKey) {
        Write-Host ("No API key was sent. Pass -ApiKey or set `$env:HANGAR_API_KEY to the server's " +
            "Auth:ApiKey.") -ForegroundColor Yellow
    }
    exit 1
}
