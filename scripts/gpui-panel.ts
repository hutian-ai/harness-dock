import { execFileSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export async function buildGpuiPanel(binary: string, resources: string): Promise<void> {
  const localCargo = join(homedir(), '.cargo/bin/cargo');
  const cargo = process.env.CARGO ?? await access(localCargo).then(() => localCargo, () => 'cargo');
  const manifest = resolve('apps/gpui-panel/Cargo.toml');
  const target = resolve(process.env.CARGO_TARGET_DIR ?? '.local/gpui-build');
  const env = { ...process.env, CARGO_TARGET_DIR: target, MACOSX_DEPLOYMENT_TARGET: '15.0' };
  execFileSync(cargo, ['build', '--locked', '--release', '--manifest-path', manifest], { env, stdio: 'inherit' });
  await copyFile(join(target, 'release/harness-dock-panel'), binary);
  await cp(resolve('apps/gpui-panel/Resources'), join(resources, 'harness-artwork'), { recursive: true });
  const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin', '--manifest-path', manifest], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as {
    packages: { id: string; name: string; version: string; license: string | null; manifest_path: string; license_file: string | null }[];
    resolve: { root: string; nodes: { id: string; dependencies: string[] }[] };
  };
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node.dependencies]));
  const used = new Set<string>();
  function visit(id: string): void { if (used.has(id)) return; used.add(id); for (const dep of nodes.get(id) ?? []) visit(dep); }
  visit(metadata.resolve.root);
  const notices = join(resources, 'rust-licenses');
  await mkdir(notices);
  const supplementRoot = resolve('third-party/rust-notices');
  const supplements = JSON.parse(await readFile(join(supplementRoot, 'sources.json'), 'utf8')) as {
    name: string; version: string; notices: { path: string; url: string; sha256: string }[];
  }[];
  const inventory: { name: string; version: string; license: string | null; source: string; notices: string[] }[] = [];
  for (const pkg of metadata.packages.filter(pkg => used.has(pkg.id) && pkg.id !== metadata.resolve.root).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = dirname(pkg.manifest_path), destination = join(notices, `${pkg.name}-${pkg.version}`);
    await mkdir(destination);
    const files = (await readdir(root)).filter(name => /^(licen[cs]e|copying|notice)([._-]|$)/iu.test(name));
    if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
    const copied: string[] = [];
    for (const name of files) {
      // Cargo's published package is the source of these notices. Paths never appear in the distributed inventory.
      try {
        const data = await readFile(join(root, name));
        const leaf = name.replaceAll(/[\\/]/gu, '_');
        await writeFile(join(destination, leaf), data);
        copied.push(leaf);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error; }
    }
    if (!copied.length) {
      const supplement = supplements.find(entry => entry.name === pkg.name && entry.version === pkg.version);
      if (!supplement?.notices.length) throw new Error(`rust_license_notice_missing:${pkg.name}@${pkg.version}`);
      for (const notice of supplement.notices) {
        if (!/^[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+$/u.test(notice.path)) throw new Error('invalid_rust_notice_path');
        const data = await readFile(join(supplementRoot, notice.path));
        if (createHash('sha256').update(data).digest('hex') !== notice.sha256) throw new Error('rust_notice_integrity_mismatch');
        const leaf = notice.path.split('/').at(-1)!;
        await writeFile(join(destination, leaf), data);
        copied.push(leaf);
      }
      await writeFile(join(destination, 'SOURCES.json'), `${JSON.stringify(supplement.notices, null, 2)}\n`);
      copied.push('SOURCES.json');
    }
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license,
      source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`, notices: copied });
  }
  await writeFile(join(notices, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
}
