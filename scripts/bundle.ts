import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeReleaseManifest } from '../apps/daemon/src/release-manifest.ts';
import { writeBundleNotices } from './bundle-notices.ts';

// An existing destination is rejected by pnpm; no recursive deletion of user files.
const root = resolve(process.argv[2] ?? '.local/bundle');
await mkdir(root, { recursive: true, mode: 0o700 });
for (const [name, target] of [['@harness-dock/daemon', 'daemon'], ['@harness-dock/client', 'controller'], ['@harness-dock/server', 'server']]) {
  execFileSync('pnpm', ['--filter', name!, 'deploy', '--prod', '--config.node-linker=hoisted', join(root, target!)], { stdio: 'inherit' });
}
// Workspace packages may be hard-linked by pnpm deploy. Detach them so later builds cannot mutate an installed release.
async function detach(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await detach(file);
    else if (entry.isFile() && (await lstat(file)).nlink > 1) {
      const copy = `${file}.dock-copy-${process.pid}`;
      await copyFile(file, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await rename(copy, file);
    }
  }
}
await detach(root);
for (const target of ['daemon', 'controller', 'server']) {
  const directory = join(root, target);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  // Ship installed dependencies, rather than deploy's references back to the source workspace.
  for (const name of Object.keys(manifest.dependencies)) {
    const dependency = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
    manifest.dependencies[name] = dependency.version;
  }
  manifest.bundledDependencies = Object.keys(manifest.dependencies);
  delete manifest.scripts;
  for (const bin of Object.values(manifest.bin) as string[]) await chmod(join(directory, bin), 0o755);
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.pnpm/lock.yaml'])
    await rm(join(directory, file));
  await rmdir(join(directory, 'node_modules/.pnpm'));
}
await mkdir(join(root, 'daemon/patches'));
for (const patch of ['acpx@0.21.1.patch', '@agentclientprotocol__codex-acp@2.3.0.patch'])
  await copyFile(resolve('patches', patch), join(root, 'daemon/patches', patch));
await copyFile(resolve('patches/README.md'), join(root, 'daemon/patches/README.md'));
for (const target of ['daemon', 'controller', 'server']) await writeBundleNotices(join(root, target));
await mkdir(join(root, 'controller/examples'));
await copyFile(resolve('examples/node-client.mjs'), join(root, 'controller/examples/node-client.mjs'));
await copyFile(resolve('deploy/server.Dockerfile'), join(root, 'server/Dockerfile'));
await copyFile(resolve('deploy/compose.yaml'), join(root, 'server/compose.yaml'));
const [archive] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: join(root, 'controller'), encoding: 'utf8' }));
await rename(join(root, archive.filename), join(root, 'controller.tgz'));
let revision: string | undefined;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) revision += '+dirty';
} catch { /* Source archives have no Git metadata. */ }
await writeReleaseManifest(join(root, 'daemon'), revision);
console.log(`Local bundles ready: ${root}. Use node <daemon>/dist/cli.js help or node <server>/dist/cli.js run <server.json>, or node <controller>/dist/cli.js help.`);
