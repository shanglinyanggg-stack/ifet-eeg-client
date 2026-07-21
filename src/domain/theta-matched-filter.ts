import { EEG_SAMPLE_RATE, type TimedValue } from './dsp';
import type { SleepDeltaArtifactContext } from './delta-artifact-filter';

export interface ThetaMatchedFilterOptions {
  lowHz?: number;
  highHz?: number;
  minimumBlinkCorrelation?: number;
}

export interface ThetaMatchedFilterResult {
  values: TimedValue[];
  rhythmicity: number;
  retainedFraction: number;
  artifactFraction: number;
}

/**
 * Matched-filter analysis copy for the 4-7 Hz Theta band.
 *
 * The visible waveform deliberately remains the previous-version FIR output.
 * This function is used only by band share, sleep metrics and drowsiness. A
 * sine/cosine template bank retains continuous 4-7 Hz activity, while
 * normalized cross-correlation across EEG channels and an IMU impulse template
 * reject blink/movement responses. Multiplicative weights can only attenuate
 * samples, avoiding the power increase possible with waveform interpolation.
 */
export function matchedFilterSleepTheta(
  thetaValues: TimedValue[],
  rawValues: TimedValue[],
  sampleRate = EEG_SAMPLE_RATE,
  context?: SleepDeltaArtifactContext,
  options: ThetaMatchedFilterOptions = {}
): ThetaMatchedFilterResult {
  if (thetaValues.length < Math.max(48, Math.round(sampleRate * 0.7))) {
    return unchanged(thetaValues);
  }

  const theta = thetaValues.map((point) => point.value);
  const lowHz = Math.max(3, options.lowHz ?? 4);
  const highHz = Math.min(sampleRate / 2 - 1, options.highHz ?? 7);
  const rhythmicity = matchedThetaRhythmicity(theta, sampleRate, lowHz, highHz);
  const rhythmicWeights = rhythmicity.map((score) => {
    // A one-second 4-7 Hz waveform must explain a meaningful fraction of its
    // energy with at least one quadrature template. Keep a non-zero floor so
    // irregular physiological Theta is attenuated rather than erased.
    const evidence = smoothstep((score - 0.48) / 0.34);
    return 0.28 + evidence * 0.72;
  });

  const eegEvents = buildMultichannelMatchedEvents(
    thetaValues,
    context?.eegChannels ?? [],
    sampleRate
  );
  const motionEvents = buildMotionMatchedEvents(
    thetaValues,
    context?.accelerometer,
    sampleRate
  );
  const externalBlinkMatch = Boolean(context?.blinkArtifactActive)
    || (context?.blinkTemplateReady === true
      && Number(context.blinkTemplateCorrelation) >= (options.minimumBlinkCorrelation ?? 0.65));
  const externalEvents = new Array<boolean>(theta.length).fill(false);
  if (externalBlinkMatch) {
    let source = lastTrueIndex(eegEvents, Math.max(0, eegEvents.length - Math.round(sampleRate * 1.5)));
    if (source < 0) source = locateRecentRawTransient(thetaValues, rawValues, sampleRate);
    if (source < 0) source = Math.max(0, theta.length - Math.round(sampleRate * 0.55));
    externalEvents[source] = true;
  }

  const envelope = movingRms(theta, Math.max(2, Math.round(sampleRate * 0.1)));
  const envelopeMedian = median(envelope);
  const envelopeQuiet = Math.max(1e-9, quantile(envelope, 0.25));
  const delaySamples = estimateFirDelaySamples(lowHz, sampleRate);
  const supportSamples = delaySamples * 2 + Math.round(sampleRate * 0.18);
  const artifactWeights = new Array<number>(theta.length).fill(1);

  applyArtifactSupport(
    artifactWeights,
    mergeMasks(motionEvents, externalEvents),
    supportSamples,
    sampleRate,
    () => 0.08
  );
  applyArtifactSupport(
    artifactWeights,
    eegEvents,
    supportSamples,
    sampleRate,
    (index) => {
      const envelopeTransient = envelope[index] > Math.max(
        envelopeQuiet * 1.8,
        envelopeMedian * 1.35
      );
      if (rhythmicity[index] < 0.72 || envelopeTransient) return 0.16;
      // A very rhythmic segment coincident with a bilateral transient is
      // retained partially; this protects genuine Theta bursts while still
      // reducing causal FIR ringing from the transient.
      return 0.52;
    }
  );

  const values = thetaValues.map((point, index) => ({
    ...point,
    value: point.value * Math.min(rhythmicWeights[index], artifactWeights[index])
  }));
  const totalOriginal = meanAbsolute(theta);
  const totalRetained = meanAbsolute(values.map((point) => point.value));
  return {
    values,
    rhythmicity: median(rhythmicity),
    retainedFraction: totalOriginal > 1e-9 ? clamp01(totalRetained / totalOriginal) : 1,
    artifactFraction: artifactWeights.filter((weight) => weight < 0.99).length / artifactWeights.length
  };
}

