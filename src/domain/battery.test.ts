import { describe, expect, test } from 'vitest';
import {
  batteryEstimatedPercent,
  batteryLevel,
  batteryStateLabel,
  formatBatterySummary
} from './battery';
import type { BatteryEvent } from './protocol';

function event(overrides: Partial<BatteryEvent> = {}): BatteryEvent {
  return {
    timestamp: '2026-07-23T00:00:00Z',
    sequence: 1,
    charging: false,
    rawValue: 444,
    voltage: 3.29,
    smoothedVoltage: 3.29,
    estimatedPercent: 0,
    level: 'empty',
    ...overrides
  };
}

describe('battery calibration display', () => {
  test('shows the measured 3.29 V cutoff as empty', () => {
    const battery = event();
    expect(batteryEstimatedPercent(battery)).toBe(0);
    expect(batteryLevel(battery)).toBe('empty');
    expect(batteryStateLabel(battery)).toBe('已到实测耗尽电压');
    expect(formatBatterySummary(battery)).toBe('0% · 3.29 V');
  });

  test('uses the smoothed voltage and preserves charging state', () => {
    const battery = event({
      charging: true,
      voltage: 3.30,
      smoothedVoltage: 3.40,
      estimatedPercent: 12,
      level: 'charging'
    });
    expect(batteryLevel(battery)).toBe('charging');
    expect(formatBatterySummary(battery)).toBe('12% · 3.40 V（充电中）');
  });
});
