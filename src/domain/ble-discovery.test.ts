import { describe, expect, test } from 'vitest';
import { connectionCandidates, mergeDiscoveredDevices } from './ble-discovery';

const devices = [
  { id: 'keyboard', name: 'Keyboard', rssi: -32 },
  { id: 'headset-weak', name: 'iFET EEG', rssi: -68 },
  { id: 'headset-strong', name: 'EEG Headset', rssi: -41 }
];

describe('continuous BLE discovery', () => {
  test('honours an explicitly selected device', () => {
    expect(connectionCandidates(devices, 'keyboard').map((device) => device.id)).toEqual(['keyboard']);
  });

  test('automatically tries likely headsets by signal strength', () => {
    expect(connectionCandidates(devices, '').map((device) => device.id)).toEqual([
      'headset-strong',
      'headset-weak'
    ]);
  });

  test('does not connect arbitrary devices when several are visible', () => {
    expect(connectionCandidates([
      { id: 'mouse', name: 'Mouse', rssi: -20 },
      { id: 'keyboard', name: 'Keyboard', rssi: -30 }
    ], '')).toEqual([]);
  });

  test('keeps earlier discoveries while refreshing RSSI', () => {
    expect(mergeDiscoveredDevices(
      [{ id: 'headset', name: 'iFET EEG', rssi: -70 }],
      [{ id: 'headset', name: 'iFET EEG', rssi: -45 }, { id: 'other', name: 'Other', rssi: -60 }]
    )).toEqual([
      { id: 'headset', name: 'iFET EEG', rssi: -45 },
      { id: 'other', name: 'Other', rssi: -60 }
    ]);
  });
});
