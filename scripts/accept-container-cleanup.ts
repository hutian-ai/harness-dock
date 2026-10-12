import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ContainerHarness, type ContainerConfig } from '../packages/drivers/src/container.ts';
const config = JSON.parse(await readFile(process.argv[2] ?? '.local/container.json', 'utf8')) as ContainerConfig;
const directory = resolve('.local/container-cleanup', randomUUID());
for (const name of ['work', 'home', 'state']) await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
const nodeId = randomUUID();
const harness = new ContainerHarness(config, nodeId, join(directory, 'work'), join(directory, 'home'), join(directory, 'state'));
const exe = config.executable ?? config.engine;
const cli = (...args: string[]) => execFileSync(exe, args, { encoding: 'utf8', timeout: 20_000 }).trim();
const moved = `${harness.name}-old`;
const unrelated = `harness-dock-unrelated-${randomUUID()}`;
try {
  // Independent CLI exits while its detached container remains: an orphan node resource.
  cli(...harness.command.slice(1, -1), '--detach', '--entrypoint', 'sleep', config.image, '120');
  const outside = join(directory, 'unmounted.txt');
  const marker = join(directory, 'work/marker.txt');
  await writeFile(outside, 'HOST_ONLY');
  const boundary = cli('exec', harness.name, 'sh', '-c',
    'printf WORK > "$1" && test ! -e "$2" && ! touch "$2" && ! touch /root-write-test && test ! -e /var/run/docker.sock && test ! -e /run/podman/podman.sock && cat /proc/self/status',
    'boundary', marker, outside);
  assert.equal(await readFile(marker, 'utf8'), 'WORK');
  assert.equal(await readFile(outside, 'utf8'), 'HOST_ONLY');
  assert.match(boundary, /CapEff:\s+0000000000000000/);
  assert.match(boundary, /NoNewPrivs:\s+1/);
  const metadata = JSON.parse(cli('inspect', harness.name))[0];
  assert.equal(metadata.HostConfig.ReadonlyRootfs, true);
  assert.equal(metadata.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(metadata.HostConfig.PidsLimit, 256);
  assert.equal(metadata.HostConfig.NanoCpus, 2_000_000_000);
  assert.equal(metadata.Mounts.filter((m: { Type: string }) => m.Type === 'bind').length, 2);
  cli('run', '--rm', '--detach', '--name', unrelated, '--entrypoint', 'sleep', config.image, '120');
  await harness.cleanup();
  assert.ok(!cli('ps', '-a', '--format', '{{.Names}}').split('\n').includes(harness.name));
  assert.ok(cli('ps', '--format', '{{.Names}}').split('\n').includes(unrelated));
  cli('run', '--rm', '--detach', '--name', harness.name, '--label', 'harness-dock.owner=another-owner', '--entrypoint', 'sleep', config.image, '120');
  await assert.rejects(harness.cleanup(), /container_owner_mismatch/);
  assert.ok(cli('ps', '--format', '{{.Names}}').split('\n').includes(harness.name));
  cli('rm', '--force', harness.name);
  cli(...harness.command.slice(1, -1), '--detach', '--entrypoint', 'sleep', config.image, '120');
  const wrapper = join(directory, 'interleave.mjs');
  // Reproduce replacement after inspect and before rm using real containers.
  await writeFile(wrapper, `#!${process.execPath}
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2), exe=${JSON.stringify(exe)};
const run=(args)=>execFileSync(exe,args,{encoding:'utf8',timeout:20000});
const output=run(args);
if(args[0]==='inspect') {
  run(['rename',${JSON.stringify(harness.name)},${JSON.stringify(moved)}]);
  run(['run','--rm','--detach','--name',${JSON.stringify(harness.name)},'--label','harness-dock.owner=another-owner','--entrypoint','sleep',${JSON.stringify(config.image)},'120']);
}
process.stdout.write(output);
`, { mode: 0o700 });
  const interleaved = new ContainerHarness({ ...config, executable: wrapper }, nodeId,
    join(directory, 'work'), join(directory, 'home'), join(directory, 'state'));
  await interleaved.cleanup();
  const names = cli('ps', '--format', '{{.Names}}').split('\n');
  assert.ok(!names.includes(moved), 'The inspected container must be removed');
  assert.ok(names.includes(harness.name), 'The replacement container must remain');
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({ nodeId, image: config.image, orphanRemoved: true, unrelatedPreserved: true, wrongOwnerRefused: true, replacementPreserved: true, mountBoundary: true, readonlyRoot: true, noCapabilities: true, noNewPrivileges: true, resources: { cpus: 2, memoryGiB: 2, pids: 256 } }, null, 2));
  console.log(`PASS container ownership cleanup: ${directory}`);
} finally {
  for (const name of [harness.name, moved, unrelated]) { try { cli('rm', '--force', name); } catch { /* already removed */ } }
}
