import { EEG_SAMPLE_RATE, type TimedValue } from './dsp';

export interface SlowWaveGateSnapshot {
  weight: number;
  currentLevel: number;
  awakeBaseline: number | null;
}

/**
 * Converts absolute 0.5-2 Hz amplitude into excess slow-wave activity above a
 * continuously learned awake baseline. This prevents smooth electrode drift
 * from dominating the Delta share while keeping a rising NREM slow wave.
 */
export class AdaptiveSlowWaveGate {
  private awakeBaseline: number | null = null;
  private lastTimestamp = -Infinity;
  private lastWeightTimestamp = -Infinity;
  private displayWeight: number | null = null;
  private streamKey = '';

  update(
    values: TimedValue[],
    options: { stage?: string; quiet?: boolean; streamKey?: string } = {}
  ): SlowWaveGateSnapshot {
    if (options.streamKey !== undefined && options.streamKey !== this.streamKey) {
      this.streamKey = options.streamKey;
      this.awakeBaseline = null;
      this.lastTimestamp = -Infinity;
      this.lastWeightTimestamp = -Infinity;
      this.displayWeight = null;
    }
    if (values.length === 0) {
      return { weight: 0, currentLevel: 0, awakeBaseline: this.awakeBaseline };
    }

    const recent = values.slice(-EEG_SAMPLE_RATE * 5);
    const currentLevel = robustLevel(recent.map((point) => point.value));
    const timestamp = recent[recent.length - 1].timestamp;
    const stage = (options.stage ?? '').trim().toUpperCase();
    const awakeOrWarmup = isAwakeOrWarmup(stage);
    const quiet = options.quiet !== false;

    if (timestamp > this.lastTimestamp && quiet && awakeOrWarmup && currentLevel > 1e-9) {
      if (this.awakeBaseline === null) {
        this.awakeBaseline = currentLevel;
      } else if (currentLevel <= this.awakeBaseline * 1.35) {
        // About 2% per new display window: follows slow electrode drift but
        // freezes immediately when genuine/excess slow activity rises.
        this.awakeBaseline = this.awakeBaseline * 0.98 + currentLevel * 0.02;
      }
      this.lastTimestamp = timestamp;
    }

    let targetWeight: number;
    if (this.awakeBaseline === null || this.awakeBaseline <= 1e-9) {
      targetWeight = stage.includes('NREM') || stage.includes('N3') ? 0.35 : 0.05;
    } else {
      const ratio = currentLevel / this.awakeBaseline;
      targetWeight = clamp01((ratio - 1.15) / 0.65);
    }

    const limits = stageWeightLimits(stage);
    targetWeight = Math.max(limits.min, Math.min(limits.max, targetWeight));
    if (this.displayWeight === null) {
      this.displayWeight = targetWeight;
    } else if (timestamp > this.lastWeightTimestamp) {
      // Genuine slow-wave growth should appear promptly, while a single
      // changing window must not collapse the whole Delta trace to zero.
      const smoothing = targetWeight > this.displayWeight ? 0.85 : 0.12;
      this.displayWeight += (targetWeight - this.displayWeight) * smoothing;
      this.displayWeight = Math.max(limits.min, Math.min(limits.max, this.displayWeight));
    }
    this.lastWeightTimestamp = Math.max(this.lastWeightTimestamp, timestamp);

    return { weight: this.displayWeight, currentLevel, awakeBaseline: this.awakeBaseline };
  }

  reset(): void {
    this.awakeBaseline = null;
    this.lastTimestamp = -Infinity;
    this.lastWeightTimestamp = -Infinity;
    this.displayWeight = null;
    this.streamKey = '';
  }
}

export function applySlowWaveGate(values: TimedValue[], weight: number): TimedValue[] {
  const safeWeight = clamp01(weight);
  if (safeWeight >= 0.999) return values;
  return values.map((point) => ({ ...point, value: point.value * safeWeight }));
}

function robustLevel(values: number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center))) * 1.4826;
}

function isAwakeOrWarmup(stage: string): boolean {
  return isExplicitAwake(stage) || isWarmup(stage) || stage.includes('本地降级');
}

function isExplicitAwake(stage: string): boolean {
  return stage === 'W' || stage.startsWith('W ') || stage.includes('WAKE') || stage.includes('清醒');
}

function isWarmup(stage: string): boolean {
  return stage.length === 0
    || stage.includes('预热')
    || stage.includes('等待')
    || stage.includes('连接中');
}

function isRem(stage: string): boolean {
  return stage === 'REM' || stage.startsWith('REM ');
}

function stageWeightLimits(stage: string): { min: number; max: number } {
  // A 2% amplitude residual is only 0.04% in power, keeping awake Delta tiny
  // without producing a mathematically flat/zero signal.
  if (isExplicitAwake(stage)) return { min: 0.02, max: 0.05 };
  if (isWarmup(stage)) return { min: 0.02, max: 0.08 };
  if (isRem(stage)) return { min: 0.02, max: 0.1 };
  if (!stage.includes('NREM') && !stage.includes('N3')) return { min: 0.02, max: 0.2 };
  return { min: 0.02, max: 1 };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
