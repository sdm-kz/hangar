<#
.SYNOPSIS
  Register (or remove) ClaudeWeb.exe in the CURRENT USER's autostart so it launches at login.
  Uses the per-user Run key (HKCU) — no admin rights required, affects only your account.

.PARAMETER ExePath
  Path to ClaudeWeb.exe. Defaults to .\publish\ClaudeWeb.exe next to the repo.

.PARAMETER Remove
  Remove the autostart entry instead of adding it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -ExePath "C:\Apps\ClaudeWeb\ClaudeWeb.exe"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -Remove
#>
param(
  [string]$ExePath = "$PSScriptRoot\..\publish\ClaudeWeb.exe",
  [string]$Name = "ClaudeWeb",
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

if ($Remove) {
  $existing = Get-ItemProperty -Path $runKey -Name $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-ItemProperty -Path $runKey -Name $Name
    Write-Host "Removed '$Name' from autostart." -ForegroundColor Green
  } else {
    Write-Host "'$Name' is not in autostart."
  }
  return
}

$resolved = Resolve-Path $ExePath -ErrorAction SilentlyContinue
if (-not $resolved -or -not (Test-Path $resolved.Path)) {
  throw "ClaudeWeb.exe not found at '$ExePath'. Build it first (scripts\build.ps1) or pass -ExePath <path>."
}
$full = $resolved.Path

# Value is the quoted exe path (quotes handle spaces in the path).
Set-ItemProperty -Path $runKey -Name $Name -Value ('"{0}"' -f $full)

Write-Host "Registered autostart for the current user:" -ForegroundColor Green
Write-Host "  $Name = `"$full`""
Write-Host "It will start automatically at your next sign-in (system tray)."
Write-Host "Start it now with:  & `"$full`""
