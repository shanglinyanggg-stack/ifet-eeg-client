// v1.0.21 四通道配对眨眼算法（仅作 PC 服务不可用时的保守降级路径）：
// - EEG1+EEG2 为主配对；EEG3+EEG4 只在主配对同步响应且自身质量正常时补充
// - 校准 = 3 秒安静背景 + 10 秒连续自然眨眼；中心/尺度校准后冻结
// - 因果 3 阶 Butterworth 0.5-8Hz SOS（与 scipy butter(3, bandpass, fs=100) 系数一致）
// - 丢包：invalid 后 0.20s 保护窗不追溯，连续 0.35s 才清空手势，可按节律补偿 1 次
// - 手势：3 次降音量 / 5 次升音量，五次优先，冷却 0.60s
// - 基线健康监测：连续 3 次超限置 stale；稳定安静窗连续 3 次通过后自动重建并恢复
export type BlinkGesture = 'volume-down' | 'volume-up';
export type LocalBlinkCalibrationStatus = 'idle' | 'running' | 'complete' | 'failed';

export interface BlinkGestureSnapshot {
  count: number;
  lastBlinkMs: number | null;
  confirmationRemainingMs: number;
  calibrationStatus: LocalBlinkCalibrationStatus;
  calibrationProgress: number;
  calibrationFailureReason: string | null;
  calibrationPeakCount: number;
  calibrationConsensus: number;
  enabledPairs: Array<readonly [number, number]>;
  baselineStale: boolean;
  baselineRecoveryProgress: number;
  baselineRecoveries: number;
  baselineHealthChecks: number;
  adaptiveBaselineUpdates: number;
  runtimeDisabledPairs: Array<readonly [number, number]>;
  singleChannelRejections: number;
  invalidGapRejections: number;
  gapRecoveries: number;
}

interface PendingCandidate {
  dueMs: number;
  peakMs: number;
  amplitude: number;
}

const SAMPLE_RATE = 100;
const PAIRS: Array<readonly [number, number]> = [[0, 1], [2, 3]];
const AUXILIARY_PAIR_INDEX = 1;

const QUIET_BASELINE_MS = 3_000;
const BLINK_CALIBRATION_MS = 10_000;
const CANDIDATE_HEIGHT_Z = 2.0;
const CANDIDATE_PROMINENCE_Z = 0.8;
const REFRACTORY_MS = 320;
const WIDTH_MIN_S = 0.025;
const WIDTH_MAX_S = 0.8;
const PAIR_SECONDARY_FLOOR_Z = 2.0;
const PAIR_FUSED_FLOOR_Z = 2.0;
const MIN_PEAKS_PER_PAIR = 5;
const MIN_OVERALL_PEAKS = 5;
const MIN_CONSENSUS = 0.65;
const MIN_MEDIAN_STRENGTH_Z = 3.0;

const INVALID_GUARD_MS = 200;
const GAP_RESET_MS = 350;
const POST_CALIBRATION_GUARD_MS = 1_500;

const GESTURE_WINDOW_MS = 7_000;
const GESTURE_MIN_INTERVAL_MS = 160;
const GESTURE_MAX_INTERVAL_MS = 1_400;
const GESTURE_ADAPTIVE_MAX_INTERVAL_MS = 1_800;
const GESTURE_MAX_JITTER_MS = 450;
const AMPLITUDE_RATIO_MIN = 0.05;
const AMPLITUDE_RATIO_MAX = 25.0;
const WEAK_FOURTH_TAIL_RATIO = 0.55;
const GESTURE_END_GAP_MS = 2_050;
const GESTURE_COOLDOWN_MS = 600;
const GAP_RECOVERY_RATIO_MIN = 1.65;
const GAP_RECOVERY_RATIO_MAX = 2.6;

const MOTION_WINDOW_MS = 1_500;
const MOTION_STD_FLOOR = 250;
const MOTION_STD_CEILING = 2_000;

const HEALTH_MEMORY_MS = 8_000;
const HEALTH_MINIMUM_MS = 3_000;
const HEALTH_UPDATE_MS = 1_000;
const HEALTH_SCALE_RATIO_MIN = 0.1;
const HEALTH_SCALE_RATIO_MAX = 2.5;
const HEALTH_CENTER_SHIFT_Z_MAX = 2.5;
const HEALTH_FAILURES_REQUIRED = 3;
const HEALTH_RECOVERY_CHECKS_REQUIRED = 3;
const HEALTH_RECOVERY_SCALE_RATIO_MAX = 1.75;
const HEALTH_RECOVERY_CENTER_SHIFT_Z_MAX = 1.5;
const HEALTH_RECOVERY_OUTLIER_FRACTION_MAX = 0.08;
const AUXILIARY_NOISE_RATIO_MAX = 1.75;
const AUXILIARY_RELATIVE_NOISE_RATIO = 1.5;

