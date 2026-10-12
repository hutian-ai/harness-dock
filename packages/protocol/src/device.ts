/** Device control is separate from the original single-session demo protocol. */
export const DEVICE_PROTOCOL_VERSION = 2;
export const DEVICE_PROTOCOL_HEADER = 'x-dock-device-version';

export interface DeviceNodeSummary {
  nodeId: string;
  label?: string;
  daemonId?: string;
  connected: boolean;
}
