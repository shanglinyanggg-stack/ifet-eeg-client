import { computeDrowsinessScore } from './drowsiness';
import type { SleepMetrics } from './sleep-metrics';

export type WearableDrowsinessSource =
  | 'alert-calibration'
  | 'wearable-fusion'
  | 'spectral-only'
  | 'quality-hold'
  | 'v025-fallback';

export interface WearableDrowsinessSnapshot {
  score: number;
  featureScore: number | null;
  modelScore: number | null;
  baselineProgress: number;
  baselineReady: boolean;
  qualityAccepted: boolean;
  source: WearableDrowsinessSource;
  thetaBetaRatio: number;
  slowFastRatio: number;
  baselineThetaBetaRatio: number | null;
}

interface WearableDrowsinessInput {
  metrics: SleepMetrics;
  timestampMs: number;
  modelProbability?: number | null;
  quality?: number | null;
  allowAlertBaselineUpdate?: boolean;
}

interface FeatureVector {
  thetaBeta: number;
  slowFast: number;
  thetaAlpha: number;
}

// First complete 10 s window, then ten 5 s updates: ready at about 60 s.
const BASELINE_WINDOWS = 11;
const UPDATE_INTERVAL_MS = 5_000;
const MINIMUM_QUALITY = 0.6;

/**
 * Experimental wearable drowsiness estimator.
 *
 * It follows the deployable feature family reported by Kaveh et al. (Nature
 * Communications 2024): 10 s spectral windows, theta/beta and
 * (alpha+theta)/beta ratios, robust median/IQR scaling and temporal context.
 * Because the paper's fitted SVM weights are not publicly downloadable, this
 * trial uses directional robust evidence and fuses it with the existing PC
 * sleep probability. It is intentionally labelled as a trial, not as the
 * original published classifier.
 */
export class QualityGatedWearableDrowsinessEstimator {
  private baseline: FeatureVector[] = [];
  private recentEvidence: number[] = [];
  private lastTimestamp = -Infinity;
  private lastSnapshot: WearableDrowsinessSnapshot | null = null;

