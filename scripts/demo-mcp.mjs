// Minimal stdio fixture for an actual MCP round trip, not a general MCP server.
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize')
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'dock-demo', version: '1.0.0' },
    };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list')
    result = {
      tools: [
        {
          name: 'demo_echo',
          description: 'Echo a synthetic marker to verify this local MCP connection.',
          inputSchema: {
            type: 'object',
            properties: { marker: { type: 'string' } },
            required: ['marker'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
      ],
    };
  else if (
    request.method === 'tools/call' &&
    request.params?.name === 'demo_echo' &&
    typeof request.params.arguments?.marker === 'string'
  )
    result = { content: [{ type: 'text', text: `DOCK_MCP:${request.params.arguments.marker}` }] };
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Unsupported fixture method' },
      }) + '\n',
    );
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