// scipy.signal.butter(3, (0.5, 8.0), btype="bandpass", fs=100, output="sos")
const BLINK_SOS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0.0085986860863219, 0.0171973721726439, 0.0085986860863219, 1, -1.4543775493164128, 0.6486481863763403],
  [1, 0, -1, 1, -1.5998427471499066, 0.6128007881399319],
  [1, -2, 1, 1, -1.9702236431403235, 0.9712478559942448]
];

class SosFilter {
  private readonly xHistory = new Float64Array(BLINK_SOS.length * 2);
  private readonly yHistory = new Float64Array(BLINK_SOS.length * 2);

  push(value: number): number {
    let output = value;
    for (let section = 0; section < BLINK_SOS.length; section += 1) {
      const [b0, b1, b2, , a1, a2] = BLINK_SOS[section];
      const x1 = this.xHistory[section * 2];
      const x2 = this.xHistory[section * 2 + 1];
      const y1 = this.yHistory[section * 2];
      const y2 = this.yHistory[section * 2 + 1];
      const next = b0 * output + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      this.xHistory[section * 2 + 1] = x1;
      this.xHistory[section * 2] = output;
      this.yHistory[section * 2 + 1] = y1;
      this.yHistory[section * 2] = next;
      output = next;
    }
    return output;
  }

  reset(): void {
    this.xHistory.fill(0);
    this.yHistory.fill(0);
  }
}

export class BlinkGestureDetector {
  private readonly filters = [new SosFilter(), new SosFilter(), new SosFilter(), new SosFilter()];
  private readonly centers = [0, 0, 0, 0];
  private readonly scales = [1, 1, 1, 1];
  private readonly scaleRatios = [1, 1, 1, 1];
  private thresholdZ = 3.5;
  private calibrationStatus: LocalBlinkCalibrationStatus = 'idle';
  private calibrationStartedMs: number | null = null;
  private calibrationValues: number[][] = [[], [], [], []];
  private calibrationMotion: number[] = [];
  private calibrationPeakCount = 0;
  private calibrationConsensus = 0;
  private calibrationStrengthZ: number | null = null;
  private calibrationIntervalMs: number | null = null;
  private calibrationFailureReason: string | null = null;
  private motionStdThreshold = MOTION_STD_FLOOR;
  private enabledPairs: Array<readonly [number, number]> = [];
  private readonly lastValidRaw = [0, 0, 0, 0];
  private hasValidRaw = false;
  private scorePrev2 = 0;
  private scorePrev1 = 0;
  private fusedPrev1 = 0;
  private secondaryPrev1 = 0;
  private validPrev1 = true;
  private lastPeakMs = -1e12;
  private lastInvalidMs = -1e12;
  private consecutiveInvalidMs = 0;
  private resumeDetectionMs = Number.POSITIVE_INFINITY;
  private readonly pendingCandidates: PendingCandidate[] = [];
  private readonly blinkTimes: number[] = [];
  private readonly blinkAmplitudes: number[] = [];
  private gestureCooldownUntilMs = -1e12;
  private readonly motionHistory: number[] = [];
  private readonly healthHistory: number[][] = [[], [], [], []];
  private lastHealthUpdateMs = 0;
  private baselineHealthChecks = 0;
  private baselineHealthFailures = 0;
  private baselineStale = false;
  private baselineRecoveryChecks = 0;
  private baselineRecoveries = 0;
  private adaptiveBaselineUpdates = 0;
  private runtimeDisabledPairs: Array<readonly [number, number]> = [];
  private singleChannelRejections = 0;
  private invalidGapRejections = 0;
  private gapRecoveries = 0;
  private emittedGestures: BlinkGesture[] = [];

  beginCalibration(timestampMs = Date.now()): BlinkGestureSnapshot {
    this.calibrationStatus = 'running';
    this.calibrationStartedMs = timestampMs;
    this.calibrationValues = [[], [], [], []];
    this.calibrationMotion = [];
    this.calibrationPeakCount = 0;
    this.calibrationConsensus = 0;
    this.calibrationStrengthZ = null;
    this.calibrationIntervalMs = null;
    this.calibrationFailureReason = null;
    this.enabledPairs = [];
    this.baselineStale = false;
    this.baselineHealthChecks = 0;
    this.baselineHealthFailures = 0;
    this.baselineRecoveryChecks = 0;
    this.baselineRecoveries = 0;
    this.adaptiveBaselineUpdates = 0;
    this.runtimeDisabledPairs = [];
    this.scaleRatios.fill(1);
    this.healthHistory.forEach((history) => history.splice(0));
    this.motionHistory.splice(0);
    this.motionStdThreshold = MOTION_STD_FLOOR;
    this.thresholdZ = 3.5;
    this.lastInvalidMs = -1e12;
    this.consecutiveInvalidMs = 0;
    this.singleChannelRejections = 0;
    this.invalidGapRejections = 0;
    this.gapRecoveries = 0;
    this.clearGesture();
    return this.snapshot(timestampMs);
  }