function buildMultichannelMatchedEvents(
  reference: TimedValue[],
  channels: TimedValue[][],
  sampleRate: number
): boolean[] {
  const usable = channels.filter((channel) => channel.length >= 48);
  const events = new Array<boolean>(reference.length).fill(false);
  if (usable.length < 2) return events;
  const aligned = usable.map((channel) => alignToReference(reference, channel));
  const differences = aligned.map(successiveDifferences);
  const thresholds = differences.map((values) => robustUpperThreshold(
    values.map(Math.abs),
    5.5,
    1e-6
  ));
  const pre = Math.max(2, Math.round(sampleRate * 0.04));
  const post = Math.max(5, Math.round(sampleRate * 0.10));
  const refractory = Math.max(4, Math.round(sampleRate * 0.12));

  for (let index = pre; index < reference.length - post; index += 1) {
    let responding = 0;
    for (let channel = 0; channel < differences.length; channel += 1) {
      let localPeak = 0;
      for (let shift = -3; shift <= 3; shift += 1) {
        localPeak = Math.max(localPeak, Math.abs(differences[channel][index + shift] ?? 0));
      }
      if (localPeak > thresholds[channel]) responding += 1;
    }
    if (responding < 2) continue;

    const segments = aligned.map((values) => detrendedSegment(values, index - pre, index + post + 1));
    let matchedPairs = 0;
    for (let left = 0; left < segments.length; left += 1) {
      for (let right = left + 1; right < segments.length; right += 1) {
        if (bestShiftedAbsoluteCorrelation(segments[left], segments[right], 3) >= 0.68) {
          matchedPairs += 1;
        }
      }
    }
    if (matchedPairs < 1) continue;
    events[index] = true;
    index += refractory;
  }
  return events;
}

function locateRecentRawTransient(
  reference: TimedValue[],
  rawValues: TimedValue[],
  sampleRate: number
): number {
  const raw = alignToReference(reference, rawValues);
  const differences = successiveDifferences(raw).map(Math.abs);
  const minimum = Math.max(1, differences.length - Math.round(sampleRate * 2));
  const threshold = robustUpperThreshold(differences, 4.5, 1e-6);
  let best = -1;
  let bestValue = threshold;
  for (let index = minimum; index < differences.length; index += 1) {
    if (differences[index] > bestValue) {
      best = index;
      bestValue = differences[index];
    }
  }
  return best;
}

