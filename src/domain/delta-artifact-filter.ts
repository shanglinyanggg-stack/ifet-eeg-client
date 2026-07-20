import type { TimedValue } from './dsp';

export interface SleepDeltaArtifactContext {
  eegChannels?: TimedValue[][];
  accelerometer?: {
    x: TimedValue[];
    y: TimedValue[];
    z: TimedValue[];
  };
  blinkArtifactActive?: boolean;
  blinkBaselineStale?: boolean;
  blinkTemplateReady?: boolean;
  blinkTemplateCorrelation?: number | null;
}

/**
 * Display-only Delta cleaner for sleep slow-wave inspection.
 *
 * It detects short, steep transients from the raw EEG derivative and the
 * band-limited slow-wave envelope with rolling IQR thresholds, expands a
 * blink/artifact guard window, then bridges only those windows. Gradual
 * 0.5-2 Hz sleep slow waves are preserved even when their amplitude is high.
 */
export function cleanSleepDeltaWave(
  deltaValues: TimedValue[],
  rawValues: TimedValue[],
  sampleRate = 100,
  context?: SleepDeltaArtifactContext
): TimedValue[] {
  if (deltaValues.length < 12 || rawValues.length < 12) return deltaValues;

  const rawByTimestamp = new Map(rawValues.map((point) => [point.timestamp, point.value]));
  const raw = deltaValues.map((point) => rawByTimestamp.get(point.timestamp) ?? point.value);
  const delta = deltaValues.map((point) => point.value);
  const rawDiff = successiveAbsoluteDifferences(raw);
  const deltaDiff = successiveAbsoluteDifferences(delta);
  const deltaCenter = median(delta);
  const deltaScale = robustScale(delta, deltaCenter);
  const deltaAmplitude = delta.map((value) => Math.abs(value - deltaCenter));
  const rawDiffStats = rollingIqrStats(rawDiff, sampleRate);
  const deltaDiffStats = rollingIqrStats(deltaDiff, sampleRate);
  const deltaAmplitudeStats = rollingIqrStats(deltaAmplitude, sampleRate);
  const eegConsensusMask = buildEegConsensusMask(
    deltaValues,
    context?.eegChannels ?? [],
    sampleRate,
    context?.blinkBaselineStale ?? false
  );
  const motionMask = buildMotionMask(deltaValues, context?.accelerometer, sampleRate);

  if (deltaScale <= 1e-9) return deltaValues;

  const mask = new Array<boolean>(delta.length).fill(false);

  for (let index = 1; index < delta.length; index += 1) {
    const amplitude = Math.abs(delta[index] - deltaCenter);
    const rawStats = rawDiffStats[index];
    const slopeStats = deltaDiffStats[index];
    const amplitudeStats = deltaAmplitudeStats[index];
    const rawJumpThreshold = rawStats.q3
      + Math.max(rawStats.iqr * 5, rawStats.q3 * 2.5, 1e-6);
    const deltaSlopeThreshold = slopeStats.q3
      + Math.max(slopeStats.iqr * 4.5, slopeStats.q3 * 1.6, deltaScale * 0.08);
    const deltaExtremeThreshold = amplitudeStats.q3
      + Math.max(amplitudeStats.iqr * 4.5, amplitudeStats.q3 * 2.5, deltaScale * 1.8);
    const localAmplitudeGate = amplitudeStats.q3
      + Math.max(amplitudeStats.iqr * 0.75, deltaScale * 0.35);
    const sharpRawTransient = rawDiff[index] > rawJumpThreshold
      && amplitude > localAmplitudeGate;
    const extremeDeltaTransient = amplitude > deltaExtremeThreshold
      && deltaDiff[index] > deltaSlopeThreshold;
    const multiChannelArtifact = eegConsensusMask[index]
      && amplitude > Math.max(deltaScale * 0.55, localAmplitudeGate * 0.6);
    const movementArtifact = motionMask[index]
      && amplitude > Math.max(deltaScale * 0.35, amplitudeStats.q3 * 0.7);
    if (sharpRawTransient || extremeDeltaTransient || multiChannelArtifact || movementArtifact) {
      mask[index] = true;
    }
  }

  if (context?.blinkArtifactActive) {
    const blinkTail = Math.max(1, Math.round(sampleRate * 1.2));
    for (let index = Math.max(0, mask.length - blinkTail); index < mask.length; index += 1) {
      mask[index] = true;
    }
  }

  // The longer post-window also removes the low-frequency ringing that a
  // blink can leave behind after narrow-band filtering.
  const preSamples = Math.max(1, Math.round(sampleRate * 0.25));
  const postSamples = Math.max(1, Math.round(sampleRate * 1.1));
  const expanded = new Array<boolean>(mask.length).fill(false);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const start = Math.max(0, index - preSamples);
    const end = Math.min(mask.length - 1, index + postSamples);
    for (let cursor = start; cursor <= end; cursor += 1) expanded[cursor] = true;
  }

  const cleaned = [...delta];
  let cursor = 0;
  while (cursor < expanded.length) {
    if (!expanded[cursor]) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < expanded.length && expanded[cursor]) cursor += 1;
    const end = cursor - 1;
    const leftIndex = start - 1;
    const rightIndex = cursor < cleaned.length ? cursor : -1;
    const left = leftIndex >= 0 ? cleaned[leftIndex] : deltaCenter;
    const right = rightIndex >= 0 ? cleaned[rightIndex] : left;
    const span = end - start + 2;
    for (let index = start; index <= end; index += 1) {
      const fraction = (index - start + 1) / span;
      cleaned[index] = left + (right - left) * fraction;
    }
  }

  return deltaValues.map((point, index) => ({ ...point, value: cleaned[index] }));
}

