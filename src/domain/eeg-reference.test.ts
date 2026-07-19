import { describe, expect, test } from 'vitest';
import type { TimedValue } from './dsp';
import { applyRobustMedianReference } from './eeg-reference';

function channel(values: number[]): TimedValue[] {
  return values.map((value, index) => ({ timestamp: 1000 + index * 10, value }));
}

describe('robust EEG reference', () => {
  test('removes shared drift while retaining channel-specific activity', () => {
    const common = [10_000, 12_000, 9_000];
    const eeg1 = channel(common.map((value, index) => value + [20, -30, 40][index]));
    const eeg2 = channel(common.map((value) => value + 5));
    const eeg3 = channel(common.map((value) => value - 5));
    const eeg4 = channel(common.map((value) => value + 1_000));

    const referenced = applyRobustMedianReference(eeg1, [eeg1, eeg2, eeg3, eeg4]);

    expect(referenced.map((point) => point.value)).toEqual([7.5, -30, 17.5]);
  });

  test('leaves data unchanged until at least three channels align', () => {
    const eeg1 = channel([1, 2, 3]);
    expect(applyRobustMedianReference(eeg1, [eeg1])).toBe(eeg1);
  });
});
