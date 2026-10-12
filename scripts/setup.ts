import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve('.local');
await mkdir(root, { recursive: true, mode: 0o700 });
for (const directory of ['work', 'codex-home', 'acpx-state', 'evidence', 'outside'])
  await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
await copyFile(resolve('scripts/codex-config.toml'), join(root, 'codex-home', 'config.toml'));
const configPath = join(root, 'config.json');
try {
  await readFile(configPath);
  console.log('Existing local config preserved.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  await writeFile(
    configPath,
    JSON.stringify(
      {
        nodeId: randomUUID(),
        endpoint: 'ws://127.0.0.1:48517/',
        token: randomBytes(32).toString('hex'),
        cwd: join(root, 'work'),
        codexHome: join(root, 'codex-home'),
        stateDir: join(root, 'acpx-state'),
        mcpServers: [
          {
            name: 'dock_demo',
            command: process.execPath,
            args: [resolve('scripts/demo-mcp.mjs')],
            env: [],
          },
        ],
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
}
const index = process.argv.indexOf('--auth-from');
if (index !== -1) {
  const source = process.argv[index + 1];
  if (!source) throw new Error('--auth-from requires a file');
  const target = join(root, 'codex-home', 'auth.json');
  await copyFile(resolve(source), target);
  await chmod(target, 0o600);
  console.log('Copied only auth.json into isolated CODEX_HOME.');
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config.nodeId) throw new Error('Local config predates protocol 3; add a fresh UUID nodeId before starting.');
await writeFile(join(root, 'controller.json'), JSON.stringify({
  nodeId: config.nodeId, token: config.token, endpoint: config.endpoint,
}, null, 2), { mode: 0o600 });
console.log(
  'Local config ready. Start pnpm demo:controller and pnpm dev:daemon in separate terminals.',
);
