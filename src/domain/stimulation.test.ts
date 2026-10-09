import { describe, expect, test } from 'vitest';
import { defaultStimulusConfig, stimulusStartReason } from './stimulation';
const ready = { connected: true, recording: true, acquisitionMode: true, demoMode: false };
describe('stimulus prerequisites', () => {
  test('requires original waveform rather than silently substituting a chirp', () => {
    expect(stimulusStartReason(defaultStimulusConfig, ready)).toContain('WAV');
    expect(stimulusStartReason({ ...defaultStimulusConfig, wavPath: '/test.wav' }, ready)).toBeNull();
  });
  test('rejects demo, unrecorded and sleep-control sessions', () => {
    const c = { ...defaultStimulusConfig, wavPath: '/test.wav' };
    expect(stimulusStartReason(c, { ...ready, demoMode: true })).toContain('演示');
    expect(stimulusStartReason(c, { ...ready, recording: false })).toContain('记录');
    expect(stimulusStartReason(c, { ...ready, acquisitionMode: false })).toContain('采集');
    expect(stimulusStartReason(c, { ...ready, connected: false })).toContain('头带');
  });
  test('serial trigger is optional and port selection is explicit', () => {
    const c = { ...defaultStimulusConfig, source: 'test-tone' as const };
    expect(stimulusStartReason(c, ready)).toBeNull();
    expect(stimulusStartReason({ ...c, serialEnabled: true }, ready)).toContain('串口');
  });
});