  push(
    eeg: readonly [number, number, number, number],
    timestampMs: number,
    valid = true,
    motionMagnitude = 0
  ): BlinkGestureSnapshot {
    if (!Number.isFinite(timestampMs)) return this.snapshot();
    const finite = eeg.every((value) => Number.isFinite(value));
    const sampleValid = Boolean(valid && finite);
    if (sampleValid) {
      for (let channel = 0; channel < 4; channel += 1) this.lastValidRaw[channel] = eeg[channel];
      this.hasValidRaw = true;
    }
    const raw = this.hasValidRaw ? this.lastValidRaw : [0, 0, 0, 0];
    const filtered = [
      this.filters[0].push(raw[0]),
      this.filters[1].push(raw[1]),
      this.filters[2].push(raw[2]),
      this.filters[3].push(raw[3])
    ];

    if (Number.isFinite(motionMagnitude)) {
      this.motionHistory.push(Math.abs(motionMagnitude));
      const capacity = Math.round((MOTION_WINDOW_MS / 1000) * SAMPLE_RATE) * 4;
      if (this.motionHistory.length > capacity) {
        this.motionHistory.splice(0, this.motionHistory.length - capacity);
      }
    }

    if (this.calibrationStatus === 'running') {
      for (let channel = 0; channel < 4; channel += 1) {
        this.calibrationValues[channel].push(filtered[channel]);
      }
      if (Number.isFinite(motionMagnitude)) this.calibrationMotion.push(Math.abs(motionMagnitude));
      const elapsed = timestampMs - (this.calibrationStartedMs ?? timestampMs);
      if (elapsed >= QUIET_BASELINE_MS + BLINK_CALIBRATION_MS) this.finishCalibration();
      return this.snapshot(timestampMs);
    }

    if (this.calibrationStatus !== 'complete') return this.snapshot(timestampMs);

    if (!sampleValid) {
      this.lastInvalidMs = timestampMs;
      this.consecutiveInvalidMs += 1000 / SAMPLE_RATE;
      if (this.consecutiveInvalidMs >= GAP_RESET_MS) this.clearGesture();
    } else {
      this.consecutiveInvalidMs = 0;
    }

    const signed = filtered.map((value, channel) => (value - this.centers[channel]) / Math.max(this.scales[channel], 1e-3));
    const standardized = signed.map((value) => Math.abs(value));

    this.updateBaselineHealth(filtered, standardized, sampleValid, timestampMs);
    if (this.baselineStale) {
      this.clearGesture();
      this.pendingCandidates.splice(0);
      return this.snapshot(timestampMs);
    }

    if (timestampMs < this.resumeDetectionMs) {
      this.shiftScores(standardized, sampleValid);
      return this.snapshot(timestampMs);
    }

    const scores = this.pairScores(standardized);
    this.flushDueCandidates(timestampMs);

    const secondaryFloor = this.thresholdZ * 0.6;
    const isLocalMax = this.scorePrev1 >= this.thresholdZ
      && this.scorePrev1 >= this.scorePrev2
      && this.scorePrev1 > scores.fused;
    if (isLocalMax && timestampMs - 10 - this.lastPeakMs >= REFRACTORY_MS) {
      const peakMs = timestampMs - 10;
      this.lastPeakMs = peakMs;
      const transportValid = this.validPrev1 && peakMs - this.lastInvalidMs >= INVALID_GUARD_MS;
      const dualValid = transportValid && this.secondaryPrev1 >= secondaryFloor && this.fusedPrev1 >= this.thresholdZ;
      if (!transportValid) {
        this.invalidGapRejections += 1;
      } else if (!dualValid) {
        this.singleChannelRejections += 1;
      } else {
        this.pendingCandidates.push({
          dueMs: peakMs + INVALID_GUARD_MS,
          peakMs,
          amplitude: this.fusedPrev1
        });
      }
    }
    this.shiftScores(standardized, sampleValid);
    this.finalizeGesture(timestampMs);
    return this.snapshot(timestampMs);
  }

  poll(timestampMs: number): BlinkGesture | null {
    this.flushDueCandidates(timestampMs);
    this.finalizeGesture(timestampMs);
    return this.emittedGestures.shift() ?? null;
  }

