import type { TimedValue } from './dsp';
import type { SleepDeltaArtifactContext } from './delta-artifact-filter';

export interface ThetaArtifactFilterOptions {
  lowHz?: number;
}

/**
 * IQR-adaptive Theta cleaner used by spectral shares and drowsiness metrics.
 *
 * Blink and motion evidence is detected on the raw four-channel EEG and IMU,
 * then shifted across the complete causal FIR impulse response. This matters
 * because the default 4-7 Hz FIR has about 1.65 s group delay and can ring for
 * roughly 3.3 s after a short blink. Only locally excessive Theta energy inside
 * an evidence window is bridged, so continuous physiological Theta is retained.
 */
export function cleanSleepThetaWave(
  thetaValues: TimedValue[],
  rawValues: TimedValue[],
  sampleRate = 100,
  context?: SleepDeltaArtifactContext,
  options: ThetaArtifactFilterOptions = {}
): TimedValue[] {
  if (thetaValues.length < Math.max(24, Math.round(sampleRate * 0.8))) return thetaValues;

  const theta = thetaValues.map((point) => point.value);
  const raw = alignToReference(thetaValues, rawValues);
  const envelope = movingRms(theta, Math.max(2, Math.round(sampleRate * 0.1)));
  const envelopeStats = rollingIqrStats(envelope, sampleRate, 0.25, 4);
  const globalEnvelope = distributionStats(envelope);
  const rawTransient = buildRawTransientMask(raw, sampleRate);
  const consensusTransient = buildEegConsensusMask(
    thetaValues,
    context?.eegChannels ?? [],
    sampleRate,
    context?.blinkBaselineStale ?? false
  );
  const motionTransient = buildMotionMask(thetaValues, context?.accelerometer, sampleRate);
  const delaySamples = estimateFirDelaySamples(options.lowHz ?? 4, sampleRate);
  const supportSamples = delaySamples * 2;
  const strongGuard = shiftAndExpandEvidence(
    mergeMasks(consensusTransient, motionTransient),
    delaySamples,
    supportSamples,
    sampleRate
  );
  const singleChannelGuard = shiftAndExpandEvidence(
    rawTransient,
    delaySamples,
    supportSamples,
    sampleRate
  );
  const mask = new Array<boolean>(theta.length).fill(false);

  for (let index = 0; index < theta.length; index += 1) {
    const local = envelopeStats[index];
    // A 3 s FIR ring can occupy more than 25% of a short display window and
    // therefore inflate Q3. Anchor the adaptive ceiling to the median and the
    // quiet lower half (median-Q1); it remains stable until contamination takes
    // over most of the window, while still following electrode-scale drift.
    const quietSpread = Math.max(
      local.median - local.q1,
      globalEnvelope.median - globalEnvelope.q1,
      1e-6
    );
    const elevatedThreshold = local.median + Math.max(
      quietSpread * 4,
      local.median * 0.55,
      globalEnvelope.median * 0.35,
      1e-6
    );
    const extremeThreshold = local.median + Math.max(
      quietSpread * 8,
      local.median * 1.5,
      globalEnvelope.median * 1.25,
      1e-6
    );
    const elevated = envelope[index] > elevatedThreshold;
    const extreme = envelope[index] > extremeThreshold;
    mask[index] = (strongGuard[index] && elevated)
      || (singleChannelGuard[index] && extreme);
  }

  if (context?.blinkArtifactActive) {
    const recentSamples = Math.max(1, Math.round(sampleRate * 0.5));
    for (let index = Math.max(0, mask.length - recentSamples); index < mask.length; index += 1) {
      const local = envelopeStats[index];
      mask[index] ||= envelope[index] > local.q3 + Math.max(local.iqr, local.q3 * 0.25, 1e-6);
    }
  }

  const expanded = expandMask(mask, Math.max(1, Math.round(sampleRate * 0.06)));
  if (!expanded.some(Boolean)) return thetaValues;
  const cleaned = bridgeMaskedSegments(theta, expanded);
  return thetaValues.map((point, index) => ({ ...point, value: cleaned[index] }));
}

