import { describe, expect, test } from 'vitest';
import { appendSample, computeShare, createEegBands, resolveScale } from './dsp';

describe('frontend dsp helpers', () => {
  test('normalizes EEG band shares', () => {
    const share = computeShare([
      { label: 'Delta', value: 1 },
      { label: 'Theta', value: 2 },
      { label: 'Alpha', value: 3 },
      { label: 'Beta', value: 4 }
    ]);

    expect(share.map((item) => item.percent)).toEqual([10, 20, 30, 40]);
  });

  test('resolves auto scale from visible values', () => {
    expect(resolveScale('auto', [-2, 4, 10])).toBe(12);
    expect(resolveScale(80, [-2, 4, 10])).toBe(80);
    expect(resolveScale('auto', [])).toBe(1);
  });

  test('keeps sample buffers bounded', () => {
    const now = 1000;
    const first = appendSample([], { timestamp: now, value: 1 }, 3);
    const second = appendSample(first, { timestamp: now + 1, value: 2 }, 3);
    const third = appendSample(second, { timestamp: now + 2, value: 3 }, 3);
    const fourth = appendSample(third, { timestamp: now + 3, value: 4 }, 3);

    expect(fourth.map((sample) => sample.value)).toEqual([2, 3, 4]);
  });

  test('creates four EEG bands with default ranges', () => {
    expect(createEegBands().map((band) => band.label)).toEqual(['Delta', 'Theta', 'Alpha', 'Beta']);
  });
});
