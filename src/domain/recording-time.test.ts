import { describe, expect, test } from 'vitest';
import { formatRecordingDuration } from './recording-time';

describe('recording duration display', () => {
  test('formats elapsed seconds as HH:MM:SS', () => {
    expect(formatRecordingDuration(0)).toBe('00:00:00');
    expect(formatRecordingDuration(3_723)).toBe('01:02:03');
    expect(formatRecordingDuration(-2)).toBe('00:00:00');
  });
});