function buildMotionMatchedEvents(
  reference: TimedValue[],
  accelerometer: SleepDeltaArtifactContext['accelerometer'] | undefined,
  sampleRate: number
): boolean[] {
  const events = new Array<boolean>(reference.length).fill(false);
  if (!accelerometer
    || accelerometer.x.length < 48
    || accelerometer.y.length < 48
    || accelerometer.z.length < 48) return events;
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
  const threshold = robustUpperThreshold(jerk, 5, 2);
  const extremeThreshold = robustUpperThreshold(jerk, 9, 4);
  const pre = Math.max(2, Math.round(sampleRate * 0.04));
  const post = Math.max(5, Math.round(sampleRate * 0.10));
  const template = gaussianImpulse(pre + post + 1, pre, Math.max(1.5, sampleRate * 0.025));
  const refractory = Math.max(5, Math.round(sampleRate * 0.15));
  for (let index = pre; index < jerk.length - post; index += 1) {
    if (jerk[index] <= threshold) continue;
    const segment = jerk.slice(index - pre, index + post + 1);
    const correlation = positiveCosineSimilarity(segment, template);
    if (correlation >= 0.5 || jerk[index] >= extremeThreshold) {
      events[index] = true;
      index += refractory;
    }
  }
  return events;
}

function matchedThetaRhythmicity(
  values: number[],
  sampleRate: number,
  lowHz: number,
  highHz: number
): number[] {
  const windowSamples = Math.max(60, Math.round(sampleRate));
  const refreshSamples = Math.max(4, Math.round(sampleRate * 0.1));
  const scores = new Array<number>(values.length).fill(0);
  for (let block = 0; block < values.length; block += refreshSamples) {
    const center = Math.min(values.length - 1, block + Math.floor(refreshSamples / 2));
    const start = Math.max(0, center - Math.floor(windowSamples / 2));
    const end = Math.min(values.length, start + windowSamples);
    const segment = values.slice(Math.max(0, end - windowSamples), end);
    const score = matchedOscillationScore(segment, sampleRate, lowHz, highHz);
    for (let index = block; index < Math.min(values.length, block + refreshSamples); index += 1) {
      scores[index] = score;
    }
  }
  return smoothScores(scores, Math.max(2, Math.round(sampleRate * 0.08)));
}

function matchedOscillationScore(
  values: number[],
  sampleRate: number,
  lowHz: number,
  highHz: number
): number {
  if (values.length < Math.round(sampleRate * 0.55)) return 0;
  const center = mean(values);
  const centered = values.map((value) => value - center);
  const energy = centered.reduce((sum, value) => sum + value * value, 0);
  if (energy <= 1e-12) return 0;
  let best = 0;
  for (let frequency = lowHz; frequency <= highHz + 1e-9; frequency += 0.5) {
    let cosine = 0;
    let sine = 0;
    let cosineEnergy = 0;
    let sineEnergy = 0;
    for (let index = 0; index < centered.length; index += 1) {
      const phase = 2 * Math.PI * frequency * index / sampleRate;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      cosine += centered[index] * c;
      sine += centered[index] * s;
      cosineEnergy += c * c;
      sineEnergy += s * s;
    }
    const explained = (cosine * cosine / Math.max(cosineEnergy, 1e-9)
      + sine * sine / Math.max(sineEnergy, 1e-9)) / energy;
    best = Math.max(best, Math.sqrt(clamp01(explained)));
  }
  return best;
}

function applyArtifactSupport(
  weights: number[],
  events: boolean[],
  supportSamples: number,
  sampleRate: number,
  minimumWeight: (index: number) => number
): void {
  const pre = Math.max(1, Math.round(sampleRate * 0.08));
  const fade = Math.max(1, Math.round(sampleRate * 0.12));
  for (let source = 0; source < events.length; source += 1) {
    if (!events[source]) continue;
    const start = Math.max(0, source - pre);
    const end = Math.min(weights.length - 1, source + supportSamples);
    const floor = minimumWeight(source);
    for (let index = start; index <= end; index += 1) {
      const left = clamp01((index - start + 1) / fade);
      const right = clamp01((end - index + 1) / fade);
      const depth = smoothstep(Math.min(left, right));
      weights[index] = Math.min(weights[index], 1 - (1 - floor) * depth);
    }
  }
}

