import type { TimedValue } from './dsp';

/**
 * Display-only Delta cleaner for sleep slow-wave inspection.
 *
 * It detects short, steep transients from the raw EEG derivative and the
 * band-limited Delta envelope, expands a short blink/artifact guard window,
 * then bridges only those windows. Gradual 0.5-4 Hz slow waves are preserved.
 */
export function cleanSleepDeltaWave(
  deltaValues: TimedValue[],
  rawValues: TimedValue[],
  sampleRate = 100
): TimedValue[] {
  if (deltaValues.length < 12 || rawValues.length < 12) return deltaValues;

  const rawByTimestamp = new Map(rawValues.map((point) => [point.timestamp, point.value]));
  const raw = deltaValues.map((point) => rawByTimestamp.get(point.timestamp) ?? point.value);
  const delta = deltaValues.map((point) => point.value);
  const rawDiff = successiveAbsoluteDifferences(raw);
  const deltaDiff = successiveAbsoluteDifferences(delta);
  const deltaCenter = median(delta);
  const deltaScale = robustScale(delta, deltaCenter);
  const rawDiffCenter = median(rawDiff);
  const rawDiffScale = robustScale(rawDiff, rawDiffCenter);
  const deltaDiffCenter = median(deltaDiff);
  const deltaDiffScale = robustScale(deltaDiff, deltaDiffCenter);

  if (deltaScale <= 1e-9) return deltaValues;

  const rawJumpThreshold = rawDiffCenter + Math.max(rawDiffScale * 10, rawDiffCenter * 7, 1e-6);
  const deltaSlopeThreshold = deltaDiffCenter + Math.max(deltaDiffScale * 6, deltaScale * 0.24);
  const deltaExtremeThreshold = deltaScale * 6;
  const mask = new Array<boolean>(delta.length).fill(false);

  for (let index = 1; index < delta.length; index += 1) {
    const amplitude = Math.abs(delta[index] - deltaCenter);
    const sharpRawTransient = rawDiff[index] > rawJumpThreshold
      && amplitude > deltaScale * 1.6;
    const extremeDeltaTransient = amplitude > deltaExtremeThreshold
      && deltaDiff[index] > deltaSlopeThreshold;
    if (sharpRawTransient || extremeDeltaTransient) mask[index] = true;
  }

  const preSamples = Math.max(1, Math.round(sampleRate * 0.12));
  const postSamples = Math.max(1, Math.round(sampleRate * 0.48));
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
