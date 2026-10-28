// Compiled by pnpm check. This function is never called and sends no requests.
import type {
  ServerPeer, DevicePeer, DeviceInventory, DeviceExecutionResponse, DeviceOutput,
  DevicePermissionRequest, DevicePermissionDecision, DeviceProviderCapabilities,
} from '../../packages/client/src/index.ts';
import type { NativePermissionRequest, NativePermissionDecision } from '../../packages/drivers/src/execution.ts';
import type { ProviderCapabilities } from '../../packages/drivers/src/provider-adapter.ts';

export async function publicContracts(peer: ServerPeer, direct: DevicePeer) {
  const inventory: DeviceInventory = await peer.request('inventory');
  const result: DeviceExecutionResponse = await peer.request('execute', { provider: inventory.providers[0]!.key, runId: 'run', prompt: 'synthetic' });
  const outputs: DeviceOutput[] = await direct.request('collect', { runId: 'run' });
  const snapshot = await peer.request('getExecution', { runId: 'run' });
  await peer.request('reconcile', { runId: 'run', provider: 'codex', sessionKey: 'session' });
  // @ts-expect-error legacy hints cannot replace the persisted execution identity
  await peer.request('reconcile', { provider: 'codex', sessionKey: 'session' });
  if (snapshot) snapshot.state satisfies 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown';
  const legacy = await peer.request<{ ownProjection: boolean }>('inventory');
  legacy.ownProjection satisfies boolean;
  // @ts-expect-error execute requires an execution identity
  await peer.request('execute', { provider: 'codex', prompt: 'synthetic' });
  // @ts-expect-error required parameters cannot be omitted
  await direct.request('collect');
  // @ts-expect-error result types follow the method, not the caller's guess
  const invalid: string = await peer.request('inventory');
  // @ts-expect-error only existing wire methods have inferred contracts
  await peer.request('arbitrary.command', {});
  peer.onExecutionCallback(async request => {
    if (request.kind === 'permission') {
      request.payload.options?.[0]?.optionId satisfies string | undefined;
      return 'deny';
    }
    if (request.kind === 'toolCall') return { content: { name: request.payload.name } };
    return null;
  });
  return { result, outputs, invalid };
}

// Both directions catch accidental drift at the local driver / wire boundary.
export const permissionToWire = (value: NativePermissionRequest): DevicePermissionRequest => value;
export const permissionFromWire = (value: DevicePermissionRequest): NativePermissionRequest => value;
export const decisionToWire = (value: NativePermissionDecision): DevicePermissionDecision => value;
export const decisionFromWire = (value: DevicePermissionDecision): NativePermissionDecision => value;
export const capabilitiesToWire = (value: ProviderCapabilities): DeviceProviderCapabilities => value;
export const capabilitiesFromWire = (value: DeviceProviderCapabilities): ProviderCapabilities => value;
