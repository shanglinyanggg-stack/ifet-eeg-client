import { describe, expect, test } from 'vitest';
import type { SleepMetrics } from './sleep-metrics';
import { computeDrowsinessScore } from './drowsiness';

const metrics = {
  sleepOnsetScore: 42
} as SleepMetrics;

describe('v0.2.5 drowsiness display score', () => {
  test('uses the online sleep probability directly when available', () => {
    expect(computeDrowsinessScore(metrics, 0.9)).toBe(90);
  });

  test('does not apply an additional stage weight or cap', () => {
    expect(computeDrowsinessScore({ ...metrics, sleepOnsetScore: 80 }, 0.95)).toBe(95);
  });

  test('falls back to the local spectral score while the service is not ready', () => {
    expect(computeDrowsinessScore(metrics, null)).toBe(42);
  });
});
