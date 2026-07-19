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
});
