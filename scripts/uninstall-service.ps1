<#
.SYNOPSIS
  Stops and removes the Claude Web Windows service. Run elevated.
#>
param([string]$ServiceName = "ClaudeWeb")
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Please run this script from an elevated (Administrator) PowerShell." }

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $ServiceName | Out-Null
  Write-Host "Removed service '$ServiceName'." -ForegroundColor Green
} else {
  Write-Host "Service '$ServiceName' is not installed."
}
