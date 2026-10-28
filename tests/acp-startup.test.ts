import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcpRuntime, createAgentRegistry } from 'acpx/runtime';

test('ACPX bounds a stalled session request and never falls back or dispatches a prompt', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-session-deadline-'));
  const fixture = join(root, 'peer.mjs'), log = join(root, 'methods.jsonl');
  await writeFile(fixture, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
 const q=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(q.method)+'\\n');
 if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}})+'\\n');
}`);
  const observed: string[] = [];
  const runtime = createAcpRuntime({ cwd: root,
    onAcpMessage: (direction, message) => { if (direction === 'outbound' && 'method' in message) observed.push(message.method); },
    agentRegistry: createAgentRegistry({ overrides: { fixture: [process.execPath, fixture] } }),
    sessionStore: { load: async () => undefined, save: async () => assert.fail('a stalled session cannot be saved') },
    permissionMode: 'deny-all', fs: false, terminal: false, timeoutMs: 3000,
  });
  try {
    await assert.rejects(runtime.ensureSession({ agent: 'fixture', sessionKey: 'synthetic', cwd: root,
      mode: 'persistent', resumeSessionId: 'existing-native-session' }), /session\/load did not complete within 3000ms/);
    const methods = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(methods, ['initialize', 'session/load']);
    assert.deepEqual(observed, methods);
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});
