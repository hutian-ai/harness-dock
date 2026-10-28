import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, readlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRelease } from '../apps/daemon/src/release-manifest.ts';

const { values } = parseArgs({ options: { bundles: { type: 'string' }, output: { type: 'string' }, 'server-image': { type: 'string' } } });
if (!values.bundles || !values.output) throw new Error('Usage: package-release.ts --bundles <verified-bundle-directory> --output <new-directory> [--server-image <local-Linux-image-tag>]');
const source = resolve(values.bundles), output = resolve(values.output);
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('distribution_host_requires_macos_or_linux');
const { manifest } = await verifyRelease(join(source, 'daemon'));
if (!/^[a-zA-Z0-9.+-]+$/.test(manifest.version)) throw new Error('invalid_distribution_version');
const allowed = new Set(['dist', 'node_modules', 'package.json', 'dock-release.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.json', 'third-party', 'patches', 'examples', 'Dockerfile', 'compose.yaml']);
async function confined(root: string, path = root): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    if (isAbsolute(await readlink(path)) || !(await realpath(path)).startsWith(root + sep)) throw new Error('distribution_external_symlink');
  } else if (info.isDirectory()) {
    for (const name of await readdir(path)) await confined(root, join(path, name));
  } else if (!info.isFile()) throw new Error('distribution_special_file');
}
for (const target of ['daemon', 'controller', 'server']) {
  for (const entry of await readdir(join(source, target))) if (!allowed.has(entry)) throw new Error(`unexpected_bundle_root_entry:${target}/${entry}`);
  const metadata = JSON.parse(await readFile(join(source, target, 'package.json'), 'utf8'));
  if (metadata.version !== manifest.version || metadata.private !== true) throw new Error('distribution_version_or_privacy_mismatch');
  await confined(await realpath(join(source, target)));
}
if (values['server-image'] && process.platform !== 'linux') throw new Error('server_image_export_requires_linux_build_host');
await mkdir(output, { mode: 0o700 });
// Never distribute the build user's identity, macOS provenance or filesystem ACLs.
const tarMetadata = process.platform === 'darwin'
  ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root', '--no-xattrs', '--no-acls', '--no-fflags']
  : ['--owner=0', '--group=0', '--numeric-owner', '--no-xattrs', '--no-acls', '--no-selinux'];
for (const target of ['daemon', 'controller', 'server']) {
  const platform = target === 'daemon' ? `-${manifest.platform}-${manifest.arch}` : '';
  const name = `harness-dock-${target}-${manifest.version}${platform}.tar.gz`;
  execFileSync('tar', [...tarMetadata, '-czf', join(output, name), '-C', source, target], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
}
await copyFile(join(source, 'controller.tgz'), join(output, `harness-dock-sdk-${manifest.version}.tgz`));
let serverImage: { reference: string; id: string; platform: string; arch: string } | undefined;
if (values['server-image']) {
  // Export only a prebuilt LOCAL image. No login, build, push, service start or deployment occurs here.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(values['server-image'])) throw new Error('invalid_local_image_reference');
  const image = JSON.parse(execFileSync('docker', ['image', 'inspect', values['server-image']], { encoding: 'utf8' }))[0];
  if (image.Os !== 'linux' || !['amd64', 'arm64'].includes(image.Architecture) || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('server_image_requires_linux');
  serverImage = { reference: values['server-image'], id: image.Id, platform: image.Os, arch: image.Architecture };
  execFileSync('docker', ['image', 'save', '-o', join(output, `harness-dock-server-image-${manifest.version}-linux-${image.Architecture}.tar`), values['server-image']], { stdio: 'inherit' });
}
await writeFile(join(output, 'release.json'), JSON.stringify({ format: 1, version: manifest.version, revision: manifest.revision ?? null,
  candidateOnly: true, device: { platform: manifest.platform, arch: manifest.arch, protocol: manifest.protocol, stateFormat: manifest.stateFormat,
    supported: manifest.platform === 'darwin' && manifest.arch === 'arm64' },
  ...(serverImage ? { serverImage } : {}),
  runtime: 'Node.js >=22.19.0; native Codex installation/login required on the device',
}, null, 2) + '\n');
await writeFile(join(output, 'README.txt'), `Local/CI candidate artifacts; not a published release.\nVerify SHA256SUMS, release.json and source provenance before installation. Hashes detect corruption; they do not authenticate the publisher.\nDevice support: macOS arm64 + Codex only. Linux CI device archives are experimental, not supported releases.\nInstall Node.js 22.19+; runtime users do NOT need Git, pnpm or source builds. Codex remains separately installed/logged in.\nExtract server/controller/daemon archives into separate directories. The server archive contains Dockerfile for Linux builds.\nUse daemon/dist/cli.js setup --help, server/dist/cli.js --help, controller/dist/cli.js --help.\nNever run package managers in a sealed daemon release. Do not put pairing files/config/state into these archives.\n`);
let sums = '';
for (const name of (await readdir(output)).sort()) {
  const path = join(output, name);
  if (!(await lstat(path)).isFile()) throw new Error('unexpected_distribution_entry');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  sums += `${hash.digest('hex')}  ${name}\n`;
}
await writeFile(join(output, 'SHA256SUMS'), sums);
console.log(`Prepared local artifacts only: ${output}. No release, registry upload or service update was performed.`);
