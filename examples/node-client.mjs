// Run this file from the distributed controller/examples directory after reviewing it.
// nodes: node node-client.mjs /private/client.json
// explicit model/approval test: node node-client.mjs /private/client.json --execute
import { ServerClient, loadClientOptions, runFirstTest, promptNativePermission } from '@harness-dock/client';

if (!process.argv[2]) throw new Error('Pass the private application client.json; never pass a device pairing file.');
const client = new ServerClient(await loadClientOptions(process.argv[2]));
try {
  await client.ready;
  console.table(client.listNodes());
  if (process.argv[3] === '--execute') {
    if (!process.stdin.isTTY) throw new Error('Use an interactive terminal for native approval.');
    const node = client.listNodes();
    if (node.length !== 1) throw new Error('This minimal example requires exactly one granted device.');
    console.log(await runFirstTest(client.node(node[0].nodeId), { approval: true, permission: promptNativePermission,
      progress: value => console.log(value) }));
  }
} finally { await client.close(); }