  snapshot(timestampMs = Date.now()): BlinkGestureSnapshot {
    const progress = this.calibrationStatus === 'complete'
      ? 1
      : this.calibrationStatus === 'running' && this.calibrationStartedMs !== null
        ? clamp01((timestampMs - this.calibrationStartedMs) / (QUIET_BASELINE_MS + BLINK_CALIBRATION_MS))
        : 0;
    const remaining = this.blinkTimes.length === 0
      ? 0
      : Math.max(0, this.gestureEndGapLimitMs() - (timestampMs - this.blinkTimes[this.blinkTimes.length - 1]));
    return {
      count: this.blinkTimes.length,
      lastBlinkMs: this.blinkTimes.length === 0 ? null : this.blinkTimes[this.blinkTimes.length - 1],
      confirmationRemainingMs: remaining,
      calibrationStatus: this.calibrationStatus,
      calibrationProgress: progress,
      calibrationFailureReason: this.calibrationFailureReason,
      calibrationPeakCount: this.calibrationPeakCount,
      calibrationConsensus: this.calibrationConsensus,
      enabledPairs: this.enabledPairs.map((pair) => [pair[0], pair[1]] as const),
      baselineStale: this.baselineStale,
      baselineRecoveryProgress: this.baselineStale
        ? clamp01(this.baselineRecoveryChecks / HEALTH_RECOVERY_CHECKS_REQUIRED)
        : 0,
      baselineRecoveries: this.baselineRecoveries,
      baselineHealthChecks: this.baselineHealthChecks,
      adaptiveBaselineUpdates: this.adaptiveBaselineUpdates,
      runtimeDisabledPairs: this.runtimeDisabledPairs.map((pair) => [pair[0], pair[1]] as const),
      singleChannelRejections: this.singleChannelRejections,
      invalidGapRejections: this.invalidGapRejections,
      gapRecoveries: this.gapRecoveries
    };
  }

  reset(): void {
    this.filters.forEach((filter) => filter.reset());
    this.centers.fill(0);
    this.scales.fill(1);
    this.scaleRatios.fill(1);
    this.thresholdZ = 3.5;
    this.calibrationStatus = 'idle';
    this.calibrationStartedMs = null;
    this.calibrationValues = [[], [], [], []];
    this.calibrationMotion = [];
    this.calibrationPeakCount = 0;
    this.calibrationConsensus = 0;
    this.calibrationStrengthZ = null;
    this.calibrationIntervalMs = null;
    this.calibrationFailureReason = null;
    this.motionStdThreshold = MOTION_STD_FLOOR;
    this.enabledPairs = [];
    this.hasValidRaw = false;
    this.lastValidRaw.fill(0);
    this.scorePrev2 = 0;
    this.scorePrev1 = 0;
    this.fusedPrev1 = 0;
    this.secondaryPrev1 = 0;
    this.validPrev1 = true;
    this.lastPeakMs = -1e12;
    this.lastInvalidMs = -1e12;
    this.consecutiveInvalidMs = 0;
    this.resumeDetectionMs = Number.POSITIVE_INFINITY;
    this.pendingCandidates.splice(0);
    this.gestureCooldownUntilMs = -1e12;
    this.motionHistory.splice(0);
    this.healthHistory.forEach((history) => history.splice(0));
    this.lastHealthUpdateMs = 0;
    this.baselineHealthChecks = 0;
    this.baselineHealthFailures = 0;
    this.baselineStale = false;
    this.baselineRecoveryChecks = 0;
    this.baselineRecoveries = 0;
    this.adaptiveBaselineUpdates = 0;
    this.runtimeDisabledPairs = [];
    this.singleChannelRejections = 0;
    this.invalidGapRejections = 0;
    this.gapRecoveries = 0;
    this.emittedGestures = [];
    this.clearGesture();
  }

  private pairScores(standardized: readonly number[]): { fused: number; secondary: number } {
    const scorePair = ([a, b]: readonly [number, number]) => {
      const primary = Math.max(standardized[a], standardized[b]);
      const secondary = Math.min(standardized[a], standardized[b]);
      return { fused: Math.sqrt(Math.max(0, primary * secondary)), secondary };
    };
    const primaryPair = PAIRS[0];
    const auxiliaryPair = PAIRS[AUXILIARY_PAIR_INDEX];
    const primaryEnabled = this.enabledPairs.some(([a, b]) => a === primaryPair[0] && b === primaryPair[1]);
    const auxiliaryEnabled = this.enabledPairs.some(([a, b]) => a === auxiliaryPair[0] && b === auxiliaryPair[1]);
    if (!primaryEnabled) return auxiliaryEnabled ? scorePair(auxiliaryPair) : { fused: 0, secondary: 0 };

    const primary = scorePair(primaryPair);
    if (!auxiliaryEnabled || this.auxiliaryPairIsNoisy()) return primary;
    const auxiliary = scorePair(auxiliaryPair);
    if (auxiliary.fused <= primary.fused || primary.secondary < PAIR_SECONDARY_FLOOR_Z) return primary;
    return {
      fused: auxiliary.fused,
      secondary: Math.min(auxiliary.secondary, primary.secondary)
    };
  }

  private auxiliaryPairIsNoisy(): boolean {
    const primaryRatio = Math.max(1e-6, (this.scaleRatios[0] + this.scaleRatios[1]) / 2);
    const auxiliaryRatio = (this.scaleRatios[2] + this.scaleRatios[3]) / 2;
    return auxiliaryRatio > AUXILIARY_NOISE_RATIO_MAX
      && auxiliaryRatio > primaryRatio * AUXILIARY_RELATIVE_NOISE_RATIO;
  }

