import { describe, expect, test } from 'vitest';
import { matchedFilterSleepTheta } from './theta-matched-filter';

const SAMPLE_RATE = 100;
const LENGTH = 1_200;

function thetaSignal(amplitude = 45, frequency = 6) {
  return Array.from({ length: LENGTH }, (_, index) => ({
    timestamp: index * 10,
    value: Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE) * amplitude
  }));
}

function power(values: Array<{ value: number }>, start = 0, end = values.length): number {
  const segment = values.slice(start, end);
  return segment.reduce((sum, point) => sum + point.value ** 2, 0) / Math.max(1, segment.length);
}

describe('matchedFilterSleepTheta', () => {
  test('keeps the previous-version visible waveform outside the analysis function and preserves rhythmic Theta', () => {
    const theta = thetaSignal(130);
    const result = matchedFilterSleepTheta(theta, theta);
    expect(result.retainedFraction).toBeGreaterThan(0.97);
    expect(result.rhythmicity).toBeGreaterThan(0.9);
    expect(theta[500].value).toBeCloseTo(thetaSignal(130)[500].value, 8);
  });

  test('attenuates matched bilateral blink ringing without interpolation gain', () => {
    const baseline = thetaSignal(35);
    const contaminated = baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 330 && index <= 650
        ? Math.sin(2 * Math.PI * 5.5 * index / SAMPLE_RATE) * 420
        : 0)
    }));
    const blink = (gain: number, shift = 0) => baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 300 + shift && index <= 305 + shift ? gain : 0)
    }));
    const result = matchedFilterSleepTheta(contaminated, blink(4_000), SAMPLE_RATE, {
      eegChannels: [blink(4_000), blink(5_000, 1), baseline, baseline]
    });
    expect(power(result.values, 330, 650)).toBeLessThan(power(contaminated, 330, 650) * 0.35);
    expect(power(result.values)).toBeLessThanOrEqual(power(contaminated));
    expect(result.artifactFraction).toBeGreaterThan(0.2);
  });

  test('uses a matched IMU impulse to reject movement contamination', () => {
    const baseline = thetaSignal(30);
    const contaminated = baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 380 && index <= 690
        ? Math.sin(2 * Math.PI * 4.8 * index / SAMPLE_RATE) * 360
        : 0)
    }));
    const acc = (gain: number) => baseline.map((point, index) => ({
      timestamp: point.timestamp,
      value: index >= 350 && index <= 355 ? gain : 100
    }));
    const result = matchedFilterSleepTheta(contaminated, baseline, SAMPLE_RATE, {
      accelerometer: { x: acc(8_000), y: acc(3_000), z: acc(5_000) }
    });

    expect(power(result.values, 380, 690)).toBeLessThan(power(contaminated, 380, 690) * 0.2);
  });

  test('does not remove a rhythmic Theta burst without matched artifact evidence', () => {
    const baseline = thetaSignal(30);
    const burst = baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 350 && index <= 650
        ? Math.sin(2 * Math.PI * 5 * index / SAMPLE_RATE) * 120
        : 0)
    }));
    const result = matchedFilterSleepTheta(burst, baseline);
    expect(power(result.values, 350, 650)).toBeGreaterThan(power(burst, 350, 650) * 0.9);
  });

  test('uses the personal blink-template correlation as a strong recent artifact gate', () => {
    const theta = thetaSignal(45);
    const contaminated = theta.map((point, index) => ({
      ...point,
      value: point.value + (index >= 1_080 ? Math.sin(2 * Math.PI * 5 * index / SAMPLE_RATE) * 300 : 0)
    }));
    const rawBlink = theta.map((point, index) => ({
      ...point,
      value: point.value + (index >= 1_050 && index <= 1_055 ? 4_000 : 0)
    }));
    const result = matchedFilterSleepTheta(contaminated, rawBlink, SAMPLE_RATE, {
      blinkTemplateReady: true,
      blinkTemplateCorrelation: 0.82
    });
    expect(power(result.values, 1_080)).toBeLessThan(power(contaminated, 1_080) * 0.15);
  });
});
