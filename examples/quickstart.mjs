// Current source SDK example. New observation/collection helpers are not in sdk-v0.1.2.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connectDock } from '@harness-dock/client';

const command = process.argv[2] ?? 'run';
if (!['run', 'status', 'collect', 'release'].includes(command)) throw new Error('Use run, status, collect or release.');
const receipt = '.local/hello.json', archive = '.local/hello-archive.json';
const observation = new AbortController();
const interrupt = () => observation.abort(new Error('observation_interrupted'));
const dock = await connectDock('.local/client.json');
try {
  if (command === 'release') {
    // Explicit human/application acceptance follows inspection of the stored archive.
    const saved = JSON.parse(await readFile(archive, 'utf8'));
    const original = await dock.status(receipt);
    if (saved.snapshot.runId !== original?.runId) throw new Error('archive_run_mismatch');
    await dock.release(receipt);
    console.log('Released Dock-managed files; the receipt and native history remain.');
  } else {
    if (command === 'run') {
      process.once('SIGINT', interrupt);
      try {
        const task = await dock.run({
          prompt: '回复 hello', receipt, // 每个新任务使用新文件；已有文件会拒绝重派。
          // nodeId: '从 dock.listNodes() 选取', // 多设备时必填。
          onReceipt: handle => console.error('Receipt saved:', handle.runId, handle.receipt),
          progress: event => console.error('Progress:', event.kind),
          signal: observation.signal, // Only stops observation. Never cancels native execution.
        });
        console.log(task.result);
      } finally { process.removeListener('SIGINT', interrupt); }
    }
    const snapshot = await dock.status(receipt);
    if (command === 'status') console.log(snapshot);
    else if (snapshot && ['completed', 'failed', 'cancelled'].includes(snapshot.state)) {
      const outputs = await dock.collect(receipt);
      for (const output of outputs) {
        if (createHash('sha256').update(Buffer.from(output.contentBase64, 'base64')).digest('hex') !== output.sha256)
          throw new Error('output_checksum_mismatch');
      }
      await writeFile(archive, JSON.stringify({ snapshot, outputs }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log('Archive saved:', archive, '\nInspect and accept it, then explicitly run: node quickstart.mjs release');
    } else {
      console.log(snapshot);
      console.error('Result unconfirmed. Keep the receipt and query status; never resubmit for recovery.');
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'task_failed');
  console.error('Keep the receipt. Query the original task with: node quickstart.mjs status');
  process.exitCode = observation.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  await dock.close();
}
