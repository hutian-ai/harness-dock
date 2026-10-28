import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privacyIssues } from '../scripts/check-privacy.ts';

test('privacy gate rejects runtime data even when it is force-added to Git', () => {
  for (const path of ['.local/config.json', '.serena/memory.md', 'node_modules/pkg/index.js', 'apps/daemon/dist/cli.js'])
    assert.ok(privacyIssues(path).includes('local_or_generated_directory'), path);
  for (const path of ['config/server.json', 'auth.json', '.env', '.env.production', 'tls.key', 'state.sqlite-wal', 'daemon.log'])
    assert.ok(privacyIssues(path).includes('private_runtime_file'), path);
  assert.deepEqual(privacyIssues('.env.example'), []);
  assert.deepEqual(privacyIssues('THIRD_PARTY_NOTICES.md'), []);
});

test('privacy gate permits explicit synthetic paths but rejects personal paths without echoing values', () => {
  const home = '/Users/' + ['private', 'owner'].join('-');
  const result = privacyIssues('README.md', Buffer.from(`${home}/work`));
  assert.deepEqual(result, ['personal_home_path']);
  assert.ok(!JSON.stringify(result).includes(home));
  assert.deepEqual(privacyIssues('fixture.ts', Buffer.from('/Users/Some User/.codex and /home/example')), []);
  assert.deepEqual(privacyIssues('README.md', Buffer.from('PATH/HOME/locale')), []);
});

test('privacy gate distinguishes documented network examples from literal service addresses', () => {
  for (const endpoint of ['ws://127.0.0.1:48518/', 'wss://[::1]/', 'wss://192.0.2.1/', 'wss://dock.example.com/'])
    assert.deepEqual(privacyIssues('README.md', Buffer.from(endpoint)), []);
  const endpoint = ['wss://', [10, 20, 30, 40].join('.'), '/'].join('');
  assert.deepEqual(privacyIssues('README.md', Buffer.from(endpoint)), ['literal_service_ip']);
});
