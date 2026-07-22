import type { BatteryEvent, BatteryLevel } from './protocol';

export const BATTERY_EMPTY_VOLTAGE = 3.29;
export const BATTERY_FULL_VOLTAGE = 4.20;
export const BATTERY_LOW_VOLTAGE = 3.35;

export function batteryDisplayVoltage(battery: BatteryEvent): number {
  return battery.smoothedVoltage ?? battery.voltage;
}

export function batteryEstimatedPercent(battery: BatteryEvent): number {
  if (typeof battery.estimatedPercent === 'number') {
    return Math.max(0, Math.min(100, Math.round(battery.estimatedPercent)));
  }
  return Math.max(0, Math.min(100, Math.round(
    ((batteryDisplayVoltage(battery) - BATTERY_EMPTY_VOLTAGE)
      / (BATTERY_FULL_VOLTAGE - BATTERY_EMPTY_VOLTAGE)) * 100
  )));
}

export function batteryLevel(battery: BatteryEvent): BatteryLevel {
  if (battery.level) return battery.level;
  if (battery.charging) return 'charging';
  const voltage = batteryDisplayVoltage(battery);
  if (voltage <= BATTERY_EMPTY_VOLTAGE) return 'empty';
  if (voltage <= BATTERY_LOW_VOLTAGE) return 'low';
  return 'normal';
}

export function batteryStateLabel(battery: BatteryEvent): string {
  switch (batteryLevel(battery)) {
    case 'charging': return '正在充电 · 估算电量';
    case 'empty': return '已到实测耗尽电压';
    case 'low': return '电量低，请尽快充电';
    default: return '估算电量 · 30秒平滑';
  }
}

export function formatBatterySummary(battery: BatteryEvent): string {
  const suffix = battery.charging ? '（充电中）' : '';
  return `${batteryEstimatedPercent(battery)}% · ${batteryDisplayVoltage(battery).toFixed(2)} V${suffix}`;
}
