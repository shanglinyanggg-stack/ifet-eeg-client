import { describe, expect, test } from 'vitest';
import { cleanSleepDeltaWave } from './delta-artifact-filter';

describe('cleanSleepDeltaWave', () => {
  test('preserves a continuous sleep slow wave', () => {
    const delta = Array.from({ length: 600 }, (_, index) => ({
      timestamp: index * 10,
      value: Math.sin(2 * Math.PI * 1.2 * index / 100) * 40
    }));
    const cleaned = cleanSleepDeltaWave(delta, delta);
    const error = cleaned.reduce((sum, point, index) => sum + Math.abs(point.value - delta[index].value), 0) / delta.length;
    expect(error).toBeLessThan(0.5);
  });

  test('bridges a steep blink-like transient without flattening the surrounding slow wave', () => {
    const delta = Array.from({ length: 600 }, (_, index) => ({
      timestamp: index * 10,
      value: Math.sin(2 * Math.PI * index / 100) * 35 + (index === 300 ? 900 : 0)
    }));
    const raw = delta.map((point, index) => ({
      ...point,
      value: Math.sin(2 * Math.PI * index / 100) * 35 + (index >= 299 && index <= 302 ? 4_000 : 0)
    }));
    const cleaned = cleanSleepDeltaWave(delta, raw);

    expect(Math.abs(cleaned[300].value)).toBeLessThan(100);
    expect(Math.abs(cleaned[180].value - delta[180].value)).toBeLessThan(0.5);
    expect(Math.abs(cleaned[420].value - delta[420].value)).toBeLessThan(0.5);
  });

  test('adapts to a blink burst while preserving a high-amplitude smooth N3 candidate', () => {
    const delta = Array.from({ length: 900 }, (_, index) => ({
      timestamp: index * 10,
      value: Math.sin(2 * Math.PI * 0.8 * index / 100) * 180
        + (index >= 448 && index <= 454 ? 1_600 : 0)
    }));
    const raw = delta.map((point, index) => ({
      ...point,
      value: Math.sin(2 * Math.PI * 0.8 * index / 100) * 180
        + (index >= 447 && index <= 455 ? 8_000 : 0)
    }));

    const cleaned = cleanSleepDeltaWave(delta, raw);

    expect(Math.abs(cleaned[451].value)).toBeLessThan(400);
    expect(Math.abs(cleaned[250].value - delta[250].value)).toBeLessThan(0.5);
    expect(Math.abs(cleaned[750].value - delta[750].value)).toBeLessThan(0.5);
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
