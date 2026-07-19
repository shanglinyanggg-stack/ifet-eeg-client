import { describe, expect, test, beforeEach } from 'vitest';
import { defaultSettings, displayDelayOptions, eegScaleOptions, eegTimeWindowOptions, loadSettings, saveSettings, themeOptions } from './settings';

describe('settings persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('uses EEG auto defaults', () => {
    expect(defaultSettings.displayMode).toBe('normal');
    expect(defaultSettings.theme).toBe('neuro-dark');
    expect(defaultSettings.eeg.selectedChannel).toBe('eeg1');
    expect(defaultSettings.eeg.scale).toBe('auto');
    expect(defaultSettings.eeg.timeWindowSeconds).toBe('auto');
    expect(defaultSettings.eeg.bandpassEnabled).toBe(false);
    expect(defaultSettings.sleepMusic.autoMode).toBe(true);
    expect(defaultSettings.sleepMusic.alphaVolumeControlEnabled).toBe(true);
    expect(defaultSettings.sleepMusic.sleepStopEnabled).toBe(true);
    expect(defaultSettings.sleepMusic.maximumVolume).toBe(0.8);
    expect(defaultSettings.displayDelayMs).toBe(0);
    expect(defaultSettings.sleepMusic.serviceEndpoint).toBe('http://127.0.0.1:8772');
    expect(defaultSettings.sleepMusic.drowsinessMode).toBe('wearable-trial');
    expect(defaultSettings.sleepMusic.libraryTracks).toHaveLength(5);
    expect(defaultSettings.sleepMusic.tracks).toHaveLength(0);
  });

  test('offers four dashboard themes', () => {
    expect(themeOptions.map((theme) => theme.value)).toEqual([
      'neuro-dark',
      'clinical-light',
      'graphite',
      'amber-lab',
      'aurora-violet',
      'porcelain'
    ]);
  });

  test('offers preset EEG scale and time window choices with auto defaults', () => {
    expect(eegScaleOptions[0]).toEqual({ value: 'auto', label: 'auto' });
    expect(eegScaleOptions.map((option) => option.value)).toContain('100');
    expect(eegTimeWindowOptions[0]).toEqual({ value: 'auto', label: 'auto' });
    expect(eegTimeWindowOptions.map((option) => option.value)).toContain('10');
    expect(displayDelayOptions[0]).toEqual({ value: '0', label: '实时' });
    expect(displayDelayOptions.map((option) => option.value)).toContain('1000');
  });

  test('round-trips settings through localStorage', () => {
    saveSettings({
      ...defaultSettings,
      displayMode: 'eeg',
      theme: 'clinical-light',
      autoReconnect: true,
      eeg: {
        ...defaultSettings.eeg,
        selectedChannel: 'eeg3',
        scale: 120,
        timeWindowSeconds: 8
      },
      sleepMusic: {
        ...defaultSettings.sleepMusic,
        tracks: [
          { id: 'track-1', name: 'Sleep One', path: 'C:\\Music\\sleep-one.mp3' }
        ],
        selectedTrackId: 'track-1',
        baseVolume: 0.5
      }
    });

    const loaded = loadSettings();

    expect(loaded.displayMode).toBe('eeg');
    expect(loaded.theme).toBe('clinical-light');
    expect(loaded.autoReconnect).toBe(true);
    expect(loaded.eeg.selectedChannel).toBe('eeg3');
    expect(loaded.eeg.scale).toBe(120);
    expect(loaded.eeg.timeWindowSeconds).toBe(8);
    expect(loaded.sleepMusic.selectedTrackId).toBe('track-1');
    expect(loaded.sleepMusic.tracks).toHaveLength(1);
    expect(loaded.sleepMusic.baseVolume).toBe(0.5);
  });

  test('merges older saved settings with new sleep defaults', () => {
    localStorage.setItem('ifet-eeg-client-settings', JSON.stringify({
      eeg: {
        bandRanges: { delta: { low: 0.5, high: 4 } },
        pure: { bandRanges: { delta: { low: 0.5, high: 4 } } }
      },
      sleepMusic: {
        enabled: false,
        serviceEndpoint: 'http://127.0.0.1:8771',
        tracks: Array.from({ length: 5 }, (_, index) => ({
          id: `track-${index}`,
          name: `Track ${index}`,
          path: `C:\\Music\\track-${index}.mp3`
        }))
      }
    }));

    const loaded = loadSettings();

    expect(loaded.sleepMusic.enabled).toBe(false);
    expect(loaded.sleepMusic.autoMode).toBe(true);
    expect(loaded.sleepMusic.minimumCoverage).toBe(0.6);
    expect(loaded.sleepMusic.tracks).toHaveLength(5);
    expect(loaded.sleepMusic.libraryTracks).toHaveLength(10);
    expect(loaded.sleepMusic.libraryTracks.some((track) => track.id === 'builtin-star-alpha')).toBe(true);
    expect(loaded.eeg.bandRanges.delta).toEqual({ low: 0.5, high: 2 });
    expect(loaded.eeg.pure.bandRanges.delta).toEqual({ low: 0.5, high: 2 });
    expect(loaded.sleepMusic.serviceEndpoint).toBe('http://127.0.0.1:8772');
  });
});
