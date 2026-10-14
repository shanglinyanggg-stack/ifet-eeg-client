import { describe, expect, test } from 'vitest';
import {
  decimateDisplayValues,
  DISPLAY_PROCESSING_SAMPLE_RATE_HZ,
  resolveDisplaySampleRate
} from './display-decimation';

describe('native-rate display buffer', () => {
  test('keeps the complete native stream at 125 Hz', () => {
    const values = Array.from({ length: 5 }, (_, index) => ({ timestamp: index * 8, value: index }));
    expect(decimateDisplayValues(undefined, values, 125)).toEqual(values);
  });

  test('keeps every 1 kHz sample across batch boundaries', () => {
    const first = Array.from({ length: 16 }, (_, index) => ({ timestamp: index, value: index }));
    const firstOutput = decimateDisplayValues(undefined, first, 1_000);
    expect(firstOutput).toEqual(first);

    const second = Array.from({ length: 16 }, (_, index) => ({ timestamp: 16 + index, value: index }));
    const secondOutput = decimateDisplayValues(firstOutput.at(-1)?.timestamp, second, 1_000);
    expect(secondOutput).toEqual(second);
  });

  test('uses the native signal rate, never a fixed 125 Hz cap', () => {
    expect(DISPLAY_PROCESSING_SAMPLE_RATE_HZ).toBe(125);
    expect(resolveDisplaySampleRate(125)).toBe(125);
    for (const rate of [125,250,500,1000]) expect(resolveDisplaySampleRate(rate)).toBe(rate);
  });
});
