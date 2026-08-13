<#
.SYNOPSIS
    Creates a Claude session through the external API (POST /api/external/sessions).

.DESCRIPTION
    Thin wrapper over the external session endpoint. Every request field is a parameter;
    only -WorkingDirectory has a value by default (the current directory). Fields that are
    not supplied are omitted from the body, so the server applies its own defaults.

    The API key and base URL come from the environment unless passed explicitly:
      CLAUDE_WEB_API_KEY   key matching Auth:ApiKey in server/appsettings.json
      CLAUDE_WEB_URL       base URL of the server (default http://localhost:5099)

.EXAMPLE
    .\new-claude-session.ps1
    Starts a session in the current folder with server defaults.

.EXAMPLE
    .\new-claude-session.ps1 -WorkingDirectory C:\Git\myproject -Name build -NameTimestamp `
        -Model opus -PermissionMode auto -InitialPrompt 'run the tests and fix any failures'

.EXAMPLE
    .\new-claude-session.ps1 -WorkingDirectory C:\Git\myproject -Continue -PassThru
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

    # Prompt (or slash command) sent as soon as the session starts.
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

    # Let the hang watchdog auto-continue this session.
    [switch] $WatchdogEnabled,

    [string] $BaseUrl,

    # Sent as the X-Api-Key header.
    [string] $ApiKey,

    # Emit the created session object instead of printing a formatted list.
    [switch] $PassThru
)

$ErrorActionPreference = 'Stop'

if (-not $BaseUrl) {
    $BaseUrl = if ($env:CLAUDE_WEB_URL) { $env:CLAUDE_WEB_URL } else { 'http://localhost:5099' }
}
if (-not $ApiKey) { $ApiKey = $env:CLAUDE_WEB_API_KEY }
if (-not $ApiKey) {
    Write-Error "No API key. Pass -ApiKey or set `$env:CLAUDE_WEB_API_KEY (must match Auth:ApiKey in appsettings.json)."
    exit 1
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
if ($Continue)         { $payload.continue        = $true }
if ($WatchdogEnabled)  { $payload.watchdogEnabled = $true }
if ($PSBoundParameters.ContainsKey('RemoteControl')) { $payload.remoteControl = $RemoteControl }

$body = $payload | ConvertTo-Json -Depth 4
Write-Verbose "POST $BaseUrl/api/external/sessions`n$body"

try {
    $resp = Invoke-RestMethod -Method Post `
        -Uri "$BaseUrl/api/external/sessions" `
        -Headers @{ 'X-Api-Key' = $ApiKey } `
        -ContentType 'application/json' `
        -Body $body

    if ($PassThru) { return $resp }

    Write-Host "Session created:" -ForegroundColor Green
    $resp | Format-List
}
catch {
    Write-Host "Failed to create session: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    exit 1
}
