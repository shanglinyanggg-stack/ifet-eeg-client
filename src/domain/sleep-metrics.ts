import { EEG_SAMPLE_RATE, type BandValue, type TimedValue } from './dsp';

export type SleepTrend = 'awake' | 'transition' | 'sleep-onset';

export interface SleepMetricBandInput {
  label: BandValue['label'];
  values: TimedValue[];
}

export interface SleepMetrics {
  deltaRelative: number;
  thetaRelative: number;
  alphaRelative: number;
  betaRelative: number;
  thetaAlphaRatio: number;
  sleepOnsetScore: number;
  solTrend: SleepTrend;
  solSeconds: number | null;
  vertexWave: boolean;
  spindlePower: number;
  spindleRelative: number;
  spindleCandidate: boolean;
  kComplexCandidate: boolean;
  n2Candidate: boolean;
}

interface CalculateSleepMetricsInput {
  rawValues: TimedValue[];
  bands: SleepMetricBandInput[];
  spindleValues: TimedValue[];
  sampleRate?: number;
}

const EPSILON = 1e-9;
const DEFAULT_SAMPLE_RATE = EEG_SAMPLE_RATE;

export function calculateSleepMetrics({
  rawValues,
  bands,
  spindleValues,
  sampleRate = DEFAULT_SAMPLE_RATE
}: CalculateSleepMetricsInput): SleepMetrics {
  const powers = getBandPowers(bands);
  const totalPower = powers.Delta + powers.Theta + powers.Alpha + powers.Beta;
  const deltaRelative = relativePower(powers.Delta, totalPower);
  const thetaRelative = relativePower(powers.Theta, totalPower);
  const alphaRelative = relativePower(powers.Alpha, totalPower);
  const betaRelative = relativePower(powers.Beta, totalPower);
  const thetaAlphaRatio = powers.Theta / Math.max(powers.Alpha, EPSILON);
  const sleepOnsetScore = scoreSleepOnset(thetaAlphaRatio, alphaRelative, betaRelative);
  const solTrend = classifySleepTrend(sleepOnsetScore, thetaAlphaRatio);
  const spindlePower = signalPower(spindleValues);
  const spindleRelative = totalPower > EPSILON ? spindlePower / totalPower : 0;
  const spindleCandidate = spindleRelative >= 0.18 && deltaRelative + thetaRelative >= 0.25;
  const kComplexCandidate = detectKComplex(rawValues);
  const vertexWave = detectVertexWave(rawValues);

  return {
    deltaRelative,
    thetaRelative,
    alphaRelative,
    betaRelative,
    thetaAlphaRatio,
    sleepOnsetScore,
    solTrend,
    solSeconds: solTrend === 'sleep-onset' ? estimateSolSeconds(bands, sampleRate) : null,
    vertexWave,
    spindlePower,
    spindleRelative,
    spindleCandidate,
    kComplexCandidate,
    n2Candidate: spindleCandidate || kComplexCandidate
  };
}

function getBandPowers(bands: SleepMetricBandInput[]): Record<BandValue['label'], number> {
  const powers: Record<BandValue['label'], number> = {
    Delta: 0,
    Theta: 0,
    Alpha: 0,
    Beta: 0
  };
  for (const band of bands) {
    powers[band.label] = signalPower(band.values);
  }
  return powers;
}

function signalPower(values: TimedValue[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, point) => sum + point.value * point.value, 0) / values.length;
}

function relativePower(power: number, totalPower: number): number {
  return totalPower > EPSILON ? power / totalPower : 0;
}

function scoreSleepOnset(thetaAlphaRatio: number, alphaRelative: number, betaRelative: number): number {
  const thetaLift = normalize(thetaAlphaRatio, 0.75, 1.6);
  const alphaDrop = 1 - normalize(alphaRelative, 0.18, 0.42);
  const betaDrop = 1 - normalize(betaRelative, 0.14, 0.36);
  return Math.round(clamp01(thetaLift * 0.45 + alphaDrop * 0.3 + betaDrop * 0.25) * 100);
}

function classifySleepTrend(score: number, thetaAlphaRatio: number): SleepTrend {
  if (score >= 65 && thetaAlphaRatio >= 1.1) return 'sleep-onset';
  if (score >= 38 || thetaAlphaRatio >= 0.75) return 'transition';
  return 'awake';
}

function estimateSolSeconds(bands: SleepMetricBandInput[], sampleRate: number): number | null {
  const anchor = bands
    .flatMap((band) => band.values.slice(0, 1))
    .map((point) => point.timestamp)
    .sort((a, b) => a - b)[0];
  if (anchor === undefined) return null;

  const longest = Math.max(0, ...bands.map((band) => band.values.length));
  const windowSize = Math.max(30, Math.floor(sampleRate * 3));
  const step = Math.max(10, Math.floor(sampleRate / 2));
  if (longest < windowSize) return 0;

  for (let end = windowSize; end <= longest; end += step) {
    const segmentBands = bands.map((band) => ({
      label: band.label,
      values: band.values.slice(Math.max(0, end - windowSize), end)
    }));
    const powers = getBandPowers(segmentBands);
    const totalPower = powers.Delta + powers.Theta + powers.Alpha + powers.Beta;
    const score = scoreSleepOnset(
      powers.Theta / Math.max(powers.Alpha, EPSILON),
      relativePower(powers.Alpha, totalPower),
      relativePower(powers.Beta, totalPower)
    );
    const trend = classifySleepTrend(score, powers.Theta / Math.max(powers.Alpha, EPSILON));
    if (trend === 'sleep-onset') {
      const firstPoint = segmentBands
        .flatMap((band) => band.values.slice(0, 1))
        .map((point) => point.timestamp)
        .sort((a, b) => a - b)[0];
      return firstPoint === undefined ? 0 : Math.max(0, (firstPoint - anchor) / 1000);
    }
  }

  return 0;
}

function detectVertexWave(values: TimedValue[]): boolean {
  if (values.length < 5) return false;
  const threshold = Math.max(12, rms(values) * 2.4);
  for (let index = 1; index < values.length - 1; index += 1) {
    const previous = values[index - 1].value;
    const current = values[index].value;
    const next = values[index + 1].value;
    const abs = Math.abs(current);
    if (abs < threshold) continue;
    if (abs < Math.abs(previous) || abs < Math.abs(next)) continue;
    if (Math.abs(current - previous) + Math.abs(current - next) >= threshold * 1.2) {
      return true;
    }
  }
  return false;
}

function detectKComplex(values: TimedValue[]): boolean {
  if (values.length < 30) return false;
  const threshold = Math.max(15, rms(values) * 2.2);
  for (let left = 0; left < values.length; left += 1) {
    const first = values[left];
    if (Math.abs(first.value) < threshold) continue;
    for (let right = left + 1; right < values.length; right += 1) {
      const second = values[right];
      const gap = second.timestamp - first.timestamp;
      if (gap < 250) continue;
      if (gap > 1200) break;
      if (Math.sign(first.value) !== Math.sign(second.value) && Math.abs(second.value) >= threshold * 0.75) {
        return true;
      }
    }
  }
  return false;
}

function rms(values: TimedValue[]): number {
  return Math.sqrt(signalPower(values));
}

function normalize(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return clamp01((value - low) / (high - low));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
