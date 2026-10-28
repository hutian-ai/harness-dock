import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { prepareCodexEnvironment } from "../packages/drivers/src/codex-host.ts";
import { discoverProviders } from "../packages/drivers/src/discovery.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
  );
});

test("native preparation preserves configuration, authentication and skill directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-codex-home-"));
  temporaryPaths.push(directory);
  const codexHome = join(directory, "native"), skillDirectory = join(directory, "authorized");
  await mkdir(codexHome); await mkdir(skillDirectory);
  const config = '[features]\nmemories = true\nplugins = true\n';
  await writeFile(join(codexHome, 'config.toml'), config);
  await writeFile(join(codexHome, 'auth.json'), 'native-auth');
  await writeFile(join(skillDirectory, 'SKILL.md'), 'authorized skill');
  const before = await readdir(codexHome);
  const environment = { cwd: directory, codexHome, stateDir: join(directory, 'state'), skillDirectory };
  await prepareCodexEnvironment(environment);
  await prepareCodexEnvironment(environment);
  assert.equal(await readFile(join(codexHome, 'config.toml'), 'utf8'), config);
  assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), 'native-auth');
  assert.deepEqual(await readdir(codexHome), before);
});

test("native preparation supports keychain credentials without an auth.json copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-codex-home-provisioned-"));
  temporaryPaths.push(directory);
  const codexHome = join(directory, "runtime-home");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await prepareCodexEnvironment({ cwd: directory, codexHome, stateDir: join(directory, 'state') });
  assert.deepEqual(await readdir(codexHome), []);
});

test("dock state cannot be placed inside the native Codex home", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dock-shared-codex-home-"));
  temporaryPaths.push(directory);

  await assert.rejects(
    prepareCodexEnvironment({ cwd: directory, codexHome: directory, stateDir: join(directory, 'execution') }),
    /codex_state_must_be_separate/u,
  );
});

test("Codex discovery honors the local installation and never substitutes a bundled version", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dock-native-discovery-'));
  temporaryPaths.push(directory);
  const executable = join(directory, 'codex');
  await writeFile(executable, '#!/bin/sh\nprintf "codex-cli native-test\\n"\n');
  await chmod(executable, 0o700);
  const options = { homeDirectory: directory, environment: { PATH: directory },
    overrides: { lobi: { disabled: true }, 'deepseek-harness': { disabled: true } } };
  const [found] = await discoverProviders(options);
  assert.equal(found?.executable, await realpath(executable));
  assert.equal(found?.source, 'path');
  assert.equal(found?.version, 'native-test');
  const [missing] = await discoverProviders({ ...options, overrides: { ...options.overrides,
    codex: { executable: join(directory, 'missing') } } });
  assert.equal(missing?.status, 'not_found');
  assert.equal(missing?.executable, null);
});

test('native desktop host validates its local socket and keeps task identities out of the environment', async () => {
  const { createServer } = await import('node:net');
  const { createCodexRuntime } = await import('../packages/drivers/src/codex.ts');
  const directory = await mkdtemp(join(tmpdir(), 'dock-desktop-host-'));temporaryPaths.push(directory);
  const home = join(directory,'home');await mkdir(home);
  const pipePath=join(directory,'host.sock');const server=createServer();
  await new Promise<void>(resolve=>server.listen(pipePath,resolve));
  const environment={cwd:directory,codexHome:home,stateDir:join(directory,'state'),desktopHost:{pipePath,nodePath:process.execPath}};
  const previous = { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID, CODEX_INTERACTION_CLIENT_ID: process.env.CODEX_INTERACTION_CLIENT_ID };
  process.env.CODEX_THREAD_ID = 'another-chat'; process.env.CODEX_INTERACTION_CLIENT_ID = 'another-client';
  try{
    await prepareCodexEnvironment(environment);
    const fixture=join(directory,'agent.mjs');await writeFile(fixture,`import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;const result=q.method==='initialize'?{protocolVersion:1,agentCapabilities:{},authMethods:[]}:{pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH,node:process.env.CODEX_MCP_NODE_PATH,bootstrap:process.env.HARNESS_DOCK_CODEX_DESKTOP_HOST,threadId:process.env.CODEX_THREAD_ID??null,interactionClient:process.env.CODEX_INTERACTION_CLIENT_ID??null};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}`);
    const runtime=createCodexRuntime(environment,[process.execPath,fixture]);
    try{assert.deepEqual(await runtime.dockControl({command:{operation:'inspect'},signal:AbortSignal.timeout(5000)}),{pipe:pipePath,node:process.execPath,bootstrap:'1',threadId:null,interactionClient:null});}finally{await runtime.shutdown();}
    await assert.rejects(prepareCodexEnvironment({...environment,desktopHost:{pipePath:fixture,nodePath:process.execPath}}),/codex_desktop_host_pipe_unavailable/);
  }finally{
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('desktop discovery extracts only the application endpoint and home, rejecting ambiguous or unrelated pipes', async () => {
  const { codexHostFields, parseCodexProcesses } = await import('../packages/drivers/src/codex-environment.ts');
  const pipe='/tmp/codex-browser-use/12345678-1234-1234-1234-123456789012.sock';
  const fields=codexHostFields(`native app-server SECRET=must-not-leak CODEX_APP_TOOLS_PIPE_PATH=${pipe} CODEX_HOME=/Users/Some User/.codex NEXT=value`);
  assert.deepEqual(fields,{pipe,home:'/Users/Some User/.codex'});
  assert.equal(JSON.stringify(fields).includes('must-not-leak'),false);
  assert.equal(codexHostFields('app-server CODEX_APP_TOOLS_PIPE_PATH=/tmp/another-chat.sock').pipe,undefined);
  assert.throws(()=>codexHostFields(`CODEX_APP_TOOLS_PIPE_PATH=${pipe} CODEX_APP_TOOLS_PIPE_PATH=${pipe}`),/ambiguous/);
  assert.deepEqual(parseCodexProcesses(' 42 1 501 /Applications/Relocated Codex.app/Contents/MacOS/ChatGPT\ninvalid'),[{pid:42,parent:1,uid:501,executable:'/Applications/Relocated Codex.app/Contents/MacOS/ChatGPT'}]);
});
