import type { TimedValue } from './dsp';

const MIN_FREQUENCY_HZ = 0.5;
const DEFAULT_MAX_FREQUENCY_HZ = 45;
const MIN_FFT_SIZE = 128;
const MAX_FFT_SIZE = 1_024;
const DB_FLOOR = -60;

export interface PowerSpectrumPoint {
  frequencyHz: number;
  powerDb: number;
}

export interface PowerSpectrumSnapshot {
  points: PowerSpectrumPoint[];
  peakFrequencyHz: number | null;
  resolutionHz: number;
  windowSeconds: number;
  fftSize: number;
  minimumDb: number;
  maximumFrequencyHz: number;
}

export function computeRelativePowerSpectrum(
  values: readonly TimedValue[],
  sampleRateHz: number,
  requestedMaximumFrequencyHz = DEFAULT_MAX_FREQUENCY_HZ
): PowerSpectrumSnapshot {
  const safeSampleRate = Math.max(1, Number.isFinite(sampleRateHz) ? sampleRateHz : 1);
  const maximumFrequencyHz = Math.min(
    requestedMaximumFrequencyHz,
    safeSampleRate / 2
  );
  const fftSize = largestPowerOfTwoAtMost(
    Math.min(values.length, MAX_FFT_SIZE)
  );
  const empty = {
    points: [],
    peakFrequencyHz: null,
    resolutionHz: fftSize > 0 ? safeSampleRate / fftSize : 0,
    windowSeconds: fftSize / safeSampleRate,
    fftSize,
    minimumDb: DB_FLOOR,
    maximumFrequencyHz
  };
  if (fftSize < MIN_FFT_SIZE || maximumFrequencyHz < MIN_FREQUENCY_HZ) {
    return empty;
  }

  const source = values.slice(values.length - fftSize);
  const mean = source.reduce((sum, point) => sum + point.value, 0) / fftSize;
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  for (let index = 0; index < fftSize; index += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1));
    real[index] = (source[index].value - mean) * hann;
  }
  fftInPlace(real, imaginary);

  const resolutionHz = safeSampleRate / fftSize;
  const firstBin = Math.max(1, Math.ceil(MIN_FREQUENCY_HZ / resolutionHz));
  const lastBin = Math.min(
    Math.floor(fftSize / 2),
    Math.floor(maximumFrequencyHz / resolutionHz)
  );
  const rawPowers: number[] = [];
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    rawPowers.push(real[bin] ** 2 + imaginary[bin] ** 2);
  }
  const smoothedPowers = rawPowers.map((power, index) => {
    const previous = rawPowers[Math.max(0, index - 1)];
    const next = rawPowers[Math.min(rawPowers.length - 1, index + 1)];
    return (previous + power * 2 + next) / 4;
  });
  const maximumPower = Math.max(Number.EPSILON, ...smoothedPowers);
  const points = smoothedPowers.map((power, index) => ({
    frequencyHz: (firstBin + index) * resolutionHz,
    powerDb: Math.max(DB_FLOOR, 10 * Math.log10(Math.max(Number.EPSILON, power) / maximumPower))
  }));
  const peak = points.reduce<PowerSpectrumPoint | null>(
    (current, point) => current === null || point.powerDb > current.powerDb ? point : current,
    null
  );

  return {
    points,
    peakFrequencyHz: peak?.frequencyHz ?? null,
    resolutionHz,
    windowSeconds: fftSize / safeSampleRate,
    fftSize,
    minimumDb: DB_FLOOR,
    maximumFrequencyHz
  };
}

function largestPowerOfTwoAtMost(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 0;
  let result = 1;
  while (result * 2 <= value) result *= 2;
  return result;
}

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let source = 1, target = 0; source < size; source += 1) {
    let bit = size >> 1;
    while (target & bit) {
      target ^= bit;
      bit >>= 1;
    }
    target ^= bit;
    if (source < target) {
      [real[source], real[target]] = [real[target], real[source]];
      [imaginary[source], imaginary[target]] = [imaginary[target], imaginary[source]];
    }
  }

  for (let blockSize = 2; blockSize <= size; blockSize *= 2) {
    const angle = (-2 * Math.PI) / blockSize;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += blockSize) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < blockSize / 2; offset += 1) {
        const even = start + offset;
        const odd = even + blockSize / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}
