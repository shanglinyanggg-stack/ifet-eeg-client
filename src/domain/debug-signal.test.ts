import { describe, expect, test } from 'vitest';
import { filterDebugEegWindow, resolveDebugScale } from './debug-signal';

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
});
