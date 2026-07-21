import { describe, expect, test } from 'vitest';
import { cleanSleepDeltaWave } from './delta-artifact-filter';

const SAMPLE_RATE = 125;
const STEP_MS = 1000 / SAMPLE_RATE;

describe('cleanSleepDeltaWave', () => {
  test('preserves a continuous sleep slow wave', () => {
    const delta = Array.from({ length: 750 }, (_, index) => ({
      timestamp: index * STEP_MS,
      value: Math.sin(2 * Math.PI * 1.2 * index / SAMPLE_RATE) * 40
    }));
    const cleaned = cleanSleepDeltaWave(delta, delta);
    const error = cleaned.reduce((sum, point, index) => sum + Math.abs(point.value - delta[index].value), 0) / delta.length;
    expect(error).toBeLessThan(0.5);
  });

  test('bridges a steep blink-like transient without flattening the surrounding slow wave', () => {
    const delta = Array.from({ length: 750 }, (_, index) => ({
      timestamp: index * STEP_MS,
      value: Math.sin(2 * Math.PI * index / SAMPLE_RATE) * 35 + (index === 375 ? 900 : 0)
    }));
    const raw = delta.map((point, index) => ({
      ...point,
      value: Math.sin(2 * Math.PI * index / SAMPLE_RATE) * 35 + (index >= 374 && index <= 378 ? 4_000 : 0)
    }));
    const cleaned = cleanSleepDeltaWave(delta, raw);

    expect(Math.abs(cleaned[375].value)).toBeLessThan(100);
    expect(Math.abs(cleaned[225].value - delta[225].value)).toBeLessThan(0.5);
    expect(Math.abs(cleaned[525].value - delta[525].value)).toBeLessThan(0.5);
  });

  test('adapts to a blink burst while preserving a high-amplitude smooth N3 candidate', () => {
    const delta = Array.from({ length: 1125 }, (_, index) => ({
      timestamp: index * STEP_MS,
      value: Math.sin(2 * Math.PI * 0.8 * index / SAMPLE_RATE) * 180
        + (index >= 560 && index <= 568 ? 1_600 : 0)
    }));
    const raw = delta.map((point, index) => ({
      ...point,
      value: Math.sin(2 * Math.PI * 0.8 * index / SAMPLE_RATE) * 180
        + (index >= 559 && index <= 569 ? 8_000 : 0)
    }));

    const cleaned = cleanSleepDeltaWave(delta, raw);

    expect(Math.abs(cleaned[564].value)).toBeLessThan(400);
    expect(Math.abs(cleaned[313].value - delta[313].value)).toBeLessThan(0.5);
    expect(Math.abs(cleaned[938].value - delta[938].value)).toBeLessThan(0.5);
  });

  test('rejects a simultaneous multi-channel blink even when the selected raw channel is less steep', () => {
    const slow = Array.from({ length: 700 }, (_, index) => ({
      timestamp: index * 10,
      value: Math.sin(2 * Math.PI * index / 100) * 30
    }));
    const delta = slow.map((point, index) => ({ ...point, value: point.value + (index === 350 ? 700 : 0) }));
    const channelWithBlink = (gain: number) => slow.map((point, index) => ({
      ...point,
      value: point.value + (index >= 348 && index <= 352 ? gain : 0)
    }));

    const cleaned = cleanSleepDeltaWave(delta, slow, 100, {
      eegChannels: [slow, channelWithBlink(4_000), channelWithBlink(5_000), slow]
    });

    expect(Math.abs(cleaned[350].value)).toBeLessThan(100);
    expect(Math.abs(cleaned[150].value - delta[150].value)).toBeLessThan(0.5);
  });

  test('uses accelerometer jerk to remove movement-related low-frequency contamination', () => {
    const slow = Array.from({ length: 700 }, (_, index) => ({
      timestamp: index * 10,
      value: Math.sin(2 * Math.PI * index / 100) * 25
    }));
    const delta = slow.map((point, index) => ({ ...point, value: point.value + (index === 400 ? 600 : 0) }));
    const acc = (axis: 'x' | 'y' | 'z') => slow.map((point, index) => ({
      timestamp: point.timestamp,
      value: index >= 399 && index <= 402 ? (axis === 'x' ? 8_000 : 3_000) : 100
    }));

    const cleaned = cleanSleepDeltaWave(delta, slow, 100, {
      accelerometer: { x: acc('x'), y: acc('y'), z: acc('z') }
    });

    expect(Math.abs(cleaned[400].value)).toBeLessThan(100);
  });
});