function estimateFirDelaySamples(lowHz: number, sampleRate: number): number {
  const transition = Math.max(0.2, Math.max(0.1, lowHz) * 0.25);
  let taps = Math.ceil((3.3 * sampleRate) / transition);
  if (taps % 2 === 0) taps += 1;
  const maxTaps = Math.max(3, Math.floor(4 * sampleRate) * 2 + 1);
  taps = Math.max(3, Math.min(taps, maxTaps));
  return Math.floor((taps - 1) / 2);
}

function detrendedSegment(values: number[], start: number, end: number): number[] {
  const segment = values.slice(start, end);
  if (segment.length < 2) return segment;
  const first = segment[0];
  const last = segment[segment.length - 1];
  return segment.map((value, index) => value - (first + (last - first) * index / (segment.length - 1)));
}

function bestShiftedAbsoluteCorrelation(left: number[], right: number[], maxShift: number): number {
  let best = 0;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    const leftStart = Math.max(0, -shift);
    const rightStart = Math.max(0, shift);
    const length = Math.min(left.length - leftStart, right.length - rightStart);
    if (length < 6) continue;
    best = Math.max(best, Math.abs(normalizedCorrelation(
      left.slice(leftStart, leftStart + length),
      right.slice(rightStart, rightStart + length)
    )));
  }
  return best;
}

function normalizedCorrelation(left: number[], right: number[]): number {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const l = left[index] - leftMean;
    const r = right[index] - rightMean;
    numerator += l * r;
    leftEnergy += l * l;
    rightEnergy += r * r;
  }
  return numerator / Math.max(Math.sqrt(leftEnergy * rightEnergy), 1e-12);
}

function positiveCosineSimilarity(values: number[], template: number[]): number {
  const baseline = quantile(values, 0.2);
  let numerator = 0;
  let valueEnergy = 0;
  let templateEnergy = 0;
  for (let index = 0; index < Math.min(values.length, template.length); index += 1) {
    const value = Math.max(0, values[index] - baseline);
    numerator += value * template[index];
    valueEnergy += value * value;
    templateEnergy += template[index] * template[index];
  }
  return numerator / Math.max(Math.sqrt(valueEnergy * templateEnergy), 1e-12);
}

function robustUpperThreshold(values: number[], multiplier: number, floor: number): number {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center))) * 1.4826;
  return center + Math.max(mad * multiplier, Math.abs(center) * 1.5, floor);
}

function gaussianImpulse(length: number, center: number, sigma: number): number[] {
  return Array.from({ length }, (_, index) => Math.exp(-0.5 * ((index - center) / sigma) ** 2));
}

function movingRms(values: number[], radius: number): number[] {
  const prefix = new Array<number>(values.length + 1).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    prefix[index + 1] = prefix[index] + values[index] * values[index];
  }
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    return Math.sqrt(Math.max(0, (prefix[end] - prefix[start]) / Math.max(1, end - start)));
  });
}

function smoothScores(values: number[], radius: number): number[] {
  const prefix = new Array<number>(values.length + 1).fill(0);
  for (let index = 0; index < values.length; index += 1) prefix[index + 1] = prefix[index] + values[index];
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    return (prefix[end] - prefix[start]) / Math.max(1, end - start);
  });
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

function successiveDifferences(values: number[]): number[] {
  const result = new Array<number>(values.length).fill(0);
  for (let index = 1; index < values.length; index += 1) result[index] = values[index] - values[index - 1];
  return result;
}

function mergeMasks(left: boolean[], right: boolean[]): boolean[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => Boolean(left[index] || right[index]));
}

function lastTrueIndex(values: boolean[], minimum: number): number {
  for (let index = values.length - 1; index >= minimum; index -= 1) {
    if (values[index]) return index;
  }
  return -1;
}

function unchanged(values: TimedValue[]): ThetaMatchedFilterResult {
  return { values, rhythmicity: 1, retainedFraction: 1, artifactFraction: 0 };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function meanAbsolute(values: number[]): number {
  return values.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, values.length);
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

function smoothstep(value: number): number {
  const normalized = clamp01(value);
  return normalized * normalized * (3 - 2 * normalized);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
