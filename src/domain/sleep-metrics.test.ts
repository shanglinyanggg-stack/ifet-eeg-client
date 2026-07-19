import { describe, expect, test } from 'vitest';
import type { TimedValue } from './dsp';
import { calculateSleepMetrics, type SleepMetricBandInput } from './sleep-metrics';

function values(points: number[], start = 1000, step = 10): TimedValue[] {
  return points.map((value, index) => ({
    timestamp: start + index * step,
    value
  }));
}

function band(label: SleepMetricBandInput['label'], level: number, count = 420): SleepMetricBandInput {
  return {
    label,
    values: values(Array.from({ length: count }, (_, index) => Math.sin(index / 6) * level))
  };
}

describe('sleep EEG metrics', () => {
  test('calculates relative band powers and theta alpha ratio', () => {
    const metrics = calculateSleepMetrics({
      rawValues: values([1, -1, 1, -1]),
      bands: [
        band('Delta', 1),
        band('Theta', 2),
        band('Alpha', 4),
        band('Beta', 1)
      ],
      spindleValues: values([0.2, -0.2, 0.2, -0.2])
    });

    expect(metrics.alphaRelative).toBeGreaterThan(metrics.thetaRelative);
    expect(metrics.thetaAlphaRatio).toBeCloseTo(0.25, 1);
    expect(metrics.betaRelative).toBeLessThan(metrics.alphaRelative);
    expect(metrics.solTrend).toBe('awake');
  });

  test('marks sleep onset trend when theta rises while alpha and beta are low', () => {
    const metrics = calculateSleepMetrics({
      rawValues: values(Array.from({ length: 420 }, (_, index) => Math.sin(index / 5) * 12)),
      bands: [
        band('Delta', 2),
        band('Theta', 6),
        band('Alpha', 2),
        band('Beta', 1)
      ],
      spindleValues: band('Beta', 1).values
    });

    expect(metrics.solTrend).toBe('sleep-onset');
    expect(metrics.sleepOnsetScore).toBeGreaterThanOrEqual(65);
    expect(metrics.solSeconds).not.toBeNull();
  });

  test('detects N2 candidate from spindle or K-complex cues', () => {
    const raw = values(Array.from({ length: 420 }, (_, index) => Math.sin(index / 7) * 4));
    raw[180] = { ...raw[180], value: 48 };
    raw[225] = { ...raw[225], value: -42 };

    const metrics = calculateSleepMetrics({
      rawValues: raw,
      bands: [
        band('Delta', 3),
        band('Theta', 4),
        band('Alpha', 2),
        band('Beta', 1)
      ],
      spindleValues: band('Alpha', 8).values
    });

    expect(metrics.vertexWave).toBe(true);
    expect(metrics.kComplexCandidate).toBe(true);
    expect(metrics.spindleCandidate).toBe(true);
    expect(metrics.n2Candidate).toBe(true);
  });
});
