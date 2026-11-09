import { join, toNamespacedPath } from 'node:path';
import { execa } from 'execa';

// Paths travel over stdin, never as PowerShell source or interpolated command arguments.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($inputData.operation -eq 'pipe') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DockPipeAcl {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "SetNamedSecurityInfoW")]
  public static extern uint Set(string name, int kind, uint information, IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
}
'@
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor("D:P(D;;GA;;;NU)(A;;GA;;;$($sid.Value))(A;;GA;;;SY)")
  $bytes = New-Object byte[] $descriptor.DiscretionaryAcl.BinaryLength
  $descriptor.DiscretionaryAcl.GetBinaryForm($bytes, 0)
  $result = [DockPipeAcl]::Set($inputData.path, 1, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $bytes, [IntPtr]::Zero)
  if ($result -ne 0) { throw 'windows_pipe_acl_failed' }
} else {
  $item = Get-Item -LiteralPath $inputData.path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'windows_private_path_is_link' }
  if ($inputData.operation -eq 'protect') {
    if (-not $item.PSIsContainer) { throw 'windows_private_directory_required' }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid.Value, 'S-1-5-18')) {
      $principal = New-Object System.Security.Principal.SecurityIdentifier($identity)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($inputData.path, $acl)
  }
  # Use .NET directly: a daemon launched from PowerShell 7 can inherit a
  # PSModulePath that prevents Windows PowerShell from loading Get/Set-Acl.
  $actual = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($inputData.path) } else { [IO.File]::GetAccessControl($inputData.path) }
  if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'windows_private_path_owner_mismatch' }
  $ownerAllowed = $false
  foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -eq $sid.Value) { $ownerAllowed = $true }
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      throw 'windows_private_path_permissions'
    }
  }
  # A NULL DACL grants everyone access and exposes no access rules. Never accept it.
  if (-not $ownerAllowed) { throw 'windows_private_path_permissions' }
}
`;

async function secure(operation: 'protect' | 'assert' | 'pipe', path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await execa(join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: JSON.stringify({ operation, path: operation === 'pipe' ? path : toNamespacedPath(path) }),
        cwd: process.env.SYSTEMROOT ?? 'C:\\Windows', timeout: 15_000, windowsHide: true, maxBuffer: 16_384 });
  } catch {
    // Do not expose raw PowerShell output, local paths or user SIDs in diagnostics.
    throw new Error(`windows_${operation === 'pipe' ? 'pipe_acl' : 'private_path'}_unavailable`);
  }
}

/** Only call for a new Dock-owned directory, before writing identity or runtime state. */
export const protectWindowsDirectory = (path: string) => secure('protect', path);
export const assertWindowsPrivatePath = (path: string) => secure('assert', path);
/** Restrict IPC to the local owner and SYSTEM; network logons are explicitly denied. */
export const protectWindowsPipe = (path: string) => secure('pipe', path);
