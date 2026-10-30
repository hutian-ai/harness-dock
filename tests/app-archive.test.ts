import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createAppArchive } from '../scripts/app-archive.ts';

// These ZIP extra-field formats carry Unix ownership, even when central-directory tools hide it.
const ownerFields = new Set([0x000d, 0x5855, 0x756e, 0x7855, 0x7875]);
function assertNoOwnerFields(bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 4 <= bytes.length, 'truncated ZIP extra field');
    const tag = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    assert.ok(!ownerFields.has(tag), `builder ownership in ZIP extra field ${tag.toString(16)}`);
    offset += 4 + size;
    assert.ok(offset <= bytes.length, 'invalid ZIP extra field length');
  }
}

test('application ZIP strips local/central ownership and preserves executable files and relative symlinks', { skip: process.platform === 'win32' }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(resolve('.local/app-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'Fixture App.app'), bin = join(app, 'Contents/MacOS');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'run'), body = '#!/bin/sh\nprintf portable-archive\n';
  await writeFile(executable, body); await chmod(executable, 0o755);
  await symlink('run', join(bin, 'current'));
  const archive = join(root, 'fixture.zip');
  createAppArchive(app, archive);
  const bytes = await readFile(archive), end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'missing ZIP end record');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  assert.ok(count >= 5);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    assertNoOwnerFields(bytes.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize));
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
    assertNoOwnerFields(bytes.subarray(local + 30 + localNameSize, local + 30 + localNameSize + localExtraSize));
    offset += 46 + nameSize + extraSize + commentSize;
  }
  const extracted = join(root, 'extracted');
  execFileSync('/usr/bin/unzip', ['-q', archive, '-d', extracted]);
  const installed = join(extracted, 'Fixture App.app/Contents/MacOS');
  assert.equal(await readFile(join(installed, 'run'), 'utf8'), body);
  assert.equal((await stat(join(installed, 'run'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(installed, 'current'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(installed, 'current')), 'run');
  assert.throws(() => createAppArchive(app, archive), /archive_destination_exists/);
  assert.deepEqual(await readFile(archive), bytes, 'existing archives must not be overwritten or appended');
  const linkedArchive = join(root, 'linked.zip');
  await symlink('missing.zip', linkedArchive);
  assert.throws(() => createAppArchive(app, linkedArchive), /archive_destination_exists/);
  assert.equal(await readlink(linkedArchive), 'missing.zip');
});