  private shiftScores(standardized: readonly number[], valid: boolean): void {
    const scores = this.pairScores(standardized);
    this.scorePrev2 = this.scorePrev1;
    this.scorePrev1 = scores.fused;
    this.fusedPrev1 = scores.fused;
    this.secondaryPrev1 = scores.secondary;
    this.validPrev1 = valid;
  }

  private flushDueCandidates(timestampMs: number): void {
    while (this.pendingCandidates.length > 0 && this.pendingCandidates[0].dueMs <= timestampMs) {
      const candidate = this.pendingCandidates.shift()!;
      if (this.motionOk()) this.registerBlink(candidate.peakMs, candidate.amplitude);
    }
  }

  private finishCalibration(): void {
    const quietSamples = Math.round((QUIET_BASELINE_MS / 1000) * SAMPLE_RATE);
    const quiet = this.calibrationValues.map((values) => values.slice(0, quietSamples));
    const blink = this.calibrationValues.map((values) => values.slice(quietSamples));
    for (let channel = 0; channel < 4; channel += 1) {
      const values = quiet[channel];
      const std = standardDeviation(values);
      const center = median(values);
      this.centers[channel] = center;
      this.scales[channel] = robustScaleV13(values, center, Math.max(std * 0.05, 1e-3));
    }
    const standardized = blink.map((values, channel) =>
      values.map((value) => Math.abs((value - this.centers[channel]) / Math.max(this.scales[channel], 1e-3)))
    );
    const pairData = PAIRS.map(([a, b]) => {
      const primary = standardized[a].map((value, index) => Math.max(value, standardized[b][index]));
      const secondary = standardized[a].map((value, index) => Math.min(value, standardized[b][index]));
      const fused = primary.map((value, index) => Math.sqrt(Math.max(0, value * secondary[index])));
      return { primary, secondary, fused };
    });
    const winning = pairData[0].fused.map((_, index) =>
      pairData.reduce((best, pair, pairIndex) => (pair.fused[index] > pairData[best].fused[index] ? pairIndex : best), 0)
    );
    const fusedScores = winning.map((pairIndex, index) => pairData[pairIndex].fused[index]);

    const candidates = findCalibrationPeaks(fusedScores);
    const pairSupport = PAIRS.map((_, pairIndex) =>
      candidates.map(
        (peak) => pairData[pairIndex].secondary[peak] >= PAIR_SECONDARY_FLOOR_Z && pairData[pairIndex].fused[peak] >= PAIR_FUSED_FLOOR_Z
      )
    );
    const enabled = PAIRS.filter((_, pairIndex) =>
      pairSupport[pairIndex].filter(Boolean).length >= MIN_PEAKS_PER_PAIR
    );
    const validPeaks = candidates.filter((_, peakIndex) =>
      enabled.some((_, localIndex) => pairSupport[PAIRS.indexOf(enabled[localIndex])][peakIndex])
    );

    this.calibrationPeakCount = validPeaks.length;
    this.calibrationConsensus = validPeaks.length / Math.max(1, candidates.length);
    this.calibrationStatus = 'failed';

    if (validPeaks.length < MIN_OVERALL_PEAKS) {
      this.calibrationFailureReason = 'insufficient_dual_channel_peaks';
      return;
    }
    const strengths = validPeaks.map((peak) => fusedScores[peak]);
    this.calibrationStrengthZ = median(strengths);
    if (validPeaks.length >= 2) {
      const intervals = validPeaks.slice(1).map((peak, index) => (peak - validPeaks[index]) * (1000 / SAMPLE_RATE));
      this.calibrationIntervalMs = median(intervals);
    }
    if (
      this.calibrationConsensus < MIN_CONSENSUS
      || (this.calibrationStrengthZ ?? 0) < MIN_MEDIAN_STRENGTH_Z
    ) {
      this.calibrationFailureReason = this.calibrationConsensus < MIN_CONSENSUS
        ? 'insufficient_dual_channel_consensus'
        : 'calibration_quality_gate_failed';
      return;
    }

    this.enabledPairs = enabled;
    const auxiliaryEnabled = enabled.some(([a, b]) => a === PAIRS[AUXILIARY_PAIR_INDEX][0] && b === PAIRS[AUXILIARY_PAIR_INDEX][1]);
    const q25 = quantile(strengths, 0.25);
    this.thresholdZ = auxiliaryEnabled
      ? clamp(q25 * 0.3, 2.5, 3.25)
      : clamp(q25 * 0.45, 2.5, 6.0);

    if (this.calibrationMotion.length >= 2) {
      const window = Math.max(2, Math.round((MOTION_WINDOW_MS / 1000) * SAMPLE_RATE));
      const step = Math.max(1, Math.floor(window / 2));
      const stds: number[] = [];
      for (let start = 0; start + window <= this.calibrationMotion.length; start += step) {
        stds.push(standardDeviation(this.calibrationMotion.slice(start, start + window)));
      }
      if (stds.length > 0) {
        const learned = quantile(stds, 0.9) * 2.5;
        this.motionStdThreshold = clamp(Math.max(MOTION_STD_FLOOR, learned), MOTION_STD_FLOOR, MOTION_STD_CEILING);
      }
    }

    for (let channel = 0; channel < 4; channel += 1) {
      this.healthHistory[channel] = quiet[channel].slice();
    }
    this.lastHealthUpdateMs = (this.calibrationStartedMs ?? 0) + QUIET_BASELINE_MS + BLINK_CALIBRATION_MS;
    this.calibrationStatus = 'complete';
    this.calibrationFailureReason = null;
    this.clearGesture();
    this.pendingCandidates.splice(0);
    this.resumeDetectionMs = this.lastHealthUpdateMs + POST_CALIBRATION_GUARD_MS;
  }

