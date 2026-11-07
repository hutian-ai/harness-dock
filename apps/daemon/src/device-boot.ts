import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Native boot identity, never wall-clock time or a saved process ID. Failure keeps recovery closed. */
export function deviceBootIdentity(): string | null {
  try {
    let value: string;
    if (process.platform === 'darwin') {
      value = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2_000 }).trim();
      if (!/^[a-f0-9-]{36}$/iu.test(value)) return null;
    } else if (process.platform === 'linux') {
      value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!/^[a-f0-9-]{36}$/iu.test(value)) return null;
    } else if (process.platform === 'win32') {
      const shell = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      value = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks'],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true }).trim();
      if (!/^\d{15,20}$/u.test(value)) return null;
    } else return null;
    return createHash('sha256').update(`${process.platform}:${value}`).digest('hex');
  } catch { return null; }
}
