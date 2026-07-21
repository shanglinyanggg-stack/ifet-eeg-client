import { describe, expect, test } from 'vitest';
import {
  decimateDisplayValues,
  DISPLAY_PROCESSING_SAMPLE_RATE_HZ,
  resolveDisplaySampleRate
} from './display-decimation';

describe('high-rate display decimation', () => {
  test('keeps the complete native stream at 125 Hz', () => {
    const values = Array.from({ length: 5 }, (_, index) => ({ timestamp: index * 8, value: index }));
    expect(decimateDisplayValues(undefined, values, 125)).toEqual(values);
  });

  test('limits 1 kHz display data to 125 Hz across batch boundaries', () => {
    const first = Array.from({ length: 16 }, (_, index) => ({ timestamp: index, value: index }));
    const firstOutput = decimateDisplayValues(undefined, first, 1_000);
    expect(firstOutput.map((point) => point.timestamp)).toEqual([0, 8]);

    const second = Array.from({ length: 16 }, (_, index) => ({ timestamp: 16 + index, value: index }));
    const secondOutput = decimateDisplayValues(firstOutput.at(-1)?.timestamp, second, 1_000);
    expect(secondOutput.map((point) => point.timestamp)).toEqual([16, 24]);
  });

  test('reports the fixed display processing rate without changing acquisition rate', () => {
    expect(DISPLAY_PROCESSING_SAMPLE_RATE_HZ).toBe(125);
    expect(resolveDisplaySampleRate(125)).toBe(125);
    expect(resolveDisplaySampleRate(1_000)).toBe(125);
  });
});
