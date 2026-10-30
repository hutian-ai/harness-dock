import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelError, runPanelOperation } from './panel-management.ts';

process.umask(0o077);
try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32_768) throw new Error('invalid_panel_request');
    chunks.push(Buffer.from(chunk));
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const value = await runPanelOperation(input, resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: panelError(error) }));
  process.exitCode = 1;
}
