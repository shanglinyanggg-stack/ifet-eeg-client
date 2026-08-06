import type { TimedValue } from './dsp';

/**
 * Improves the visibility of short 13-30 Hz beta bursts after the canonical
 * band-pass stage. The nonlinear result is display-only: spectral metrics must
 * continue to use the unmodified FIR output.
 *
 * The enhancer uses a 160 ms RMS envelope, a robust median/MAD noise floor and
 * an 80 ms gain smoother. Quiet beta is gently attenuated, sustained short
 * bursts receive up to 1.8x gain, and a soft robust limiter prevents isolated
 * motion/EMG spikes from dominating the chart.
 */
export function enhanceShortBetaBursts(
  values: readonly TimedValue[],
  sampleRateHz: number
): TimedValue[] {
  if (values.length === 0) return [];
  const safeRate = Math.max(1, Number.isFinite(sampleRateHz) ? sampleRateHz : 125);
  const rmsWindow = Math.max(3, Math.round(safeRate * 0.16));
  const gainWindow = Math.max(2, Math.round(safeRate * 0.08));
  const envelope = rollingRms(values, rmsWindow);
  const floor = median(envelope);
  const envelopeMad = median(envelope.map((value) => Math.abs(value - floor)));
  const robustEnvelopeScale = Math.max(1e-9, envelopeMad * 1.4826, floor * 0.12);
  const amplitudes = values.map((point) => Math.abs(point.value));
  const amplitudeMedian = median(amplitudes);
  const amplitudeMad = median(amplitudes.map((value) => Math.abs(value - amplitudeMedian)));
  const limiter = Math.max(
    Number.EPSILON,
    amplitudeMedian + Math.max(amplitudeMedian * 2.5, amplitudeMad * 8)
  );

  let smoothedGain = 0.65;
  const smoothing = 1 - Math.exp(-1 / gainWindow);
  return values.map((point, index) => {
    const robustZ = Math.max(0, (envelope[index] - floor) / robustEnvelopeScale);
    const targetGain = clamp(0.65 + robustZ * 0.22, 0.65, 1.8);
    smoothedGain += smoothing * (targetGain - smoothedGain);
    const limited = limiter * Math.tanh(point.value / limiter);
    return { ...point, value: limited * smoothedGain };
  });
}

function rollingRms(values: readonly TimedValue[], windowSize: number): number[] {
  const result = new Array<number>(values.length);
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    sumSquares += values[index].value ** 2;
    if (index >= windowSize) sumSquares -= values[index - windowSize].value ** 2;
    result[index] = Math.sqrt(sumSquares / Math.min(index + 1, windowSize));
  }
  return result;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