  private registerBlink(timestampMs: number, amplitude: number): void {
    if (timestampMs < this.gestureCooldownUntilMs) return;
    if (amplitude < this.thresholdZ) return;
    if (this.blinkTimes.length > 0) {
      let interval = timestampMs - this.blinkTimes[this.blinkTimes.length - 1];
      if (interval < this.gestureMinIntervalLimitMs()) return;
      const expected = this.calibrationIntervalMs;
      if (
        this.blinkTimes.length >= 2
        && expected !== null
        && expected > 0
        && this.blinkTimes[this.blinkTimes.length - 1] < this.lastInvalidMs
        && this.lastInvalidMs < timestampMs
        && interval / expected >= GAP_RECOVERY_RATIO_MIN
        && interval / expected <= GAP_RECOVERY_RATIO_MAX
      ) {
        const recoveredTime = this.blinkTimes[this.blinkTimes.length - 1] + interval / 2;
        const recoveredAmplitude = Math.sqrt(Math.max(0, this.blinkAmplitudes[this.blinkAmplitudes.length - 1] * amplitude));
        this.blinkTimes.push(recoveredTime);
        this.blinkAmplitudes.push(recoveredAmplitude);
        this.gapRecoveries += 1;
        interval = timestampMs - recoveredTime;
      }
      if (interval > this.gestureMaxIntervalLimitMs()) this.clearGesture();
    }
    if (this.blinkTimes.length > 0 && timestampMs - this.blinkTimes[this.blinkTimes.length - 1] > GESTURE_WINDOW_MS) {
      this.clearGesture();
    }
    if (this.blinkAmplitudes.length >= 2) {
      const reference = median(this.blinkAmplitudes);
      const ratio = amplitude / Math.max(reference, 1e-9);
      if (ratio < AMPLITUDE_RATIO_MIN || ratio > AMPLITUDE_RATIO_MAX) return;
    }
    this.blinkTimes.push(timestampMs);
    this.blinkAmplitudes.push(amplitude);
    while (this.blinkTimes.length > 0 && timestampMs - this.blinkTimes[0] > GESTURE_WINDOW_MS) {
      this.blinkTimes.shift();
      this.blinkAmplitudes.shift();
    }
    if (this.blinkTimes.length >= 3) {
      const intervals = this.blinkTimes.slice(1).map((time, index) => time - this.blinkTimes[index]);
      const jitter = Math.max(...intervals) - Math.min(...intervals);
      if (jitter > GESTURE_MAX_JITTER_MS) {
        if (this.blinkTimes.length === 4) {
          const reference = median(this.blinkAmplitudes.slice(0, 3));
          const weakFourth = this.blinkAmplitudes[3] / Math.max(reference, 1e-9) < WEAK_FOURTH_TAIL_RATIO;
          if (weakFourth) {
            this.blinkTimes.pop();
            this.blinkAmplitudes.pop();
            return;
          }
        }
        const latestTime = this.blinkTimes[this.blinkTimes.length - 1];
        const latestAmplitude = this.blinkAmplitudes[this.blinkAmplitudes.length - 1];
        this.clearGesture();
        this.blinkTimes.push(latestTime);
        this.blinkAmplitudes.push(latestAmplitude);
        return;
      }
    }
    if (this.blinkTimes.length >= 5) {
      if (this.motionOk()) this.emittedGestures.push('volume-up');
      this.clearGesture();
      this.gestureCooldownUntilMs = timestampMs + GESTURE_COOLDOWN_MS;
    }
  }

  private finalizeGesture(timestampMs: number): void {
    if (this.blinkTimes.length === 0) return;
    const gap = timestampMs - this.blinkTimes[this.blinkTimes.length - 1];
    if (gap < this.gestureEndGapLimitMs()) return;
    const count = this.blinkTimes.length;
    let weakFourthTail = false;
    if (count === 4) {
      const reference = median(this.blinkAmplitudes.slice(0, 3));
      weakFourthTail = this.blinkAmplitudes[3] / Math.max(reference, 1e-9) < WEAK_FOURTH_TAIL_RATIO;
    }
    if ((count === 3 || weakFourthTail) && timestampMs >= this.gestureCooldownUntilMs && this.motionOk()) {
      this.emittedGestures.push('volume-down');
      this.gestureCooldownUntilMs = timestampMs + GESTURE_COOLDOWN_MS;
    }
    this.clearGesture();
  }

