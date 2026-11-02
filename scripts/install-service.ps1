<#
.SYNOPSIS
  Installs Hangar as a Windows service running under a user account.
  Run this from an elevated (Administrator) PowerShell prompt.

.DESCRIPTION
  Claude Code stores its auth/config in the user profile, so the service must run as a
  real user (not LocalSystem). This script grants that account the "Log on as a service"
  right, then registers and starts the service.

  Starting at sign-in (scripts\register-autostart.ps1) is the recommended way to run Hangar; the
  service is for a daemon that has to keep running while nobody is signed in.

  The service runs Hangar.exe from the install folder (scripts\deploy.ps1 puts it there and, once the
  service exists, stops and starts it around each deploy). The password is handed to Windows as a
  credential object (New-Service -Credential), never on a command line where other processes could
  read it.

  The account: the default is the one running this script, as Windows names it (COMPUTER\name or
  DOMAIN\name) -- which is also right for a Microsoft account, whose local name is the short one
  Windows made for it (the profile folder's name), not the e-mail address. For a Microsoft account,
  type the Microsoft account's PASSWORD at the prompt, not the Windows Hello PIN; an account set to
  sign in without a password (Settings > Accounts > Sign-in options) has to have that turned off
  first. Work or school (Entra ID / Azure AD) accounts can't run services this way; use a local or
  domain account.

.PARAMETER InstallPath
  The install folder holding Hangar.exe: $env:HANGAR_INSTALL_DIR, else %LocalAppData%\Programs\Hangar,
  by default (see scripts\_paths.ps1). Run scripts\deploy.ps1 first to put a build there.
  Required when the service account is not the account this elevated prompt runs as (an
  administrator signing in over your shoulder, say): the default would be worked out from THAT
  account's profile, not the service account's.

.PARAMETER UserName
  The account to run the service as. Defaults to the current one. A bare name ("bob") means a local
  account of this computer (COMPUTER\bob), as does ".\bob".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -InstallPath D:\apps\hangar -UserName .\builder
#>
param(
  [string]$ServiceName = "Hangar",
  [Alias("PublishPath")][string]$InstallPath,
  [string]$UserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [string]$DisplayName = "Hangar"
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "_paths.ps1")
# The default comes from the profile this elevated prompt runs under (its %LocalAppData% and
# HANGAR_INSTALL_DIR), which is the service account's only when the same account elevated. Checked
# against the service account once that is known, below.
$installPathGiven = [bool]$InstallPath
if (-not $InstallPath) { $InstallPath = Get-HangarInstallDir }

# An account name as the service manager takes it: a bare "bob" or ".\bob" is a local account, and
# NTAccount and New-Service both want it as COMPUTER\bob. DOMAIN\name and name@domain pass through.
function Resolve-ServiceAccount([string]$name) {
  if ($name.StartsWith(".\")) { return "$env:COMPUTERNAME\" + $name.Substring(2) }
  if ($name -notmatch '[\\@]') { return "$env:COMPUTERNAME\$name" }
  return $name
}
function Get-AccountSid([string]$name) {
  try {
    return (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    throw "No such account: '$name'."
  }
}

# --- must be elevated ---
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Please run this script from an elevated (Administrator) PowerShell." }

$exe = Join-Path $InstallPath "Hangar.exe"
if (-not (Test-Path $exe)) { throw "Not found: $exe. Install it first (scripts\deploy.ps1) or pass -InstallPath." }
$exe = (Resolve-Path $exe).Path

$UserName = Resolve-ServiceAccount $UserName
Write-Host "Service account: $UserName"
$cred = Get-Credential -UserName $UserName -Message "Enter the Windows password for $UserName (for a Microsoft account: its password, not the PIN)"
if (-not $cred) { throw "No credential entered." }
# The account as typed at the prompt, which may differ from the default offered -- and the credential
# rebuilt around its full form, which is what New-Service has to be given.
$UserName = Resolve-ServiceAccount $cred.UserName
$cred = New-Object System.Management.Automation.PSCredential($UserName, $cred.Password)
$serviceSid = Get-AccountSid $UserName

# A service account other than the one running this prompt: the default install folder was worked out
# from the wrong profile.
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($serviceSid -ne $currentSid) {
  if (-not $installPathGiven) {
    throw ("The service account ($UserName) is not the account running this prompt " +
      "($([Security.Principal.WindowsIdentity]::GetCurrent().Name)), so the default install folder " +
      "('$InstallPath') is that account's, not the service account's. Pass -InstallPath explicitly.")
  }
  Write-Warning "The service runs as $UserName, not as the account running this prompt; make sure it can read '$InstallPath'."
}

# --- grant SeServiceLogonRight to the account ---
# Through the LSA, one right to one account. Not secedit: /configure re-applies the whole user-rights
# section from the exported template, and that template names some accounts by their localized name
# (on a Russian Windows, Cyrillic ones) -- a round trip through it can drop those accounts' rights.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HangarLsa {
  [StructLayout(LayoutKind.Sequential)]
  struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct LSA_OBJECT_ATTRIBUTES {
    public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService;
  }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attrs, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LSA_UNICODE_STRING[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaEnumerateAccountRights(IntPtr policy, byte[] sid, out IntPtr rights, out uint count);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr buffer);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const uint POLICY_CREATE_ACCOUNT = 0x10, POLICY_LOOKUP_NAMES = 0x800;
  const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;

  static IntPtr Open() {
    var attrs = new LSA_OBJECT_ATTRIBUTES();
    attrs.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
    IntPtr policy;
    Check(LsaOpenPolicy(IntPtr.Zero, ref attrs, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out policy), "LsaOpenPolicy");
    return policy;
  }
  static void Check(uint status, string what) {
    if (status != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status), what + " failed");
  }

  public static bool Has(byte[] sid, string right) {
    IntPtr policy = Open();
    try {
      IntPtr buffer; uint count;
      uint status = LsaEnumerateAccountRights(policy, sid, out buffer, out count);
      if (status == STATUS_OBJECT_NAME_NOT_FOUND) return false; // no rights at all
      Check(status, "LsaEnumerateAccountRights");
      try {
        int size = Marshal.SizeOf(typeof(LSA_UNICODE_STRING));
        for (int i = 0; i < count; i++) {
          var s = (LSA_UNICODE_STRING)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + i * size), typeof(LSA_UNICODE_STRING));
          if (Marshal.PtrToStringUni(s.Buffer, s.Length / 2) == right) return true;
        }
        return false;
      } finally { LsaFreeMemory(buffer); }
    } finally { LsaClose(policy); }
  }

  public static void Add(byte[] sid, string right) {
    IntPtr policy = Open();
    var s = new LSA_UNICODE_STRING();
    s.Buffer = Marshal.StringToHGlobalUni(right);
    s.Length = (ushort)(right.Length * 2);
    s.MaximumLength = (ushort)(s.Length + 2);
    try { Check(LsaAddAccountRights(policy, sid, new[] { s }, 1), "LsaAddAccountRights"); }
    finally { Marshal.FreeHGlobal(s.Buffer); LsaClose(policy); }
  }
}
"@
function Grant-ServiceLogonRight([string]$account) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier (Get-AccountSid $account)
  $bytes = New-Object byte[] $sid.BinaryLength
  $sid.GetBinaryForm($bytes, 0)
  if ([HangarLsa]::Has($bytes, "SeServiceLogonRight")) { Write-Host "Account already has 'Log on as a service'."; return }
  [HangarLsa]::Add($bytes, "SeServiceLogonRight")
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
# The exe path quoted inside the binary path, so a folder with spaces in it isn't read as arguments.
New-Service -Name $ServiceName -BinaryPathName "`"$exe`"" -DisplayName $DisplayName `
  -Description "Web UI for launching Claude Code CLI sessions." `
  -StartupType Automatic -Credential $cred | Out-Null
# Restart automatically on failure. (No secret in this one, so sc.exe is fine.)
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

Write-Host "Starting service..."
Start-Service -Name $ServiceName

Write-Host ""
Write-Host "Installed. Hangar is running as a Windows service under $UserName." -ForegroundColor Green
Write-Host "Settings: $InstallPath\appsettings.json, overridden by appsettings.Local.json beside it (restart the service after editing)."
