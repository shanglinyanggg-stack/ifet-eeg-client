import { describe, expect, test } from 'vitest';
import { formatReferenceStrength, summarizeAlgorithmAction, translateAlgorithmState } from './sleep-demo-signal';

describe('sleep demo display helpers', () => {
  test('formats baseline strength and prioritizes the applied volume action in Chinese', () => {
    expect(formatReferenceStrength(0.2)).toBe('0.200');
    expect(formatReferenceStrength(2.8, ' z')).toBe('2.800 z');
    expect(summarizeAlgorithmAction(['BLINK_5', 'VOLUME_UP_5_BLINKS'])).toBe('5 次眨眼：提高音量');
    expect(translateAlgorithmState('ALPHA_PRESENT')).toBe('检测到 Alpha');
  });
});
