import { describe, expect, test } from 'vitest';
import { filterDebugEegWindow, filterPpgDisplayWindow, resolveDebugScale } from './debug-signal';

describe('EEGSleepUpper debug signal display', () => {
  test('keeps only the latest ten seconds and median-centers raw EEG', () => {
    const values = Array.from({ length: 1200 }, (_, index) => ({
      timestamp: index * 10,
      value: 5000 + Math.sin(index / 8) * 100
    }));
    const filtered = filterDebugEegWindow(values, 'raw', 100);

    expect(filtered).toHaveLength(1000);
    const sorted = filtered.map((point) => point.value).sort((a, b) => a - b);
    expect(Math.abs((sorted[499] + sorted[500]) / 2)).toBeLessThan(1e-6);
  });

  test('supports the exact EEGSleepUpper fixed and automatic scales', () => {
    expect(resolveDebugScale('5000')).toBe(5000);
    expect(resolveDebugScale('auto')).toBeUndefined();
  });

  test('removes the unsigned PPG DC baseline while preserving the pulse waveform', () => {
    const values = Array.from({ length: 1200 }, (_, index) => ({
      timestamp: index * 10,
      value: 8_000_000 + Math.sin(2 * Math.PI * 1.2 * index / 100) * 12_000
    }));

    const filtered = filterPpgDisplayWindow(values, 100, 10);
    const tail = filtered.slice(300).map((point) => point.value);
    const peakToPeak = Math.max(...tail) - Math.min(...tail);
    const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;

    expect(filtered).toHaveLength(1000);
    expect(Math.abs(mean)).toBeLessThan(500);
    expect(peakToPeak).toBeGreaterThan(15_000);
  });
});
