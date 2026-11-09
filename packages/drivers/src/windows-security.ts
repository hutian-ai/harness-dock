import { join, toNamespacedPath } from 'node:path';
import { execa, ExecaError } from 'execa';

// Pass the request as data in the helper's environment, never as PowerShell
// source. This also works for background processes without console input.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('windows_security_phase:script')
$inputData = $env:HARNESS_DOCK_WINDOWS_SECURITY_REQUEST | ConvertFrom-Json
$env:HARNESS_DOCK_WINDOWS_SECURITY_REQUEST = $null
[Console]::Error.WriteLine('windows_security_phase:identity')
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
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
  [Console]::Error.WriteLine('windows_security_phase:path')
  $item = Get-Item -LiteralPath $inputData.path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'windows_private_path_is_link' }
  if ($inputData.operation -eq 'protect') {
    if (-not $item.PSIsContainer) { throw 'windows_private_directory_required' }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($allowedSid in @($sid.Value, 'S-1-5-18')) {
      $principal = New-Object System.Security.Principal.SecurityIdentifier($allowedSid)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($inputData.path, $acl)
  }
  # Use .NET directly: a daemon launched from PowerShell 7 can inherit a
  # PSModulePath that prevents Windows PowerShell from loading Get/Set-Acl.
  $actual = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($inputData.path) } else { [IO.File]::GetAccessControl($inputData.path) }
  $owner = $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $sid.Value) {
    # Elevated tokens may create child files with Administrators as owner.
    # That group is already trusted by the DACL check below. Require the
    # current token to hold the group, and still require its user SID's ACE.
    $currentPrincipal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if ($owner -ne 'S-1-5-32-544' -or -not $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'windows_private_path_owner_mismatch'
    }
  }
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
  const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
  const shell = join(systemRoot, 'System32/WindowsPowerShell/v1.0');
  try {
    await execa(join(shell, 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdin: 'ignore', cwd: systemRoot, env: {
        PSModulePath: join(shell, 'Modules'),
        HARNESS_DOCK_WINDOWS_SECURITY_REQUEST: JSON.stringify({ operation, path: operation === 'pipe' ? path : toNamespacedPath(path) }),
      }, timeout: 15_000, windowsHide: true, maxBuffer: 16_384 });
  } catch (error) {
    // Retain a category for startup logs, never raw PowerShell output.
    const stderr = error instanceof ExecaError && typeof error.stderr === 'string' ? error.stderr : '';
    const phase = [...stderr.matchAll(/^windows_security_phase:(script|identity|path)$/gmu)].at(-1)?.[1] ?? 'launch';
    const category = error instanceof ExecaError && error.timedOut ? `timeout_${phase}`
      : stderr.match(/\bwindows_(?:private_path_(?:is_link|owner_mismatch|permissions)|private_directory_required|pipe_acl_failed)\b/u)?.[0]
        ?? stderr.match(/FullyQualifiedErrorId\s*:\s*([\w.,+]{1,100})/u)?.[1] ?? 'unknown';
    throw new Error(`windows_${operation === 'pipe' ? 'pipe_acl' : 'private_path'}_unavailable`,
      { cause: new Error(`windows_security_detail:${operation}:${category}`) });
  }
}

/** Only call for a new Dock-owned directory, before writing identity or runtime state. */
export const protectWindowsDirectory = (path: string) => secure('protect', path);
export const assertWindowsPrivatePath = (path: string) => secure('assert', path);
/** Restrict IPC to the local owner and SYSTEM; network logons are explicitly denied. */
export const protectWindowsPipe = (path: string) => secure('pipe', path);
