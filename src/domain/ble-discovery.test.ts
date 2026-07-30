import { describe, expect, test } from 'vitest';
import {
  connectionCandidates,
  filterTdDevices,
  isTdDeviceName,
  mergeDiscoveredDevices
} from './ble-discovery';

const devices = [
  { id: 'keyboard', name: 'Keyboard', rssi: -32 },
  { id: 'headset-weak', name: 'TD10-A', rssi: -68 },
  { id: 'headset-strong', name: 'td10-B', rssi: -41 }
];

describe('continuous BLE discovery', () => {
  test('recognizes only names that start with TD, ignoring case and leading spaces', () => {
    expect(isTdDeviceName('TD10')).toBe(true);
    expect(isTdDeviceName('  td-headset')).toBe(true);
    expect(isTdDeviceName('iFET TD10')).toBe(false);
    expect(isTdDeviceName('EEG Headset')).toBe(false);
  });

  test('filters non-TD devices before they reach the selector', () => {
    expect(filterTdDevices(devices).map((device) => device.id)).toEqual([
      'headset-weak',
      'headset-strong'
    ]);
  });

  test('honours an explicitly selected TD device', () => {
    expect(connectionCandidates(devices, 'headset-weak').map((device) => device.id)).toEqual([
      'headset-weak'
    ]);
    expect(connectionCandidates(devices, 'keyboard')).toEqual([]);
  });

  test('automatically tries TD headsets by signal strength', () => {
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
      [{ id: 'headset', name: 'TD10', rssi: -70 }],
      [{ id: 'headset', name: 'TD10', rssi: -45 }, { id: 'other', name: 'Other', rssi: -60 }]
    )).toEqual([
      { id: 'headset', name: 'TD10', rssi: -45 }
    ]);
  });
});
