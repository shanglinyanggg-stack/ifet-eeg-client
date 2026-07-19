import type { SleepMetrics } from './sleep-metrics';

/** v0.2.5 display rule: online probability first, local spectral score fallback. */
export function computeDrowsinessScore(
  metrics: SleepMetrics,
  sleepProbability?: number | null
): number {
  return Number.isFinite(sleepProbability)
    ? Math.round(clamp(Number(sleepProbability), 0, 1) * 100)
    : Math.round(clamp(metrics.sleepOnsetScore, 0, 100));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
