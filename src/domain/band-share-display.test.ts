import { describe, expect, test } from 'vitest';
import { formatBandSharePercent } from './band-share-display';

describe('band share display', () => {
  test('keeps a strongly attenuated but non-zero Delta share visible', () => {
    expect(formatBandSharePercent('Delta', 0.23)).toBe('0.2%');
    expect(formatBandSharePercent('Delta', 0.02)).toBe('<0.1%');
    expect(formatBandSharePercent('Delta', 0)).toBe('0%');
  });

  test('keeps the existing integer presentation for other bands', () => {
    expect(formatBandSharePercent('Alpha', 18.4)).toBe('18%');
  });
});