function buildEegConsensusMask(
  reference: TimedValue[],
  channels: TimedValue[][],
  sampleRate: number,
  baselineStale: boolean
): boolean[] {
  const usable = channels.filter((channel) => channel.length >= 12);
  const mask = new Array<boolean>(reference.length).fill(false);
  if (usable.length < 2) return mask;
  const aligned = usable.map((channel) => alignToReference(reference, channel));
  const differences = aligned.map(successiveAbsoluteDifferences);
  const stats = differences.map((values) => rollingIqrStats(values, sampleRate));
  const iqrMultiplier = baselineStale ? 3 : 4;

  for (let index = 1; index < reference.length; index += 1) {
    let respondingChannels = 0;
    for (let channel = 0; channel < differences.length; channel += 1) {
      const local = stats[channel][index];
      const threshold = local.q3
        + Math.max(local.iqr * iqrMultiplier, local.q3 * 2, 1e-6);
      if (differences[channel][index] > threshold) respondingChannels += 1;
    }
    mask[index] = respondingChannels >= 2;
  }
  return mask;
}

function buildMotionMask(
  reference: TimedValue[],
  accelerometer: SleepDeltaArtifactContext['accelerometer'] | undefined,
  sampleRate: number
): boolean[] {
  const mask = new Array<boolean>(reference.length).fill(false);
  if (!accelerometer
    || accelerometer.x.length < 12
    || accelerometer.y.length < 12
    || accelerometer.z.length < 12) return mask;
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
  const stats = rollingIqrStats(jerk, sampleRate);
  for (let index = 1; index < jerk.length; index += 1) {
    const local = stats[index];
    const threshold = local.q3 + Math.max(local.iqr * 4, local.q3 * 2.5, 1);
    mask[index] = jerk[index] > threshold;
  }
  return mask;
}

function alignToReference(reference: TimedValue[], values: TimedValue[]): number[] {
  const byTimestamp = new Map(values.map((point) => [point.timestamp, point.value]));
  let previous = values[0]?.value ?? 0;
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

function robustScale(values: number[], center = median(values)): number {
  const deviations = values.map((value) => Math.abs(value - center));
  return Math.max(1e-9, median(deviations) * 1.4826);
}

interface IqrStats {
  q1: number;
  q3: number;
  iqr: number;
}

/**
 * Recalculates robust limits every half second using a surrounding four-second
 * window. Short artifact bursts therefore cannot permanently raise the
 * threshold, while normal changes in electrode scale are followed quickly.
 */
function rollingIqrStats(values: number[], sampleRate: number): IqrStats[] {
  const blockSamples = Math.max(8, Math.round(sampleRate * 0.5));
  const radiusSamples = Math.max(blockSamples, Math.round(sampleRate * 2));
  const result = new Array<IqrStats>(values.length);
  for (let blockStart = 0; blockStart < values.length; blockStart += blockSamples) {
    const blockEnd = Math.min(values.length, blockStart + blockSamples);
    const contextStart = Math.max(0, blockStart - radiusSamples);
    const contextEnd = Math.min(values.length, blockEnd + radiusSamples);
    const sorted = values.slice(contextStart, contextEnd).sort((left, right) => left - right);
    const q1 = quantileSorted(sorted, 0.25);
    const q3 = quantileSorted(sorted, 0.75);
    const stats = { q1, q3, iqr: Math.max(1e-9, q3 - q1) };
    for (let index = blockStart; index < blockEnd; index += 1) result[index] = stats;
  }
  return result;
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
