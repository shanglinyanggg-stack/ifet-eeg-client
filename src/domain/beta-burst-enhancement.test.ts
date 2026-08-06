import { describe, expect, test } from 'vitest';
import { enhanceShortBetaBursts } from './beta-burst-enhancement';
import type { TimedValue } from './dsp';

const SAMPLE_RATE = 125;

function betaSignal(seconds: number): TimedValue[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from({ length: count }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const burst = time >= 2 && time < 2.4 ? 4 : 1;
    return {
      timestamp: index * (1_000 / SAMPLE_RATE),
      value: burst * Math.sin(2 * Math.PI * 20 * time)
    };
  });
}

function rms(values: TimedValue[]): number {
  return Math.sqrt(values.reduce((sum, point) => sum + point.value ** 2, 0) / values.length);
}

describe('enhanceShortBetaBursts', () => {
  test('increases short beta-burst contrast without changing timestamps', () => {
    const input = betaSignal(5);
    const output = enhanceShortBetaBursts(input, SAMPLE_RATE);
    const backgroundIn = rms(input.slice(125, 225));
    const burstIn = rms(input.slice(265, 295));
    const backgroundOut = rms(output.slice(125, 225));
    const burstOut = rms(output.slice(265, 295));

    expect(output).toHaveLength(input.length);
    expect(output.map((point) => point.timestamp)).toEqual(input.map((point) => point.timestamp));
    expect(burstOut / backgroundOut).toBeGreaterThan(burstIn / backgroundIn);
  });

  test('soft-limits an isolated extreme artifact', () => {
    const input = betaSignal(5);
    input[300] = { ...input[300], value: 1_000 };
    const output = enhanceShortBetaBursts(input, SAMPLE_RATE);

    expect(Math.abs(output[300].value)).toBeLessThan(20);
    expect(output.every((point) => Number.isFinite(point.value))).toBe(true);
  });

  test('keeps a zero signal stable', () => {
    const input = Array.from({ length: 200 }, (_, index) => ({ timestamp: index * 8, value: 0 }));
    expect(enhanceShortBetaBursts(input, SAMPLE_RATE).every((point) => point.value === 0)).toBe(true);
  });
});
