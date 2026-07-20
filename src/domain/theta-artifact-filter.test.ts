import { describe, expect, test } from 'vitest';
import { cleanSleepThetaWave } from './theta-artifact-filter';

const SAMPLE_RATE = 100;
const LENGTH = 1_200;

function thetaSignal(amplitude = 45) {
  return Array.from({ length: LENGTH }, (_, index) => ({
    timestamp: index * 10,
    value: Math.sin(2 * Math.PI * 6 * index / SAMPLE_RATE) * amplitude
  }));
}

function power(values: Array<{ value: number }>, start = 0, end = values.length): number {
  const segment = values.slice(start, end);
  return segment.reduce((sum, point) => sum + point.value * point.value, 0) / Math.max(1, segment.length);
}

describe('cleanSleepThetaWave', () => {
  test('preserves continuous physiological Theta even at high amplitude', () => {
    const theta = thetaSignal(130);
    const raw = thetaSignal(130);
    const cleaned = cleanSleepThetaWave(theta, raw);
    const error = cleaned.reduce(
      (sum, point, index) => sum + Math.abs(point.value - theta[index].value),
      0
    ) / theta.length;

    expect(error).toBeLessThan(0.5);
  });

  test('removes delayed FIR ringing after a simultaneous multi-channel blink', () => {
    const baseline = thetaSignal(35);
    const contaminated = baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 330 && index <= 640
        ? Math.sin(2 * Math.PI * 5.5 * index / SAMPLE_RATE) * 420
        : 0)
    }));
    const rawBlink = (gain: number) => baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 300 && index <= 305 ? gain : 0)
    }));

    const cleaned = cleanSleepThetaWave(contaminated, rawBlink(4_000), SAMPLE_RATE, {
      eegChannels: [rawBlink(4_000), rawBlink(5_000), baseline, baseline]
    });

    expect(power(cleaned, 330, 640)).toBeLessThan(power(contaminated, 330, 640) * 0.2);
    expect(Math.abs(cleaned[150].value - contaminated[150].value)).toBeLessThan(0.5);
    expect(Math.abs(cleaned[850].value - contaminated[850].value)).toBeLessThan(0.5);
  });

  test('uses accelerometer IQR jerk to remove movement-related Theta contamination', () => {
    const baseline = thetaSignal(30);
    const contaminated = baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 380 && index <= 680
        ? Math.sin(2 * Math.PI * 4.8 * index / SAMPLE_RATE) * 360
        : 0)
    }));
    const acc = (gain: number) => baseline.map((point, index) => ({
      timestamp: point.timestamp,
      value: index >= 350 && index <= 355 ? gain : 100
    }));

    const cleaned = cleanSleepThetaWave(contaminated, baseline, SAMPLE_RATE, {
      accelerometer: { x: acc(8_000), y: acc(3_000), z: acc(5_000) }
    });

    expect(power(cleaned, 380, 680)).toBeLessThan(power(contaminated, 380, 680) * 0.25);
    expect(Math.abs(cleaned[900].value - contaminated[900].value)).toBeLessThan(0.5);
  });

  test('does not delete a Theta increase without blink or motion evidence', () => {
    const baseline = thetaSignal(30);
    const physiologicalBurst = baseline.map((point, index) => ({
      ...point,
      value: point.value + (index >= 350 && index <= 650
        ? Math.sin(2 * Math.PI * 5 * index / SAMPLE_RATE) * 120
        : 0)
    }));

    const cleaned = cleanSleepThetaWave(physiologicalBurst, baseline);

    expect(power(cleaned, 350, 650)).toBeGreaterThan(power(physiologicalBurst, 350, 650) * 0.95);
  });
});
