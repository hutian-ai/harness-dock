export { DeviceController, DevicePeer, type DeviceControllerOptions, type DeviceRequestContext, type DeviceRequestHandler } from './device-controller.ts';
export { ServerClient, ServerPeer, type ServerClientOptions, type ExecutionCallbackHandler } from './server-client.ts';
export * from './server-protocol.ts';
export type { DeviceNodeSummary } from '@harness-dock/protocol';
export type {
  DeviceMethod, DeviceRequestMap, DeviceRequestParams, DeviceRequestResult, DeviceRequestArgs,
  DeviceInventory, DeviceProvider, DeviceProviderCapabilities, DeviceExecuteInput,
  DeviceExecutionState, DeviceExecutionResult, DeviceExecutionResponse, DeviceExecutionSnapshot,
  DeviceExecutionEvent, DeviceExecutionCallback, DeviceExecutionCallbackResult,
  DevicePermissionRequest, DevicePermissionDecision, DeviceToolDefinition, DeviceToolCall,
  DeviceToolResult, DeviceFile, DeviceOutput, DevicePreparedDirectories,
} from '@harness-dock/protocol';
export { DockError } from "@harness-dock/protocol";
export { loadClientOptions, runFirstTest, promptNativePermission } from './onboarding.ts';
