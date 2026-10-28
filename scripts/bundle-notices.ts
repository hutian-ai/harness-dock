import { cp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

interface PackageNotice {
  name: string;
  version: string;
  license: string;
  location: string;
  notices: string[];
}

// Index files actually shipped by deploy, without a second dependency resolver.
export async function writeBundleNotices(directory: string): Promise<void> {
  const root = await realpath(directory);
  const notices: PackageNotice[] = [];
  const local = async (path: string): Promise<string> => {
    const actual = await realpath(path);
    if (!actual.startsWith(root + sep)) throw new Error('License file escapes bundle');
    return relative(root, path).split(sep).join('/');
  };
  const inspect = async (path: string): Promise<void> => {
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
    if (!manifest.name || !manifest.version || !license) throw new Error(`Missing license metadata: ${relative(root, path)}`);
    const files = (await readdir(path)).sort();
    const texts = files.filter(file => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/i.test(file));
    if (!texts.length) {
      for (const file of files.filter(file => /^readme(?:\.|$)/i.test(file))) {
        const text = await readFile(join(path, file), 'utf8');
        if (license === 'MIT' && /Permission is hereby granted[\s\S]*THE SOFTWARE IS PROVIDED/i.test(text)) texts.push(file);
      }
    }
    const sources = texts.map(file => join(path, file));
    const parentName = manifest.name.startsWith('@esbuild/') ? 'esbuild'
      : manifest.name.startsWith('@openclaw/fs-safe-') ? '@openclaw/fs-safe' : undefined;
    if (parentName) {
      const parent = join(root, 'node_modules', parentName);
      const metadata = JSON.parse(await readFile(join(parent, 'package.json'), 'utf8'));
      if (metadata.version !== manifest.version) throw new Error(`Native license version mismatch: ${manifest.name}`);
      sources.push(join(parent, parentName === 'esbuild' ? 'LICENSE.md' : 'LICENSE'));
    }
    if (manifest.name === '@openai/codex') {
      const supplement = join(root, 'third-party/openai-codex');
      const metadata = JSON.parse(await readFile(join(supplement, 'SOURCES.json'), 'utf8'));
      if (manifest.version !== metadata.version && !manifest.version.startsWith(metadata.version + '-'))
        throw new Error('Review the Codex license supplement after a version change');
      for (const [file, data] of Object.entries(metadata.files) as [string, { sha256: string }][]) {
        const digest = createHash('sha256').update(await readFile(join(supplement, file))).digest('hex');
        if (digest !== data.sha256) throw new Error(`Codex license supplement hash mismatch: ${file}`);
      }
      sources.push(...Object.keys(metadata.files).map(file => join(supplement, file)));
    }
    if (!sources.length) throw new Error(`No distributed license text: ${manifest.name}`);
    notices.push({ name: manifest.name, version: manifest.version, license, location: await local(path),
      notices: await Promise.all(sources.map(local)) });
    await visitModules(join(path, 'node_modules'));
  };
  const visitModules = async (path: string): Promise<void> => {
    let entries: string[];
    try { entries = (await readdir(path)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of entries.filter(name => !name.startsWith('.'))) {
      const child = join(path, name);
      if (name.startsWith('@')) {
        for (const scoped of (await readdir(child)).sort()) await inspect(join(child, scoped));
      } else await inspect(child);
    }
  };
  await cp(resolve('THIRD_PARTY_NOTICES.md'), join(root, 'THIRD_PARTY_NOTICES.md'));
  if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name === '@harness-dock/daemon')
    await cp(resolve('third-party/openai-codex'), join(root, 'third-party/openai-codex'), { recursive: true });
  await visitModules(join(root, 'node_modules'));
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2) + '\n');
}