function buildRawTransientMask(raw: number[], sampleRate: number): boolean[] {
  const differences = successiveAbsoluteDifferences(raw);
  const stats = rollingIqrStats(differences, sampleRate, 0.25, 3);
  const scale = robustScale(raw);
  return differences.map((difference, index) => {
    const local = stats[index];
    const threshold = local.q3 + Math.max(
      local.iqr * 4.5,
      local.q3 * 2,
      scale * 0.12,
      1e-6
    );
    return difference > threshold;
  });
}

function buildEegConsensusMask(
  reference: TimedValue[],
  channels: TimedValue[][],
  sampleRate: number,
  baselineStale: boolean
): boolean[] {
  const usable = channels.filter((channel) => channel.length >= 24);
  const result = new Array<boolean>(reference.length).fill(false);
  if (usable.length < 2) return result;
  const differences = usable.map((channel) =>
    successiveAbsoluteDifferences(alignToReference(reference, channel))
  );
  const stats = differences.map((values) => rollingIqrStats(values, sampleRate, 0.25, 3));
  const multiplier = baselineStale ? 3 : 4;

  for (let index = 1; index < reference.length; index += 1) {
    let responding = 0;
    for (let channel = 0; channel < differences.length; channel += 1) {
      const local = stats[channel][index];
      const threshold = local.q3 + Math.max(
        local.iqr * multiplier,
        local.q3 * 2,
        1e-6
      );
      if (differences[channel][index] > threshold) responding += 1;
    }
    result[index] = responding >= 2;
  }
  return result;
}

function buildMotionMask(
  reference: TimedValue[],
  accelerometer: SleepDeltaArtifactContext['accelerometer'] | undefined,
  sampleRate: number
): boolean[] {
  const result = new Array<boolean>(reference.length).fill(false);
  if (!accelerometer
    || accelerometer.x.length < 24
    || accelerometer.y.length < 24
    || accelerometer.z.length < 24) return result;
  const x = alignToReference(reference, accelerometer.x);
  const y = alignToReference(reference, accelerometer.y);
  const z = alignToReference(reference, accelerometer.z);
  const jerk = new Array<number>(reference.length).fill(0);
  for (let index = 1; index < jerk.length; index += 1) {
    jerk[index] = Math.hypot(
      x[index] - x[index - 1],
      y[index] - y[index - 1],
      z[index] - z[index - 1]
    );
  }
  const jerkEnergy = movingRms(jerk, Math.max(2, Math.round(sampleRate * 0.12)));
  const sampleStats = rollingIqrStats(jerk, sampleRate, 0.25, 3);
  const energyStats = rollingIqrStats(jerkEnergy, sampleRate, 0.25, 4);
  for (let index = 1; index < jerk.length; index += 1) {
    const local = sampleStats[index];
    const localEnergy = energyStats[index];
    const impulsive = jerk[index] > local.q3
      + Math.max(local.iqr * 3.5, local.q3 * 2, 3);
    const sustained = jerkEnergy[index] > localEnergy.q3
      + Math.max(localEnergy.iqr * 3, localEnergy.q3 * 1.25, 2);
    result[index] = impulsive || sustained;
  }
  return result;
}

function shiftAndExpandEvidence(
  evidence: boolean[],
  delaySamples: number,
  supportSamples: number,
  sampleRate: number
): boolean[] {
  const result = new Array<boolean>(evidence.length).fill(false);
  const preSamples = Math.max(1, Math.round(sampleRate * 0.08));
  const tailSamples = Math.max(1, Math.round(sampleRate * 0.2));
  for (let source = 0; source < evidence.length; source += 1) {
    if (!evidence[source]) continue;
    const start = Math.max(0, source - preSamples);
    // A causal linear-phase FIR responds from the source sample through its
    // full 2*group-delay support, not only at the delayed peak.
    const end = Math.min(
      evidence.length - 1,
      source + Math.max(supportSamples, delaySamples) + tailSamples
    );
    for (let index = start; index <= end; index += 1) result[index] = true;
  }
  return result;
}

