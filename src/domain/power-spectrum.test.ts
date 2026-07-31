import { describe, expect, test } from 'vitest';
import type { TimedValue } from './dsp';
import { computeRelativePowerSpectrum } from './power-spectrum';

function sineWave(
  frequencyHz: number,
  sampleRateHz: number,
  count: number,
  offset = 0
): TimedValue[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: (index / sampleRateHz) * 1_000,
    value: offset + Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz)
  }));
}

describe('computeRelativePowerSpectrum', () => {
  test('locates a ten-hertz EEG peak after removing DC offset', () => {
    const spectrum = computeRelativePowerSpectrum(
      sineWave(10, 125, 512, 50_000),
      125
    );

    expect(spectrum.fftSize).toBe(512);
    expect(spectrum.windowSeconds).toBeCloseTo(4.096, 5);
    expect(spectrum.resolutionHz).toBeCloseTo(125 / 512, 8);
    expect(spectrum.peakFrequencyHz).toBeCloseTo(10, 0);
    expect(Math.max(...spectrum.points.map((point) => point.powerDb))).toBeCloseTo(0, 8);
  });

  test('limits the chart to the requested EEG frequency range', () => {
    const spectrum = computeRelativePowerSpectrum(sineWave(20, 125, 512), 125, 30);

    expect(spectrum.maximumFrequencyHz).toBe(30);
    expect(spectrum.points[0].frequencyHz).toBeGreaterThanOrEqual(0.5);
    expect(spectrum.points[spectrum.points.length - 1].frequencyHz).toBeLessThanOrEqual(30);
  });

  test('waits for enough samples to produce a stable spectrum', () => {
    const spectrum = computeRelativePowerSpectrum(sineWave(10, 125, 100), 125);

    expect(spectrum.points).toEqual([]);
    expect(spectrum.peakFrequencyHz).toBeNull();
  });
});
