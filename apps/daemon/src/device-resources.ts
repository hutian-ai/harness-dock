/** Owner-configured bounds; execution requests cannot raise these limits. */
export const DEVICE_RESOURCES = {
  maxConcurrentExecutions: 2,
  idleTimeoutMs: 10 * 60_000,
  historyRetentionMs: 7 * 24 * 60 * 60_000,
  preparationTtlMs: 24 * 60 * 60_000,
  maxStateBytes: 512 * 1024 * 1024,
  maxIdentities: 100_000,
  maxEventBytes: 256 * 1024,
  maxRunEventBytes: 32 * 1024 * 1024,
  maxRunEvents: 10_000,
  maxPageBytes: 1024 * 1024,
  maxResultBytes: 16 * 1024 * 1024,
} as const;
export type DeviceResourceLimits = { [K in keyof typeof DEVICE_RESOURCES]: number };
export function resourceLimits(input: Partial<DeviceResourceLimits> = {}): DeviceResourceLimits {
  for (const [key, value] of Object.entries(input))
    if (!(Object.hasOwn(DEVICE_RESOURCES, key)) || !Number.isSafeInteger(value) || value <= 0)
      throw new Error('invalid_resource_limit');
  const limits = { ...DEVICE_RESOURCES, ...input };
  if (limits.maxConcurrentExecutions > 8 || limits.idleTimeoutMs > 2_147_483_647 || limits.maxPageBytes < limits.maxEventBytes || limits.maxRunEventBytes < limits.maxEventBytes)
    throw new Error('invalid_resource_limit');
  return limits;
}
