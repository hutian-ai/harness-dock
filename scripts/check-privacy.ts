import { execFileSync, spawnSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const localDirectories = new Set(['.git', '.local', '.serena', 'node_modules', 'dist', 'coverage']);
const credentialNames = new Set(['auth.json', 'credentials.json', 'server.json', 'client.json', 'controller.json', 'device-pairing.json']);
const exampleUsers = new Set(['example', 'Some User']);

/** Report categories and locations only; never echo a matching private value. */
export function privacyIssues(path: string, content?: Buffer): string[] {
  const parts = path.split(/[\\/]/u), name = basename(path), issues: string[] = [];
  if (parts.some(part => localDirectories.has(part))) issues.push('local_or_generated_directory');
  if (credentialNames.has(name) || /^\.env(?:\.|$)/u.test(name) && name !== '.env.example'
    || /\.(?:pem|key|p12|pfx|sqlite(?:-.*)?|db(?:-.*)?|log)$/iu.test(name)) issues.push('private_runtime_file');
  if (!content || !isUtf8(content)) return issues;
  const text = content.toString('utf8');
  const homes = text.matchAll(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)([^/\\\r\n"'`<>:;,]+)(?=[/\\\r\n"'`<>:;,]|$)/gu);
  if ([...homes].some(match => !exampleUsers.has(match[1]!))) issues.push('personal_home_path');
  for (const match of text.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>]+/gu)) {
    let host: string;
    try { host = new URL(match[0]).hostname.replace(/^\[|\]$/gu, ''); } catch { continue; }
    if (!isIP(host)) continue;
    if (host === '::1' || host === '::' || /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/u.test(host)) continue;
    issues.push('literal_service_ip');
  }
  return [...new Set(issues)];
}

function secrets(args: string[]): void {
  const result = spawnSync('gitleaks', [...args, '--no-banner', '--no-color', '--redact=100', '--ignore-gitleaks-allow'], { stdio: 'inherit' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT')
    throw new Error('gitleaks_required: install Gitleaks before running check:privacy (macOS: brew install gitleaks)');
  if (result.error || result.status !== 0) throw new Error('secret_scan_failed');
}

async function main(): Promise<void> {
  process.umask(0o077);
  const root = await realpath(process.cwd());
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  const snapshot = await mkdtemp(join(root, '.local/privacy-check-'));
  const failures: string[] = [];
  let count = 0;
  try {
    for (const path of paths) {
      const file = join(root, path);
      const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      if (!info) continue; // A deleted tracked file has no worktree content to distribute.
      const actual = await realpath(file), outside = relative(root, actual);
      if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside) || !info.isFile() && !info.isSymbolicLink()) {
        failures.push(`${path}: source_path_not_confined`); continue;
      }
      const issues = [...new Set([
        ...privacyIssues(path, await readFile(file)),
        // A tracked symlink must not smuggle ignored runtime material into the snapshot.
        ...privacyIssues(outside),
      ])];
      failures.push(...issues.map(issue => `${path}: ${issue}`));
      if (issues.length) continue;
      const target = join(snapshot, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target); count++;
    }
    if (failures.length) throw new Error(`privacy_check_failed\n${failures.join('\n')}`);
    // The snapshot includes working changes and untracked source; ignored runtime data is never copied.
    secrets(['dir', snapshot]);
    secrets(['git', root, '--log-opts=--all HEAD']);
    console.log(`PASS privacy: ${count} source files and locally reachable Git history. Private runtime files, home paths and literal service IPs checked; secret output redacted. Manual privacy review remains required.`);
  } finally { await rm(snapshot, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : 'privacy_check_failed'); process.exitCode = 1; });
}
