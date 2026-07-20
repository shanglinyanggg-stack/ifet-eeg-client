import { describe, expect, test } from 'vitest';
import { compensateAwakeAperiodicSlope } from './band-share-compensation';

const awakeExample = [
  { label: 'Delta' as const, value: 59.6 * 0.05, lowHz: 0.5, highHz: 2 },
  { label: 'Theta' as const, value: 15.8 * 0.4, lowHz: 4, highHz: 7 },
  { label: 'Alpha' as const, value: 13.7, lowHz: 8, highHz: 13 },
  { label: 'Beta' as const, value: 11, lowHz: 13, highHz: 30 }
];

describe('awake aperiodic band-share compensation', () => {
  test('recovers the expected awake ordering without hard-sorting values', () => {
    const result = compensateAwakeAperiodicSlope(awakeExample, 'W 清醒');
    const order = [...result].sort((left, right) => right.value - left.value).map((band) => band.label);
    expect(order).toEqual(['Beta', 'Alpha', 'Theta', 'Delta']);
  });

  test('does not alter NREM band amplitudes', () => {
    const result = compensateAwakeAperiodicSlope(awakeExample, 'NREM');
    expect(result.map((band) => band.value)).toEqual(awakeExample.map((band) => band.value));
  });
});
