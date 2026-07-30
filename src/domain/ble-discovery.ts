import type { DeviceInfo } from './protocol';

const TD_DEVICE_NAME_PATTERN = /^TD/i;

export function isTdDeviceName(name: string): boolean {
  return TD_DEVICE_NAME_PATTERN.test(name.trimStart());
}

export function filterTdDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return devices.filter((device) => isTdDeviceName(device.name));
}

/**
 * Keep automatic connection conservative: honour an explicit user selection,
 * otherwise only try devices whose advertised name starts with TD.
 */
export function connectionCandidates(
  devices: readonly DeviceInfo[],
  selectedDeviceId: string
): DeviceInfo[] {
  const tdDevices = filterTdDevices(devices);
  if (selectedDeviceId) {
    return tdDevices.filter((device) => device.id === selectedDeviceId);
  }

  return tdDevices.sort((left, right) => right.rssi - left.rssi);
}

export function mergeDiscoveredDevices(
  previous: readonly DeviceInfo[],
  discovered: readonly DeviceInfo[]
): DeviceInfo[] {
  const byId = new Map(filterTdDevices(previous).map((device) => [device.id, device]));
  for (const device of filterTdDevices(discovered)) byId.set(device.id, device);
  return [...byId.values()].sort((left, right) => right.rssi - left.rssi);
}