function estimateFirDelaySamples(lowHz: number, sampleRate: number): number {
  const safeLow = Math.max(0.1, lowHz);
  const transition = Math.max(0.2, safeLow * 0.25);
  let taps = Math.ceil((3.3 * sampleRate) / transition);
  if (taps % 2 === 0) taps += 1;
  const maxTaps = Math.max(3, Math.floor(4 * sampleRate) * 2 + 1);
  taps = Math.max(3, Math.min(taps, maxTaps));
  return Math.floor((taps - 1) / 2);
}

function movingRms(values: number[], radius: number): number[] {
  const result = new Array<number>(values.length).fill(0);
  const squaredPrefix = new Array<number>(values.length + 1).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    squaredPrefix[index + 1] = squaredPrefix[index] + values[index] * values[index];
  }
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    result[index] = Math.sqrt(Math.max(0, (squaredPrefix[end] - squaredPrefix[start]) / Math.max(1, end - start)));
  }
  return result;
}

function bridgeMaskedSegments(values: number[], mask: boolean[]): number[] {
  const cleaned = [...values];
  const center = median(values);
  let cursor = 0;
  while (cursor < mask.length) {
    if (!mask[cursor]) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < mask.length && mask[cursor]) cursor += 1;
    const end = cursor - 1;
    const left = start > 0 ? cleaned[start - 1] : center;
    const right = cursor < cleaned.length ? cleaned[cursor] : left;
    const span = end - start + 2;
    for (let index = start; index <= end; index += 1) {
      const fraction = (index - start + 1) / span;
      cleaned[index] = left + (right - left) * fraction;
    }
  }
  return cleaned;
}

function expandMask(mask: boolean[], radius: number): boolean[] {
  const result = new Array<boolean>(mask.length).fill(false);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const start = Math.max(0, index - radius);
    const end = Math.min(mask.length - 1, index + radius);
    for (let cursor = start; cursor <= end; cursor += 1) result[cursor] = true;
  }
  return result;
}

function mergeMasks(left: boolean[], right: boolean[]): boolean[] {
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_, index) => Boolean(left[index] || right[index]));
}

function alignToReference(reference: TimedValue[], values: TimedValue[]): number[] {
  if (values.length === 0) return new Array<number>(reference.length).fill(0);
  const byTimestamp = new Map(values.map((point) => [point.timestamp, point.value]));
  let previous = values[0].value;
  return reference.map((point) => {
    const matched = byTimestamp.get(point.timestamp);
    if (matched !== undefined) previous = matched;
    return previous;
  });
}

function successiveAbsoluteDifferences(values: number[]): number[] {
  const result = new Array<number>(values.length).fill(0);
  for (let index = 1; index < values.length; index += 1) {
    result[index] = Math.abs(values[index] - values[index - 1]);
  }
  return result;
}

interface IqrStats {
  q1: number;
  q3: number;
  iqr: number;
  median: number;
}

function rollingIqrStats(
  values: number[],
  sampleRate: number,
  refreshSeconds: number,
  radiusSeconds: number
): IqrStats[] {
  const blockSamples = Math.max(8, Math.round(sampleRate * refreshSeconds));
  const radiusSamples = Math.max(blockSamples, Math.round(sampleRate * radiusSeconds));
  const result = new Array<IqrStats>(values.length);
  for (let blockStart = 0; blockStart < values.length; blockStart += blockSamples) {
    const blockEnd = Math.min(values.length, blockStart + blockSamples);
    const contextStart = Math.max(0, blockStart - radiusSamples);
    const contextEnd = Math.min(values.length, blockEnd + radiusSamples);
    const stats = distributionStats(values.slice(contextStart, contextEnd));
    for (let index = blockStart; index < blockEnd; index += 1) result[index] = stats;
  }
  return result;
}

function distributionStats(values: number[]): IqrStats {
  const sorted = [...values].sort((left, right) => left - right);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  return {
    q1,
    q3,
    iqr: Math.max(1e-9, q3 - q1),
    median: quantileSorted(sorted, 0.5)
  };
}

function robustScale(values: number[]): number {
  const center = median(values);
  return Math.max(1e-9, median(values.map((value) => Math.abs(value - center))) * 1.4826);
}

function quantileSorted(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
