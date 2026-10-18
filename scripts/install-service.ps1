<#
.SYNOPSIS
  Installs Hangar as a Windows service running under a user account.
  Run this from an elevated (Administrator) PowerShell prompt.

.DESCRIPTION
  Claude Code stores its auth/config in the user profile, so the service must run as a
  real user (not LocalSystem). This script grants that account the "Log on as a service"
  right, then registers and starts the service.

.EXAMPLE
  pwsh -File scripts\install-service.ps1 -PublishPath .\publish
#>
param(
  [string]$ServiceName = "Hangar",
  [string]$PublishPath = "$PSScriptRoot\..\publish",
  [string]$UserName = "$env:USERDOMAIN\$env:USERNAME",
  [string]$DisplayName = "Hangar"
)
$ErrorActionPreference = "Stop"

# --- must be elevated ---
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Please run this script from an elevated (Administrator) PowerShell." }

$exe = Join-Path (Resolve-Path $PublishPath) "Hangar.exe"
if (-not (Test-Path $exe)) { throw "Not found: $exe. Run scripts\build.ps1 first." }

Write-Host "Service account: $UserName"
$cred = Get-Credential -UserName $UserName -Message "Enter the Windows password for $UserName"
$password = $cred.GetNetworkCredential().Password

# --- grant SeServiceLogonRight to the account (via secedit) ---
function Grant-ServiceLogonRight([string]$account) {
  $sid = (New-Object System.Security.Principal.NTAccount($account)
    ).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $tmp = Join-Path $env:TEMP "claudeweb-secpol"
  $inf = "$tmp.inf"; $db = "$tmp.sdb"
  secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
  $content = Get-Content $inf
  $line = $content | Where-Object { $_ -match "^SeServiceLogonRight" }
  if ($line) {
    if ($line -notmatch [regex]::Escape($sid)) {
      $content = $content -replace "^SeServiceLogonRight.*", "$line,*$sid"
    } else {
      Write-Host "Account already has 'Log on as a service'."; return
    }
  } else {
    $content += "SeServiceLogonRight = *$sid"
  }
  $content | Set-Content $inf
  secedit /configure /db $db /cfg $inf /areas USER_RIGHTS | Out-Null
  Remove-Item $inf, $db -ErrorAction SilentlyContinue
  Write-Host "Granted 'Log on as a service' to $account."
}
Grant-ServiceLogonRight $UserName

# --- (re)create the service ---
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing service '$ServiceName'..."
  sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 1
}

Write-Host "Creating service '$ServiceName'..."
# binPath quoting matters; note the required spaces after '='.
sc.exe create $ServiceName binPath= "`"$exe`"" start= auto obj= "$UserName" password= "$password" DisplayName= "$DisplayName" | Out-Null
sc.exe description $ServiceName "Web UI for launching Claude Code CLI sessions." | Out-Null
# Restart automatically on failure.
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

Write-Host "Starting service..."
sc.exe start $ServiceName | Out-Null

Write-Host ""
Write-Host "Installed. Hangar is running as a Windows service under $UserName." -ForegroundColor Green
Write-Host "Edit the port/password in: $PublishPath\appsettings.json (then restart the service)."
