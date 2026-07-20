import type { DeviceInfo } from './protocol';

const HEADSET_NAME_PATTERN = /(ifet|eeg|headset|headband|sleep|brain|头戴|脑电)/i;

/**
 * Keep automatic connection conservative: honour an explicit user selection,
 * otherwise only try devices whose advertised name looks like the EEG headset.
 * A single visible BLE device is also safe to try automatically.
 */
export function connectionCandidates(
  devices: readonly DeviceInfo[],
  selectedDeviceId: string
): DeviceInfo[] {
  if (selectedDeviceId) {
    return devices.filter((device) => device.id === selectedDeviceId);
  }

  const namedHeadsets = devices.filter((device) => HEADSET_NAME_PATTERN.test(device.name));
  const candidates = namedHeadsets.length > 0
    ? namedHeadsets
    : devices.length === 1
      ? [...devices]
      : [];

  return candidates.sort((left, right) => right.rssi - left.rssi);
}

export function mergeDiscoveredDevices(
  previous: readonly DeviceInfo[],
  discovered: readonly DeviceInfo[]
): DeviceInfo[] {
  const byId = new Map(previous.map((device) => [device.id, device]));
  for (const device of discovered) byId.set(device.id, device);
  return [...byId.values()].sort((left, right) => right.rssi - left.rssi);
}
