import { describe, expect, test } from 'vitest';
import type { SleepMetrics } from './sleep-metrics';
import { QualityGatedWearableDrowsinessEstimator } from './wearable-drowsiness';

function metrics(theta: number, alpha: number, beta: number, fallback = 20): SleepMetrics {
  return {
    thetaRelative: theta,
    alphaRelative: alpha,
    betaRelative: beta,
    thetaAlphaRatio: theta / alpha,
    sleepOnsetScore: fallback
  } as SleepMetrics;
}

describe('quality-gated wearable drowsiness trial', () => {
  test('learns eleven overlapping windows over about sixty seconds', () => {
    const estimator = new QualityGatedWearableDrowsinessEstimator();
    let snapshot = estimator.update({
      metrics: metrics(0.15, 0.25, 0.35), timestampMs: 5_000,
      modelProbability: 0.2, quality: 0.95
    });
    for (let index = 2; index <= 11; index += 1) {
      snapshot = estimator.update({
        metrics: metrics(0.15, 0.25, 0.35), timestampMs: index * 5_000,
        modelProbability: 0.2, quality: 0.95
      });
    }

    expect(snapshot.baselineReady).toBe(true);
    expect(snapshot.baselineProgress).toBe(1);
  });

  test('raises the score when persistent theta-to-beta evidence increases', () => {
    const estimator = new QualityGatedWearableDrowsinessEstimator();
    for (let index = 1; index <= 11; index += 1) {
      estimator.update({
        metrics: metrics(0.15, 0.25, 0.35), timestampMs: index * 5_000,
        modelProbability: 0.2, quality: 0.95
      });
    }
    const alert = estimator.update({
      metrics: metrics(0.15, 0.25, 0.35), timestampMs: 60_000,
      modelProbability: 0.2, quality: 0.95
    });
    let drowsy = alert;
    for (let index = 13; index <= 15; index += 1) {
      drowsy = estimator.update({
        metrics: metrics(0.42, 0.24, 0.08, 80), timestampMs: index * 5_000,
        modelProbability: 0.8, quality: 0.95, allowAlertBaselineUpdate: false
      });
    }

    expect(drowsy.featureScore).toBeGreaterThan(80);
    expect(drowsy.score).toBeGreaterThan(alert.score + 40);
  });

  test('keeps accepted awake windows below twenty percent', () => {
    const estimator = new QualityGatedWearableDrowsinessEstimator();
    let snapshot = estimator.update({
      metrics: metrics(0.15, 0.25, 0.35, 35), timestampMs: 5_000,
      modelProbability: 0.35, quality: 0.95
    });
    expect(snapshot.score).toBeLessThan(20);

    for (let index = 2; index <= 14; index += 1) {
      snapshot = estimator.update({
        metrics: metrics(0.15, 0.25, 0.35, 35), timestampMs: index * 5_000,
        modelProbability: index > 11 ? 0.55 : 0.35,
        quality: 0.95,
        allowAlertBaselineUpdate: true,
        awakeConfirmed: true
      });
    }

    expect(snapshot.baselineReady).toBe(true);
    expect(snapshot.score).toBeLessThan(20);
  });

  test('holds the last accepted score when signal quality is poor', () => {
    const estimator = new QualityGatedWearableDrowsinessEstimator();
    let accepted = estimator.update({
      metrics: metrics(0.2, 0.25, 0.3, 30), timestampMs: 5_000,
      modelProbability: 0.3, quality: 0.9
    });
    const rejected = estimator.update({
      metrics: metrics(0.8, 0.01, 0.01, 100), timestampMs: 10_000,
      modelProbability: 1, quality: 0.2
    });

    expect(rejected.score).toBe(accepted.score);
    expect(rejected.source).toBe('quality-hold');
  });
});
