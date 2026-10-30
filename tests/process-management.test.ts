import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { initializeDevice, readConfig } from '../apps/daemon/src/config.ts';
import { control } from '../apps/daemon/src/local-control.ts';

test('background command execution survives removal of the launching directory', { timeout: 20_000 }, async t => {
  await mkdir('.local', { recursive: true });
  const root = await realpath(await mkdtemp(resolve('.local/background-cwd-')));
  const launcher = join(root, 'temporary-launcher'), release = join(root, 'release');
  await mkdir(launcher); await mkdir(release);
  const { configPath } = await initializeDevice({ home: join(root, 'device'), cwd: root });
  const config = await readConfig(configPath);
  t.after(async () => { await control(config, 'stop'); await rm(root, { recursive: true, force: true }); });
  const entrypoint = join(release, 'daemon.mjs');
  // Exercise the actual authenticated background boundary with a fixed subprocess,
  // without discovering a native Harness or sending a model request.
  await writeFile(entrypoint, `
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {serveControl} from ${JSON.stringify(pathToFileURL(resolve('apps/daemon/dist/local-control.js')).href)};
import {DeviceSelfTest} from ${JSON.stringify(pathToFileURL(resolve('apps/daemon/dist/device-self-test.js')).href)};
import {runBoundedCommand} from ${JSON.stringify(pathToFileURL(resolve('packages/drivers/dist/process-command.js')).href)};
const config=JSON.parse(await readFile(process.argv[3],'utf8'));
const daemonId=randomUUID();
const test=new DeviceSelfTest(config.stateDir,daemonId,async()=>{
  const result=await runBoundedCommand(process.execPath,['-e',"process.stdout.write('synthetic-command-complete')"]);
  return {state:result.exitCode===0 && result.stdout==='synthetic-command-complete'?'passed':'failed'};
});
const status=()=>({nodeId:config.nodeId,daemonId,pid:process.pid,connected:false,endpoint:config.endpoint,
  entrypoint:fileURLToPath(import.meta.url),runtime:process.execPath,selfTest:test.status});
await serveControl(config,status,async()=>{},undefined,id=>test.start(id));
`);
  const startModule = pathToFileURL(resolve('apps/daemon/dist/process-management.js')).href;
  const configModule = pathToFileURL(resolve('apps/daemon/dist/config.js')).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
import {startBackground} from ${JSON.stringify(startModule)};
import {readConfig} from ${JSON.stringify(configModule)};
await startBackground(await readConfig(process.argv[1]),process.argv[1],process.argv[2]);
`, configPath, entrypoint], { cwd: launcher, timeout: 15_000 });
  const before = (await control(config, 'status'))!;
  assert.ok(before.daemonId);
  await rm(launcher, { recursive: true });
  const id = randomUUID();
  assert.equal((await control(config, 'self-test', { id }))?.selfTest?.id, id);
  let after = await control(config, 'status');
  for (let attempt = 0; attempt < 50 && after?.selfTest?.state === 'running'; attempt++) {
    await delay(20); after = await control(config, 'status');
  }
  assert.equal(after?.daemonId, before.daemonId);
  assert.equal(after?.selfTest?.state, 'passed');
});
