/** Device connection identity is pinned independently of each execution. */
export const DEVICE_PROTOCOL_VERSION = 3;
export const DEVICE_PROTOCOL_HEADER = 'x-dock-device-version';

export interface DeviceNodeSummary {
  nodeId: string;
  label?: string;
  daemonId?: string;
  connected: boolean;
}
