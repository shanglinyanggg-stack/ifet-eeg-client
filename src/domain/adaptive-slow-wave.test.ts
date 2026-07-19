import { describe, expect, test } from 'vitest';
import { AdaptiveSlowWaveGate, applySlowWaveGate } from './adaptive-slow-wave';

function wave(amplitude: number, endTimestamp: number) {
  return Array.from({ length: 500 }, (_, index) => ({
    timestamp: endTimestamp - (499 - index) * 10,
    value: Math.sin(2 * Math.PI * index / 100) * amplitude
  }));
}

describe('AdaptiveSlowWaveGate', () => {
  test('learns awake drift without flattening the Delta waveform to zero', () => {
    const gate = new AdaptiveSlowWaveGate();
    const snapshot = gate.update(wave(400, 5_000), { stage: 'W 清醒', streamKey: 'eeg1' });
    const displayedPeak = Math.max(...applySlowWaveGate(wave(400, 5_000), snapshot.weight).map((p) => Math.abs(p.value)));

    expect(snapshot.awakeBaseline).not.toBeNull();
    expect(snapshot.weight).toBeGreaterThan(0);
    expect(snapshot.weight).toBeLessThanOrEqual(0.05);
    expect(displayedPeak).toBeGreaterThan(0);
    expect(displayedPeak).toBeLessThanOrEqual(20);
  });

  test('freezes the awake baseline and passes a sustained NREM slow-wave increase', () => {
    const gate = new AdaptiveSlowWaveGate();
    gate.update(wave(100, 5_000), { stage: 'W 清醒', streamKey: 'eeg1' });
    const snapshot = gate.update(wave(220, 10_000), { stage: 'NREM', streamKey: 'eeg1' });

    expect(snapshot.weight).toBeGreaterThan(0.8);
    expect(snapshot.awakeBaseline).toBeLessThan(120);
  });

  test('does not mistake an awake amplitude jump for N3 evidence', () => {
    const gate = new AdaptiveSlowWaveGate();
    gate.update(wave(100, 5_000), { stage: '分期预热', streamKey: 'eeg1' });
    const snapshot = gate.update(wave(260, 10_000), { stage: 'W 清醒', streamKey: 'eeg1' });

    expect(snapshot.weight).toBeLessThanOrEqual(0.05);
  });

  test('releases excess slow-wave weight gradually and never jumps to zero', () => {
    const gate = new AdaptiveSlowWaveGate();
    gate.update(wave(100, 5_000), { stage: 'W 清醒', streamKey: 'eeg1' });
    const high = gate.update(wave(220, 10_000), { stage: 'NREM', streamKey: 'eeg1' });
    const falling = gate.update(wave(100, 15_000), { stage: 'NREM', streamKey: 'eeg1' });

    expect(high.weight).toBeGreaterThan(0.8);
    expect(falling.weight).toBeGreaterThan(0.02);
    expect(falling.weight).toBeLessThan(high.weight);
  });
});