  private updateBaselineHealth(
    filtered: readonly number[],
    standardized: readonly number[],
    valid: boolean,
    timestampMs: number
  ): void {
    if (this.calibrationStatus !== 'complete' || !this.motionOk()) return;
    const dualFloor = this.thresholdZ * 0.6;
    let maxSecondary = 0;
    for (const [a, b] of this.enabledPairs) {
      maxSecondary = Math.max(maxSecondary, Math.min(standardized[a], standardized[b]));
    }
    if (valid && (this.baselineStale || maxSecondary < dualFloor)) {
      for (let channel = 0; channel < 4; channel += 1) {
        this.healthHistory[channel].push(filtered[channel]);
        const capacity = Math.round((HEALTH_MEMORY_MS / 1000) * SAMPLE_RATE);
        if (this.healthHistory[channel].length > capacity) {
          this.healthHistory[channel].splice(0, this.healthHistory[channel].length - capacity);
        }
      }
    }
    if (timestampMs - this.lastHealthUpdateMs < HEALTH_UPDATE_MS) return;
    const minimum = Math.round((HEALTH_MINIMUM_MS / 1000) * SAMPLE_RATE);
    if (this.healthHistory.some((history) => history.length < minimum)) return;

    let healthBad = false;
    const targetCenters = [0, 0, 0, 0];
    const targetScales = [1, 1, 1, 1];
    for (let channel = 0; channel < 4; channel += 1) {
      const values = this.healthHistory[channel];
      const center = median(values);
      const targetScale = robustScaleV13(values, center, 1e-3);
      targetCenters[channel] = center;
      targetScales[channel] = targetScale;
      const currentScale = Math.max(this.scales[channel], 1e-3);
      const ratio = targetScale / currentScale;
      const shiftZ = Math.abs(center - this.centers[channel]) / currentScale;
      this.scaleRatios[channel] = ratio;
      if (ratio < HEALTH_SCALE_RATIO_MIN || ratio > HEALTH_SCALE_RATIO_MAX || shiftZ > HEALTH_CENTER_SHIFT_Z_MAX) {
        healthBad = true;
      }
    }
    this.baselineHealthChecks += 1;
    const auxiliaryNoisy = this.auxiliaryPairIsNoisy();
    this.runtimeDisabledPairs = auxiliaryNoisy ? [PAIRS[AUXILIARY_PAIR_INDEX]] : [];

    if (this.baselineStale) {
      const recoveryStable = this.recoveryWindowIsStable(targetCenters, targetScales);
      this.baselineRecoveryChecks = recoveryStable ? this.baselineRecoveryChecks + 1 : 0;
      if (this.baselineRecoveryChecks >= HEALTH_RECOVERY_CHECKS_REQUIRED) {
        for (let channel = 0; channel < 4; channel += 1) {
          this.centers[channel] = targetCenters[channel];
          this.scales[channel] = Math.max(this.scales[channel], targetScales[channel]);
          this.scaleRatios[channel] = 1;
        }
        this.baselineStale = false;
        this.baselineHealthFailures = 0;
        this.baselineRecoveryChecks = 0;
        this.baselineRecoveries += 1;
        this.adaptiveBaselineUpdates += 1;
        this.resumeDetectionMs = timestampMs + POST_CALIBRATION_GUARD_MS;
        this.clearGesture();
        this.pendingCandidates.splice(0);
      }
      this.lastHealthUpdateMs = timestampMs;
      return;
    }

    this.baselineHealthFailures = healthBad ? this.baselineHealthFailures + 1 : 0;
    if (this.baselineHealthFailures >= HEALTH_FAILURES_REQUIRED) {
      this.baselineStale = true;
      this.clearGesture();
      this.pendingCandidates.splice(0);
    }
    this.lastHealthUpdateMs = timestampMs;
  }

  private recoveryWindowIsStable(targetCenters: readonly number[], targetScales: readonly number[]): boolean {
    for (let channel = 0; channel < 4; channel += 1) {
      const values = this.healthHistory[channel];
      if (values.length < 4) return false;
      const split = Math.floor(values.length / 2);
      const first = values.slice(0, split);
      const second = values.slice(split);
      const firstCenter = median(first);
      const secondCenter = median(second);
      const firstScale = robustScaleV13(first, firstCenter, 1e-3);
      const secondScale = robustScaleV13(second, secondCenter, 1e-3);
      const scaleRatio = Math.max(firstScale, secondScale) / Math.max(1e-3, Math.min(firstScale, secondScale));
      const centerShiftZ = Math.abs(firstCenter - secondCenter) / Math.max(targetScales[channel], 1e-3);
      if (scaleRatio > HEALTH_RECOVERY_SCALE_RATIO_MAX || centerShiftZ > HEALTH_RECOVERY_CENTER_SHIFT_Z_MAX) {
        return false;
      }
    }
    for (const [a, b] of this.enabledPairs) {
      let outliers = 0;
      const length = Math.min(this.healthHistory[a].length, this.healthHistory[b].length);
      for (let index = 0; index < length; index += 1) {
        const za = Math.abs(this.healthHistory[a][index] - targetCenters[a]) / Math.max(targetScales[a], 1e-3);
        const zb = Math.abs(this.healthHistory[b][index] - targetCenters[b]) / Math.max(targetScales[b], 1e-3);
        if (Math.min(za, zb) >= this.thresholdZ * 0.6) outliers += 1;
      }
      if (outliers / Math.max(1, length) > HEALTH_RECOVERY_OUTLIER_FRACTION_MAX) return false;
    }
    return true;
  }