  update(input: WearableDrowsinessInput): WearableDrowsinessSnapshot {
    if (input.timestampMs - this.lastTimestamp < UPDATE_INTERVAL_MS && this.lastSnapshot) {
      return this.lastSnapshot;
    }
    this.lastTimestamp = input.timestampMs;

    const quality = Number.isFinite(input.quality) ? clamp01(Number(input.quality)) : 1;
    const modelProbability = Number.isFinite(input.modelProbability)
      ? clamp01(Number(input.modelProbability))
      : null;
    const features = extractFeatures(input.metrics);
    const qualityAccepted = quality >= MINIMUM_QUALITY && features !== null;

    if (!qualityAccepted) {
      const fallback = this.lastSnapshot?.score
        ?? computeDrowsinessScore(input.metrics, modelProbability);
      return this.save({
        score: fallback,
        featureScore: this.lastSnapshot?.featureScore ?? null,
        modelScore: modelProbability === null ? null : Math.round(modelProbability * 100),
        baselineProgress: Math.min(1, this.baseline.length / BASELINE_WINDOWS),
        baselineReady: this.baseline.length >= BASELINE_WINDOWS,
        qualityAccepted: false,
        source: this.lastSnapshot ? 'quality-hold' : 'v025-fallback',
        thetaBetaRatio: features ? Math.exp(features.thetaBeta) : 0,
        slowFastRatio: features ? Math.exp(features.slowFast) : 0,
        baselineThetaBetaRatio: this.baselineRatio()
      });
    }

    const mayLearnAlert = input.allowAlertBaselineUpdate !== false
      && (modelProbability === null || modelProbability < 0.45);
    if (this.baseline.length < BASELINE_WINDOWS && mayLearnAlert) {
      this.baseline.push(features);
    }

    const baselineReady = this.baseline.length >= BASELINE_WINDOWS;
    if (!baselineReady) {
      return this.save({
        score: computeDrowsinessScore(input.metrics, modelProbability),
        featureScore: null,
        modelScore: modelProbability === null ? null : Math.round(modelProbability * 100),
        baselineProgress: Math.min(1, this.baseline.length / BASELINE_WINDOWS),
        baselineReady: false,
        qualityAccepted: true,
        source: mayLearnAlert ? 'alert-calibration' : 'v025-fallback',
        thetaBetaRatio: Math.exp(features.thetaBeta),
        slowFastRatio: Math.exp(features.slowFast),
        baselineThetaBetaRatio: this.baselineRatio()
      });
    }

    const evidence = directionalEvidence(features, this.baseline);
    this.recentEvidence.push(evidence);
    if (this.recentEvidence.length > 3) this.recentEvidence.shift();
    const persistentEvidence = median(this.recentEvidence);
    const featureProbability = sigmoid((persistentEvidence - 1.5) * 1.2);
    const combinedProbability = modelProbability === null
      ? featureProbability
      : modelProbability * 0.6 + featureProbability * 0.4;

    // Only clearly alert, high-quality windows may slowly refresh the baseline.
    if (mayLearnAlert && featureProbability < 0.35) {
      this.baseline.push(features);
      if (this.baseline.length > 60) this.baseline.shift();
    }

    return this.save({
      score: Math.round(clamp01(combinedProbability) * 100),
      featureScore: Math.round(featureProbability * 100),
      modelScore: modelProbability === null ? null : Math.round(modelProbability * 100),
      baselineProgress: 1,
      baselineReady: true,
      qualityAccepted: true,
      source: modelProbability === null ? 'spectral-only' : 'wearable-fusion',
      thetaBetaRatio: Math.exp(features.thetaBeta),
      slowFastRatio: Math.exp(features.slowFast),
      baselineThetaBetaRatio: this.baselineRatio()
    });
  }

  reset(): void {
    this.baseline = [];
    this.recentEvidence = [];
    this.lastTimestamp = -Infinity;
    this.lastSnapshot = null;
  }

  private baselineRatio(): number | null {
    return this.baseline.length > 0
      ? Math.exp(median(this.baseline.map((item) => item.thetaBeta)))
      : null;
  }

  private save(snapshot: WearableDrowsinessSnapshot): WearableDrowsinessSnapshot {
    this.lastSnapshot = snapshot;
    return snapshot;
  }
}

export function createWearableDrowsinessSnapshot(): WearableDrowsinessSnapshot {
  return {
    score: 0,
    featureScore: null,
    modelScore: null,
    baselineProgress: 0,
    baselineReady: false,
    qualityAccepted: false,
    source: 'v025-fallback',
    thetaBetaRatio: 0,
    slowFastRatio: 0,
    baselineThetaBetaRatio: null
  };
}

function extractFeatures(metrics: SleepMetrics): FeatureVector | null {
  const theta = Math.max(1e-6, metrics.thetaRelative);
  const alpha = Math.max(1e-6, metrics.alphaRelative);
  const beta = Math.max(1e-6, metrics.betaRelative);
  const vector = {
    thetaBeta: Math.log(theta / beta),
    slowFast: Math.log((theta + alpha) / beta),
    thetaAlpha: Math.log(theta / alpha)
  };
  return Object.values(vector).every(Number.isFinite) ? vector : null;
}

function directionalEvidence(current: FeatureVector, baseline: FeatureVector[]): number {
  const keys: Array<keyof FeatureVector> = ['thetaBeta', 'slowFast', 'thetaAlpha'];
  const weights = [0.45, 0.35, 0.2];
  return keys.reduce((sum, key, index) => {
    const values = baseline.map((item) => item[key]);
    const center = median(values);
    const scale = Math.max(0.2, quantile(values, 0.75) - quantile(values, 0.25));
    return sum + weights[index] * Math.max(0, (current[key] - center) / scale);
  }, 0);
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