  private motionOk(): boolean {
    if (this.motionHistory.length < 2) return true;
    return standardDeviation(this.motionHistory) <= this.motionStdThreshold;
  }

  private gestureMinIntervalLimitMs(): number {
    const learned = this.calibrationIntervalMs;
    if (learned === null || !Number.isFinite(learned)) return GESTURE_MIN_INTERVAL_MS;
    return Math.max(GESTURE_MIN_INTERVAL_MS, clamp(learned * 0.65, 0, 500));
  }

  private gestureMaxIntervalLimitMs(): number {
    const learned = this.calibrationIntervalMs;
    if (learned === null || !Number.isFinite(learned)) return GESTURE_MAX_INTERVAL_MS;
    return Math.max(GESTURE_MAX_INTERVAL_MS, clamp(learned * 2.25, GESTURE_MAX_INTERVAL_MS, GESTURE_ADAPTIVE_MAX_INTERVAL_MS));
  }

  private gestureEndGapLimitMs(): number {
    return Math.max(GESTURE_END_GAP_MS, this.gestureMaxIntervalLimitMs() + 250);
  }

  private clearGesture(): void {
    this.blinkTimes.splice(0);
    this.blinkAmplitudes.splice(0);
  }
}

// 校准峰检测：高度 ≥2z、prominence ≥0.8z、距离 ≥0.32s、宽度 0.025-0.80s（对齐 scipy find_peaks/peak_widths）
function findCalibrationPeaks(fused: number[]): number[] {
  const n = fused.length;
  const rawPeaks: number[] = [];
  for (let index = 1; index < n - 1; index += 1) {
    if (fused[index] >= CANDIDATE_HEIGHT_Z && fused[index] > fused[index - 1] && fused[index] >= fused[index + 1]) {
      rawPeaks.push(index);
    }
  }
  const withProminence = rawPeaks.filter((peak) => prominence(fused, peak) >= CANDIDATE_PROMINENCE_Z);
  const minDistance = Math.max(1, Math.round((REFRACTORY_MS / 1000) * SAMPLE_RATE));
  const byHeightDesc = [...withProminence].sort((a, b) => fused[b] - fused[a]);
  const selected: number[] = [];
  for (const peak of byHeightDesc) {
    if (selected.every((other) => Math.abs(other - peak) >= minDistance)) selected.push(peak);
  }
  selected.sort((a, b) => a - b);
  const minWidth = Math.max(1, Math.round(WIDTH_MIN_S * SAMPLE_RATE));
  const maxWidth = Math.max(2, Math.round(WIDTH_MAX_S * SAMPLE_RATE));
  return selected.filter((peak) => {
    const width = peakWidthSamples(fused, peak, prominence(fused, peak));
    return width >= minWidth && width <= maxWidth;
  });
}

function prominence(values: number[], peak: number): number {
  const height = values[peak];
  let leftMin = height;
  let left = peak;
  while (left > 0 && values[left] <= height) {
    leftMin = Math.min(leftMin, values[left]);
    if (values[left] > height) break;
    left -= 1;
  }
  let rightMin = height;
  let right = peak;
  while (right < values.length - 1 && values[right] <= height) {
    rightMin = Math.min(rightMin, values[right]);
    if (values[right] > height) break;
    right += 1;
  }
  return height - Math.max(leftMin, rightMin);
}

function peakWidthSamples(values: number[], peak: number, peakProminence: number): number {
  const level = values[peak] - peakProminence * 0.5;
  let left = peak;
  while (left > 0 && values[left] > level) left -= 1;
  let right = peak;
  while (right < values.length - 1 && values[right] > level) right += 1;
  return right - left;
}

// v1.0.21 保守降级尺度：max(1.4826*MAD, (Q90-Q10)/2.5631, minimum)
function robustScaleV13(values: number[], center: number, minimum: number): number {
  if (values.length === 0) return minimum;
  const deviations = values.map((value) => Math.abs(value - center));
  const mad = 1.4826 * median(deviations);
  const q = (quantile(values, 0.9) - quantile(values, 0.1)) / 2.5631;
  return Math.max(mad, q, minimum);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(q, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[Math.min(sorted.length - 1, lower + 1)] - sorted[lower]) * fraction;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}
